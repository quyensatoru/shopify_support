import { z } from 'zod';
import { getStructuredLlm } from '../llm/index.js';
import type { Hypothesis, Identifier, Probe, ProbeResult } from '@shopify-support/shared';
import { randomUUID } from 'node:crypto';
import { logger } from '../observability/logger.js';
import * as fs from 'fs'

/** An id value resolved from a previous DB probe (e.g. shop_id obtained by looking
 *  up the shop collection by domain), used to build the next, dependent query. */
export type ResolvedId = { field: string; value: string; source?: string };

/** One data source as discovered by a `discover`/`read_schema` probe. */
type DiscoveredSource = {
    sourceKey: string;
    sourceType: 'sql' | 'mongo' | 'redis' | 'rabbitmq';
    entities: Array<{
        name: string;
        kind: string;
        columns?: Array<{ name: string; type: string }>;
        approxCount?: number;
    }>;
};

const DbQueryOutputSchema = z.object({
    probes: z.array(
        z.object({
            sourceKey: z.string().describe('Which dbSource.key to query — must match a discovered source'),
            action: z.enum([
                'check_record_exists',
                'count_check',
                'key_inspect',
                'queue_inspect',
                'peek_messages',
            ]),
            // For sql: table + query(=WHERE clause). For mongo: collection + query(=JSON filter).
            // For redis: key or pattern. For rabbitmq: queue.
            table: z.string().optional(),
            collection: z.string().optional(),
            query: z
                .union([z.string(), z.record(z.string(), z.unknown())])
                .optional()
                .describe(
                    'SQL: a WHERE clause STRING referencing REAL columns, e.g. "shop_domain = \'x.myshopify.com\'". Mongo: a JSON filter OBJECT (not a stringified string), e.g. {"shopId":"123"}. Read-only only — no INSERT/UPDATE/DELETE, no ";".',
                ),
            key: z.string().optional(),
            pattern: z.string().optional(),
            queue: z.string().optional(),
            n: z.number().optional(),
            hint: z.string(),
            hypothesisRanks: z.array(z.number()).default([]),
        }),
    ),
    rationale: z.string(),
});

export async function runDbQueryReasoning(input: {
    app: string;
    issueText: string;
    identifiers: Identifier[];
    storeDomain?: string;
    hypotheses: Hypothesis[];
    discovered: DiscoveredSource[];
    /** Ids resolved from earlier DB probes (e.g. shop_id from a domain lookup). */
    resolvedIds?: ResolvedId[];
    /** Gaps from the current (tentative) analysis to steer follow-up queries. */
    focus?: string;
}): Promise<Probe[]> {
    if (!input.discovered.length) return [];

    const structured = getStructuredLlm(DbQueryOutputSchema, 'db_query_output');

    const rankToId = new Map<number, string>();
    input.hypotheses.forEach((h) => rankToId.set(h.rank, h.id));

    const identifierSummary = [
        ...input.identifiers.map((id) => `${id.kind}=${id.value}`),
        ...(input.storeDomain ? [`store_domain=${input.storeDomain}`] : []),
    ].join(', ');

    const resolvedSummary = (input.resolvedIds ?? [])
        .map((r) => `${r.field}=${r.value}${r.source ? ` (from ${r.source})` : ''}`)
        .join(', ');

    const schemaSummary = summarizeDiscoveredSchema(input.discovered);

    const hypothesisList = input.hypotheses
        .map((h) => `  rank ${h.rank}: ${h.statement}`)
        .join('\n');

    const prompt = `You are a Shopify embedded app support engineer. The data sources have been introspected. Synthesize READ-ONLY queries to test the hypotheses.
LANGUAGE RULE: write the "hint" and "rationale" fields in the SAME language as the Issue text. Do not translate identifiers, table/collection names, or query syntax.

App: ${input.app}
Issue: ${input.issueText}
Known identifiers: ${identifierSummary || '(none provided)'}
${resolvedSummary ? `Resolved ids from earlier probes (use these to build dependent queries): ${resolvedSummary}` : ''}

Discovered schema (these are the ONLY tables/collections/keyspaces/queues that exist):
${schemaSummary}

Hypotheses:
${hypothesisList || '(none)'}
${input.focus ? `\nThe analysis so far is inconclusive — focus the queries on closing these gaps:\n${input.focus}\n` : ''}
MULTI-STEP LOOKUP: if a data table you need is keyed by an id you do NOT have yet
(e.g. you only have store_domain but the heatmap/session table is keyed by shop_id),
FIRST emit a "lookup" query against the table that maps domain→id (e.g. the shops
collection: find by domain, returning its _id/shop_id). The resolved id will be fed
back and you can issue the dependent data query on the next pass. Only emit the data
query directly when the required id is already in "Known identifiers" or "Resolved ids".

Instructions:
1. Pick the entities most relevant to the hypotheses. Do NOT reference tables/collections/columns that are not in the discovered schema above.
2. For SQL sources: emit "check_record_exists" or "count_check" with table + query, where query is a WHERE clause using REAL column names. Build the filter from the known identifiers (map shop_id/store_domain to the matching column). If no identifier matches a column, prefer a bounded "count_check" with query "true" to gauge table population instead of guessing.
3. For Mongo sources: emit "check_record_exists"/"count_check" with collection + query as a JSON filter object using REAL field names.
4. For Redis sources: emit "key_inspect" with a key or pattern built from the keyspace + identifiers.
5. For RabbitMQ sources: emit "queue_inspect" (metadata) or "peek_messages" (n<=5) for the relevant queue.
6. READ-ONLY ONLY: never write INSERT/UPDATE/DELETE/DROP, never use ";" or SQL comments, never use Mongo $where/$function.
7. Keep it focused: at most 6 probes. Each probe must state in "hint" which hypothesis it tests and what a hit/miss would mean.

If the schema gives nothing useful for any hypothesis, return an empty probes array.`;

    const result = await structured.invoke(prompt);
    if (!result) throw new Error('db_query_output: LLM returned null/undefined');
    logger.info({ probes: result.probes.length }, 'db_query reasoning produced probes');
    fs.writeFileSync("db_query.txt", JSON.stringify(result, null, 2), 'utf8')
    return result.probes.map((p) => {
        const target: Record<string, unknown> = { source: p.sourceKey };
        if (p.table) target['table'] = p.table;
        if (p.collection) target['collection'] = p.collection;
        if (p.query != null && p.query !== '') {
            // SQL gets the WHERE string as-is; Mongo gets the object stringified
            // (the adapter JSON.parses it) — the model never hand-escapes JSON-in-JSON.
            target['query'] = typeof p.query === 'string' ? p.query : JSON.stringify(p.query);
        }
        if (p.key) target['key'] = p.key;
        if (p.pattern) target['pattern'] = p.pattern;
        if (p.queue) target['queue'] = p.queue;
        if (p.n != null) target['n'] = String(p.n);
        return {
            id: randomUUID(),
            surface: 'database' as const,
            action: p.action,
            target,
            hint: p.hint,
            hypothesisIds: p.hypothesisRanks
                .map((r) => rankToId.get(r) ?? '')
                .filter(Boolean),
            status: 'pending' as const,
        };
    });
}

/** Render discovered sources as a compact, grounded schema summary for prompts. */
export function summarizeDiscoveredSchema(discovered: DiscoveredSource[]): string {
    return discovered
        .map((src) => {
            const entities = src.entities
                .slice(0, 40)
                .map((e) => {
                    const cols = (e.columns ?? []).map((c) => `${c.name}:${c.type}`).join(', ');
                    const count = e.approxCount != null ? ` (~${e.approxCount} rows)` : '';
                    return `  - ${e.kind} "${e.name}"${count}${cols ? ` [${cols}]` : ''}`;
                })
                .join('\n');
            return `Source "${src.sourceKey}" (${src.sourceType}):\n${entities}`;
        })
        .join('\n\n');
}

const ID_FIELD_RE = /^(_id|id|shop_?id|shopify_?id|store_?id|session_?id|recording_?id|page_?id|user_?id)$/i;

/** Scan DB probe sample rows for id-like fields → resolvedIds for dependent queries. */
export function extractResolvedIds(probeResults: ProbeResult[]): ResolvedId[] {
    const out: ResolvedId[] = [];
    const seen = new Set<string>();
    for (const r of probeResults) {
        if (r.surface !== 'database' || r.status !== 'done' || !r.found) continue;
        const data = r.data as { sample?: unknown[] } | unknown[] | null;
        const rows = Array.isArray(data) ? data : Array.isArray(data?.sample) ? data!.sample : [];
        for (const row of rows.slice(0, 3)) {
            if (!row || typeof row !== 'object') continue;
            for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
                if (!ID_FIELD_RE.test(k)) continue;
                const value =
                    typeof v === 'string' || typeof v === 'number'
                        ? String(v)
                        : // Mongo ObjectId / BSON: stringify best-effort
                          v && typeof (v as { toString?: () => string }).toString === 'function'
                          ? String(v)
                          : '';
                if (!value || value === '[object Object]') continue;
                const key = `${k}=${value}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ field: k, value, source: r.provenance });
            }
        }
    }
    return out;
}

/** Extract discovered sources from `discover` probe results in the diagnosis log. */
export function collectDiscoveredSources(probeResults: ProbeResult[]): DiscoveredSource[] {
    const out: DiscoveredSource[] = [];
    for (const r of probeResults) {
        if (r.surface !== 'database' || r.action !== 'discover' || r.status !== 'done') continue;
        const data = r.data as DiscoveredSource | null;
        if (data?.entities) out.push(data);
    }
    return out;
}
