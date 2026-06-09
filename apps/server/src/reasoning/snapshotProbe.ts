import { z } from 'zod';
import { getStructuredLlmFast } from '../llm/index.js';
import type { Hypothesis, Probe, ProbeResult } from '@shopify-support/shared';
import type { ResolvedId } from './dbQuery.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../observability/logger.js';

/**
 * Synthesize a `build_snapshot` probe AFTER discovery + a recording id has been
 * resolved. build_snapshot needs real collection/field names + a recordingId, so
 * it can only be planned once the schema is known and a recording id is in hand
 * (typically resolved via domain→shop_id→recordings lookups by the DB step).
 */
const SnapshotProbeOutputSchema = z.object({
    probes: z
        .array(
            z.object({
                sourceKey: z.string(),
                collection: z.string().optional(),
                table: z.string().optional(),
                idField: z.string().describe('column/field that holds the recording id'),
                snapshotField: z.string().describe('column/field that holds the compressed blob'),
                recordingId: z.string(),
                hint: z.string(),
            }),
        )
        .default([]),
});

type DiscoveredSourceLite = {
    sourceKey: string;
    sourceType: string;
    entities: Array<{ name: string; kind: string; columns?: Array<{ name: string; type: string }> }>;
};

export async function runSnapshotProbeReasoning(input: {
    issueText: string;
    discovered: DiscoveredSourceLite[];
    resolvedIds: ResolvedId[];
    hypotheses: Hypothesis[];
    pipelineHint?: unknown;
}): Promise<Probe[]> {
    if (!input.discovered.length || !input.resolvedIds.length) return [];

    const schema = input.discovered
        .map((s) => {
            const ents = s.entities
                .slice(0, 30)
                .map(
                    (e) =>
                        `  - ${e.kind} "${e.name}" [${(e.columns ?? []).map((c) => c.name).join(', ')}]`,
                )
                .join('\n');
            return `Source "${s.sourceKey}" (${s.sourceType}):\n${ents}`;
        })
        .join('\n\n');

    const ids = input.resolvedIds.map((r) => `${r.field}=${r.value}`).join(', ');

    try {
        const structured = getStructuredLlmFast(SnapshotProbeOutputSchema, 'snapshot_probe');
        const prompt = `A session-recording / heatmap issue needs the recorded snapshot rebuilt to find where it breaks.

Issue: ${input.issueText}
Resolved ids: ${ids}
${input.pipelineHint ? `Render/compression pipeline (from code): ${JSON.stringify(input.pipelineHint).slice(0, 600)}` : ''}

Discovered schema (use REAL collection/field names only):
${schema}

Pick the collection/table that stores the compressed recording/snapshot blob. Identify:
- recordingId: a value from "Resolved ids" that identifies the recording/session/page to rebuild.
- idField: the column/field that recordingId matches.
- snapshotField: the column/field holding the compressed snapshot blob.
Only emit a probe if you can ground ALL of these in the schema + resolved ids. Otherwise return an empty array.`;
        const result = await structured.invoke(prompt);
        if (!result?.probes?.length) return [];

        const hypothesisIds = input.hypotheses.map((h) => h.id);
        return result.probes.map((p) => {
            const target: Record<string, unknown> = {
                source: p.sourceKey,
                idField: p.idField,
                snapshotField: p.snapshotField,
                recordingId: p.recordingId,
            };
            if (p.collection) target['collection'] = p.collection;
            if (p.table) target['table'] = p.table;
            return {
                id: randomUUID(),
                surface: 'snapshot' as const,
                action: 'build_snapshot',
                target,
                hint: p.hint,
                hypothesisIds,
                status: 'pending' as const,
            };
        });
    } catch (err) {
        logger.warn({ err }, 'snapshot probe reasoning failed');
        return [];
    }
}

/** Did the issue/keywords indicate a session-recording / heatmap / replay case? */
export function isRecordingCase(issueText: string, keywords: string[], caseType?: string): boolean {
    const hay = `${issueText} ${keywords.join(' ')} ${caseType ?? ''}`.toLowerCase();
    return /heatmap|recording|record|replay|rrweb|snapshot|session|canvas/.test(hay);
}

/** Pull the inspect_pipeline result (if any) from probe results for grounding. */
export function findPipelineHint(probeResults: ProbeResult[]): unknown {
    const r = probeResults.find(
        (p) => p.surface === 'snapshot' && p.action === 'inspect_pipeline' && p.status === 'done',
    );
    return r?.data ?? undefined;
}
