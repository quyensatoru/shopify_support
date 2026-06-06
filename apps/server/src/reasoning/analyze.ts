import { z } from 'zod';
import { getLlm } from '../llm/index.js';
import type { Hypothesis, Evidence, Synthesis } from '@shopify-support/shared';

const AnalyzeOutputSchema = z.object({
  verdicts: z.array(z.object({
    hypothesisId: z.string(),
    status: z.enum(['confirmed', 'rejected', 'inconclusive']),
    rationale: z.string().min(1),
    evidenceRefs: z.array(z.string()),
  })).min(1),
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
}): Promise<Synthesis> {
  const llm = getLlm();
  const structured = llm.withStructuredOutput(AnalyzeOutputSchema, { name: 'analyze_output' });

  const evidenceSummary = input.evidence
    .map((e) => `[${e.id}] surface=${e.surface}: ${e.claim} | value=${JSON.stringify(e.value).slice(0, 200)}`)
    .join('\n');

  const hypothesisList = input.hypotheses
    .map((h) => `[${h.id}] rank=${h.rank}: ${h.statement}\n  CONFIRM: ${h.confirmSignals.join(', ')}\n  REJECT: ${h.rejectSignals.join(', ')}`)
    .join('\n\n');

  const prompt = `You are a Shopify embedded app support engineer performing root cause analysis.

App: ${input.app}
Issue: ${input.issueText}
Case type: ${input.caseType}

Hypotheses to evaluate:
${hypothesisList}

Evidence collected (deterministic probes):
${evidenceSummary || '(no evidence collected)'}

${input.missingContext.length ? `Missing context: ${input.missingContext.join(', ')}` : ''}

Instructions:
1. For EACH hypothesis, produce a verdict (confirmed | rejected | inconclusive).
   - You MUST cite specific evidenceRefs (evidence IDs from above). Do NOT invent evidence.
   - If no evidence supports or refutes a hypothesis → inconclusive.
2. State the root cause: be specific, grounded in confirmed evidence only.
   - If confidence must be low (no confirmed hypothesis), say so explicitly.
3. Confidence: high = 1+ confirmed hypothesis with strong evidence; medium = partial evidence; low = mostly inconclusive.
4. recommendedFix: only if confidence ≥ medium and a clear fix exists.
5. nextSteps: what the developer should investigate or verify manually.`;

  const result = await structured.invoke(prompt);
  return result as Synthesis;
}
