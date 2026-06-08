import { z } from 'zod';
import { getStructuredLlm } from '../llm/index.js';
import type {
    ResolvedAppConfig,
    CaseMemory,
    CodeContext,
    AppKnowledgeChunk,
    Hypothesis,
    NormalizedIssue,
    Plan,
    Probe,
    Identifier,
} from '@shopify-support/shared';
import { randomUUID } from 'node:crypto';
import { logger } from '../observability/logger.js';
import * as fs from 'fs'

const PlanOutputSchema = z.object({
    caseType: z.enum([
        'installation_oauth',
        'embedded_admin_ui',
        'storefront_extension',
        'webhook_sync',
        'api_permission',
        'billing',
        'data_integrity',
        'performance',
        'configuration',
        'frontend_bug',
        'unknown',
    ]),
    severity: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    restatement: z.string().describe('Clear restatement of the issue in technical terms'),
    identifiers: z.array(z.object({ kind: z.string(), value: z.string() })).default([]),
    hypotheses: z
        .array(
            z.object({
                rank: z.number().int(),
                statement: z.string(),
                whyPlausible: z.string(),
                confirmSignals: z.array(z.string()).min(1),
                rejectSignals: z.array(z.string()).min(1),
                confidence: z.enum(['low', 'medium', 'high']),
                suggestedSurfaces: z.array(z.string()),
            }),
        )
        .min(1)
        .max(5),
    probes: z.array(
        z.object({
            surface: z.enum(['code', 'database', 'logs', 'shopify', 'browser', 'config']),
            action: z.string(),
            target: z.record(z.string(), z.unknown()),
            hint: z.string(),
            hypothesisRanks: z.array(z.number()),
        }),
    ),
    missingContext: z.array(z.string()).default([]),
    rationale: z.string(),
});

type PlanInput = {
    app: string;
    issueText: string;
    storeDomain?: string;
    storeUrl?: string;
    identifiers?: Identifier[];
    appConfig?: ResolvedAppConfig;
    retrievedMemories?: CaseMemory[];
    codeContexts?: CodeContext[];
    appKnowledge?: AppKnowledgeChunk[];
};

export async function runPlanReasoning(input: PlanInput): Promise<{
    normalized: NormalizedIssue;
    hypotheses: Hypothesis[];
    plan: Plan;
    missingContext: string[];
}> {
    const structured = getStructuredLlm(PlanOutputSchema, 'plan_output');

    const memorySummary = (input.retrievedMemories ?? [])
        .slice(0, 3)
        .map((m, i) => `[Memory ${i + 1}] caseType=${m.caseType}: ${m.reusableInsight}`)
        .join('\n');

    const configSummary = input.appConfig
        ? `Repos: ${input.appConfig.repos.map((r) => r.name).join(', ') || 'none'} | DB sources: ${input.appConfig.dbSources.map((d) => `${d.key}(${d.type})`).join(', ') || 'none'} | Shopify: ${input.appConfig.shopify ? 'configured' : 'not configured'}`
        : 'App config: not available';

    // Build code context section (grounded facts — no hallucination allowed)
    const codeContextSummary = (input.codeContexts ?? [])
        .map((ctx) => {
            const symbols = ctx.relevantSymbols
                .slice(0, 15)
                .map((s) => `  ${s.kind} ${s.name} @ ${s.file}${s.line ? `:${s.line}` : ''}`)
                .join('\n');
            const markers = ctx.expectedMarkers.length
                ? `Expected browser markers: ${ctx.expectedMarkers.join(', ')}`
                : '';
            return [
                `--- Repo: ${ctx.repo}${ctx.framework ? ` (${ctx.framework})` : ''} ---`,
                ctx.contextMarkdown.slice(0, 2000),
                symbols ? `Relevant symbols:\n${symbols}` : '',
                markers,
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n\n');

    const appKnowledgeSummary = (input.appKnowledge ?? [])
        .slice(0, 5)
        .map((k) => `[${k.source}] ${k.title}: ${k.chunk.slice(0, 300)}`)
        .join('\n');

    const prompt = `You are a Shopify embedded app support engineer. Analyze this issue and produce a structured investigation plan.
LANGUAGE RULE: Detect the language of the Issue text and write ALL text output fields in that same language. Do not translate code identifiers, file paths, or technical names.

App: ${input.app}
Issue: ${input.issueText}
${input.storeDomain ? `Store: ${input.storeDomain}` : ''}
${input.storeUrl ? `Store URL: ${input.storeUrl}` : ''}
${input.identifiers?.length ? `Identifiers: ${input.identifiers.map((id) => `${id.kind}=${id.value}`).join(', ')}` : ''}
${configSummary}
${memorySummary ? `\nRelevant past cases:\n${memorySummary}` : ''}
${codeContextSummary ? `\n=== CODEBASE CONTEXT (grounded facts from code index) ===\n${codeContextSummary}\n===` : ''}
${appKnowledgeSummary ? `\n=== APP KNOWLEDGE ===\n${appKnowledgeSummary}\n===` : ''}

Instructions:
1. Classify the caseType (installation_oauth | embedded_admin_ui | storefront_extension | webhook_sync | api_permission | billing | data_integrity | performance | configuration | frontend_bug | unknown).
2. Restate the issue clearly in technical terms.
3. Generate 2-4 concrete, testable hypotheses ranked by likelihood.
4. For each hypothesis: state what would CONFIRM it (observable signals) and what would REJECT it.
5. Generate specific probes (investigation actions) targeting the most likely surfaces.
   - surface options: code | database | logs | shopify | browser | confign
   - Only include probes for surfaces that are configured or have the storeDomain/URL available.
   - Probe target should be specific (e.g., for code: glob="**/*.ts", regex="sessionToken|appBridge"; for database: collection="shops", query="shop_domain = ?").
6. List any missing context that would improve the investigation (e.g., "need store URL to run browser probe").

Prioritize: minimize LLM usage downstream — make probes as specific as possible so deterministic code can run them without needing further reasoning.

GUARDRAIL — probe targets must reference REAL facts from the codebase context above:
- For code probes: use symbol names, file paths, or regex that appear in the "CODEBASE CONTEXT" section. If no relevant symbol/file is listed, put the gap in missingContext instead of guessing.
- For browser probes: use marker values from "Expected browser markers" listed above. If none are listed, put the gap in missingContext.
- For database probes: use collection/table names from the app config. Do NOT invent table names.
- If the codebase context is empty (no repos indexed), you may use informed guesses but must lower hypothesis confidence to 'low'.

IMPORTANT: ALL text output fields must be in the same language as the Issue. Do not translate code symbols, file paths, or API names.`;
    fs.writeFileSync("plan.txt", prompt, 'utf8')
    const result = await structured.invoke(prompt);
    if (!result) throw new Error('plan_output: LLM returned null/undefined');
    logger.info(result);

    const hypothesisIdMap = new Map<number, string>();
    const hypotheses: Hypothesis[] = result.hypotheses.map((h, idx) => {
        const id = randomUUID();
        hypothesisIdMap.set(h.rank ?? idx + 1, id);
        return {
            id,
            rank: h.rank ?? idx + 1,
            statement: h.statement,
            whyPlausible: h.whyPlausible,
            confirmSignals: h.confirmSignals,
            rejectSignals: h.rejectSignals,
            confidence: h.confidence,
            suggestedSurfaces: (h.suggestedSurfaces ?? []) as Array<
                'code' | 'database' | 'logs' | 'shopify' | 'browser' | 'config'
            >,
        };
    });

    const probes: Probe[] = result.probes.map((p) => ({
        id: randomUUID(),
        surface: p.surface,
        action: p.action,
        target: p.target,
        hint: p.hint,
        hypothesisIds: p.hypothesisRanks.map((r) => hypothesisIdMap.get(r) ?? '').filter(Boolean),
        status: 'pending' as const,
    }));

    return {
        normalized: {
            caseType: result.caseType,
            restatement: result.restatement,
            identifiers: result.identifiers as Identifier[],
            severity: result.severity ?? 'normal',
        },
        hypotheses,
        plan: { probes, rationale: result.rationale },
        missingContext: result.missingContext ?? [],
    };
}

// ── Replan: add new probes based on gaps ──────────────────────────────
const ReplanOutputSchema = z.object({
    newProbes: z.array(
        z.object({
            surface: z.enum(['code', 'database', 'logs', 'shopify', 'browser', 'config']),
            action: z.string(),
            target: z.record(z.string(), z.unknown()),
            hint: z.string(),
            hypothesisIds: z.array(z.string()),
        }),
    ),
});

export async function runReplanReasoning(input: {
    app: string;
    issueText: string;
    existingPlan?: Plan;
    evidence: unknown[];
    synthesis?: unknown;
    appConfig?: ResolvedAppConfig;
}): Promise<Probe[]> {
    const structured = getStructuredLlm(ReplanOutputSchema, 'replan_output');

    const prompt = `You are a Shopify embedded app support engineer. The initial investigation has low confidence.

App: ${input.app}
Issue: ${input.issueText}
Evidence so far: ${JSON.stringify(input.evidence).slice(0, 2000)}
Current synthesis: ${JSON.stringify(input.synthesis).slice(0, 1000)}

Generate NEW investigation probes to fill the gaps. Do not repeat probes already run. Focus on surfaces not yet covered or deeper queries on surfaces that returned partial data.

IMPORTANT: All text fields must be written in the SAME language as the "Issue" text above.`;

    const result = await structured.invoke(prompt);
    if (!result) throw new Error('fix_probes_output: LLM returned null/undefined');

    return result.newProbes.map((p) => ({
        id: randomUUID(),
        surface: p.surface,
        action: p.action,
        target: p.target,
        hint: p.hint,
        hypothesisIds: p.hypothesisIds,
        status: 'pending' as const,
    }));
}
