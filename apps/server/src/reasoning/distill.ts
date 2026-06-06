import { z } from 'zod';
import { getLlmFast } from '../llm/index.js';
import type { Synthesis, Artifacts, CaseMemory } from '@shopify-support/shared';
import { randomUUID } from 'node:crypto';

const DistillOutputSchema = z.object({
  title: z.string().max(120),
  issueSummary: z.string().max(300),
  rootCause: z.string().max(300),
  fix: z.string().max(300).optional(),
  signals: z.array(z.string()).max(5),
  reusableInsight: z.string().max(500).describe('Key insight reusable for future similar cases'),
});

export async function runDistillReasoning(input: {
  app: string;
  runId: string;
  caseType: string;
  issueText: string;
  synthesis: Synthesis;
  artifacts?: Artifacts;
}): Promise<CaseMemory> {
  const llm = getLlmFast();
  const structured = llm.withStructuredOutput(DistillOutputSchema, { name: 'distill_output' });

  const prompt = `Summarize this Shopify support case into a reusable memory entry.

App: ${input.app} | caseType: ${input.caseType}
Issue: ${input.issueText}
Root cause: ${input.synthesis.rootCause}
Confidence: ${input.synthesis.confidence}
Fix applied: ${input.artifacts?.mrUrl ? `MR ${input.artifacts.mrUrl}` : input.synthesis.recommendedFix ?? 'diagnose only'}

Create a concise, reusable memory entry. Focus on the INSIGHT that would help diagnose a similar issue faster next time.`;

  const result = await structured.invoke(prompt);

  return {
    id: randomUUID(),
    app: input.app,
    caseType: input.caseType as CaseMemory['caseType'],
    title: result.title,
    issueSummary: result.issueSummary,
    rootCause: result.rootCause,
    fix: result.fix,
    signals: result.signals,
    reusableInsight: result.reusableInsight,
    confidence: input.synthesis.confidence,
    sourceRunId: input.runId,
    createdAt: new Date().toISOString(),
  };
}
