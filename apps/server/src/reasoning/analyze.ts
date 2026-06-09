import { z } from 'zod';
import { getStructuredLlm } from '../llm/index.js';
import type { Hypothesis, Evidence, Synthesis, CodeContext } from '@shopify-support/shared';
import * as fs from 'fs'

const AnalyzeOutputSchema = z.object({
    verdicts: z
        .array(
            z.object({
                hypothesisId: z.string(),
                status: z.enum(['confirmed', 'rejected', 'inconclusive']),
                rationale: z.string().min(1),
                evidenceRefs: z.array(z.string()),
            }),
        )
        .min(1),
    rootCause: z.string().min(1).describe('Specific root cause, grounded in evidence'),
    confidence: z.enum(['low', 'medium', 'high']),
    recommendedFix: z.string().optional(),
    nextSteps: z.array(z.string()).default([]),
});

export async function runAnalyzeReasoning(input: {
    app: string;
    issueText: string;
    caseType: string;
    hypotheses: Hypothesis[];
    evidence: Evidence[];
    missingContext: string[];
    codeContexts?: CodeContext[];
}): Promise<Synthesis> {
    const structured = getStructuredLlm(AnalyzeOutputSchema, 'analyze_output');

    const evidenceSummary = input.evidence
        .map(
            (e) =>
                `[${e.id}] (${e.polarity ?? 'positive'}) surface=${e.surface}: ${e.claim} | value=${JSON.stringify(e.value).slice(0, 200)}`,
        )
        .join('\n');

    const hypothesisList = input.hypotheses
        .map(
            (h) =>
                `[${h.id}] rank=${h.rank}: ${h.statement}\n  CONFIRM: ${h.confirmSignals.join(', ')}\n  REJECT: ${h.rejectSignals.join(', ')}`,
        )
        .join('\n\n');

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

    const prompt = `You are a Shopify embedded app support engineer performing root cause analysis.
LANGUAGE RULE: Detect the language of the Issue text and write ALL text output fields in that same language. Do not translate code identifiers, file paths, or technical names.

App: ${input.app}
Issue: ${input.issueText}
Case type: ${input.caseType}
${codeContextSection ? `\n=== CODEBASE CONTEXT ===\n${codeContextSection}\n===` : ''}

Hypotheses to evaluate:
${hypothesisList}

Evidence collected (deterministic probes):
${evidenceSummary || '(no evidence collected)'}

${input.missingContext.length ? `Missing context: ${input.missingContext.join(', ')}` : ''}

Instructions:
1. For EACH hypothesis, produce a verdict (confirmed | rejected | inconclusive).
   - You MUST cite specific evidenceRefs (evidence IDs from above). Do NOT invent evidence.
   - If no evidence supports or refutes a hypothesis → inconclusive.
   - NEGATIVE evidence (marked "(negative)" — e.g. record not found, queue empty, no recent data) is real, often decisive evidence. Use it to CONFIRM or REJECT hypotheses (e.g. "no heatmap rows for this shop" confirms a data-pipeline gap). Do not treat negative results as "no evidence".
2. State the root cause: be specific, grounded in confirmed evidence only.
   - If confidence must be low (no confirmed hypothesis), say so explicitly.
   - ENV/CONFIG vars are NOT a terminal root cause. If an env var is implicated, the evidence includes "search_code" results showing where it is READ. Trace that read site to the concrete downstream failure (what code path breaks, what throws, what silently misbehaves when the var is absent/wrong) and state THAT as the root cause, citing the code evidence. Do not stop at "env X is missing".
3. Confidence: high = 1+ confirmed hypothesis with strong evidence; medium = partial evidence; low = mostly inconclusive.
4. recommendedFix: only if confidence ≥ medium and a clear fix exists.
5. nextSteps: what the developer should investigate or verify manually.

IMPORTANT: ALL text output fields must be in the same language as the Issue. Do not translate code symbols, file paths, or API names.`;
    fs.writeFileSync("analyize.txt", prompt, 'utf8')
    const result = await structured.invoke(prompt);
    if (!result) throw new Error('analyze_output: LLM returned null/undefined');
    return result as Synthesis;
}
