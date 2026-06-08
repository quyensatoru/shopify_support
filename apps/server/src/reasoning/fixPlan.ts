import { z } from 'zod';
import { getStructuredLlm } from '../llm/index.js';
import type {
    Synthesis,
    Evidence,
    ResolvedAppConfig,
    FixPlan,
    CodeContext,
} from '@shopify-support/shared';

const FixPlanOutputSchema = z.object({
    changes: z
        .array(
            z.object({
                kind: z.enum(['code', 'config', 'data']),
                description: z.string(),
                file: z.string().optional(),
                diff: z.string().optional(),
                configKey: z.string().optional(),
                configValue: z.unknown().optional(),
                dataSource: z.string().optional(),
                dataQuery: z.string().optional(),
            }),
        )
        .min(1),
    verification: z.array(
        z.object({
            surface: z.enum(['code', 'database', 'logs', 'shopify', 'browser', 'config']),
            action: z.string(),
            target: z.record(z.string(), z.string()),
            expectedOutcome: z.string(),
        }),
    ),
    risk: z.enum(['low', 'medium', 'high']),
    summary: z.string(),
});

export async function runFixPlanReasoning(input: {
    app: string;
    issueText: string;
    synthesis: Synthesis;
    evidence: Evidence[];
    appConfig?: ResolvedAppConfig;
    codeContexts?: CodeContext[];
}): Promise<FixPlan> {
    const structured = getStructuredLlm(FixPlanOutputSchema, 'fix_plan_output');

    const repos = input.appConfig?.repos.map((r) => r.name).join(', ') || 'unknown';

    const codeContextSection = (input.codeContexts ?? [])
        .map((ctx) => {
            const symbols = ctx.relevantSymbols
                .slice(0, 10)
                .map((s) => `  ${s.kind} ${s.name} @ ${s.file}${s.line ? `:${s.line}` : ''}`)
                .join('\n');
            return [
                `--- Repo: ${ctx.repo}${ctx.framework ? ` (${ctx.framework})` : ''} ---`,
                ctx.contextMarkdown.slice(0, 1500),
                symbols ? `Relevant symbols:\n${symbols}` : '',
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n\n');

    const prompt = `You are a Shopify embedded app engineer creating a fix plan.
LANGUAGE RULE: Detect the language of the Issue text and write ALL text output fields in that same language. Do not translate code identifiers, file paths, or technical names.

App: ${input.app} | Repos: ${repos}
Issue: ${input.issueText}
Root cause (${input.synthesis.confidence} confidence): ${input.synthesis.rootCause}
Recommended fix: ${input.synthesis.recommendedFix ?? 'none specified'}
${codeContextSection ? `\n=== CODEBASE CONTEXT ===\n${codeContextSection}\n===` : ''}

Evidence:
${input.evidence.map((e) => `- ${e.claim}: ${JSON.stringify(e.value).slice(0, 150)}`).join('\n')}

Produce a concrete fix plan:
- changes: specific file diffs (unified diff format), config changes, or data fixes needed.
  v1 ONLY supports kind=code (GitLab MR). Mark config/data as kind=config/data but these will be shown for manual review.
- verification: probes to run AFTER the fix to confirm it worked (same probe format as diagnosis).
- risk: low (typo/config) | medium (logic change) | high (data migration/schema change).
- summary: one paragraph for the CSE to explain to the merchant.

IMPORTANT: ALL text output fields (description, summary, rationale, verification steps) must be in the same language as the Issue. Do not translate code symbols, file paths, or API names.`;

    const result = await structured.invoke(prompt);
    if (!result) throw new Error('fix_plan_output: LLM returned null/undefined');
    return result as FixPlan;
}
