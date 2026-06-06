import { z } from 'zod';
import { getLlm } from '../llm/index.js';
import type {
  ResolvedAppConfig,
  CaseMemory,
  Hypothesis,
  NormalizedIssue,
  Plan,
  Probe,
  Identifier,
} from '@shopify-support/shared';
import { randomUUID } from 'node:crypto';

const PlanOutputSchema = z.object({
  caseType: z.enum([
    'installation_oauth', 'embedded_admin_ui', 'storefront_extension',
    'webhook_sync', 'api_permission', 'billing', 'data_integrity',
    'performance', 'configuration', 'frontend_bug', 'unknown',
  ]),
  severity: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  restatement: z.string().describe('Clear restatement of the issue in technical terms'),
  identifiers: z.array(z.object({ kind: z.string(), value: z.string() })).default([]),
  hypotheses: z.array(z.object({
    rank: z.number().int(),
    statement: z.string(),
    whyPlausible: z.string(),
    confirmSignals: z.array(z.string()).min(1),
    rejectSignals: z.array(z.string()).min(1),
    confidence: z.enum(['low', 'medium']),
    suggestedSurfaces: z.array(z.string()),
  })).min(1).max(5),
  probes: z.array(z.object({
    surface: z.enum(['code', 'database', 'logs', 'shopify', 'browser', 'config']),
    action: z.string(),
    target: z.record(z.string(), z.string()),
    hint: z.string(),
    hypothesisRanks: z.array(z.number()),
  })),
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
};

export async function runPlanReasoning(input: PlanInput): Promise<{
  normalized: NormalizedIssue;
  hypotheses: Hypothesis[];
  plan: Plan;
  missingContext: string[];
}> {
  const llm = getLlm();
  const structured = llm.withStructuredOutput(PlanOutputSchema, { name: 'plan_output' });

  const memorySummary = (input.retrievedMemories ?? [])
    .slice(0, 3)
    .map((m, i) => `[Memory ${i + 1}] caseType=${m.caseType}: ${m.reusableInsight}`)
    .join('\n');

  const configSummary = input.appConfig
    ? `Repos: ${input.appConfig.repos.map((r) => r.name).join(', ') || 'none'} | DB sources: ${input.appConfig.dbSources.map((d) => `${d.key}(${d.type})`).join(', ') || 'none'} | Shopify: ${input.appConfig.shopify ? 'configured' : 'not configured'}`
    : 'App config: not available';

  const prompt = `You are a Shopify embedded app support engineer. Analyze this issue and produce a structured investigation plan.

App: ${input.app}
Issue: ${input.issueText}
${input.storeDomain ? `Store: ${input.storeDomain}` : ''}
${input.storeUrl ? `Store URL: ${input.storeUrl}` : ''}
${input.identifiers?.length ? `Identifiers: ${input.identifiers.map((id) => `${id.kind}=${id.value}`).join(', ')}` : ''}
${configSummary}
${memorySummary ? `\nRelevant past cases:\n${memorySummary}` : ''}

Instructions:
1. Classify the caseType (installation_oauth | embedded_admin_ui | storefront_extension | webhook_sync | api_permission | billing | data_integrity | performance | configuration | frontend_bug | unknown).
2. Restate the issue clearly in technical terms.
3. Generate 2-4 concrete, testable hypotheses ranked by likelihood.
4. For each hypothesis: state what would CONFIRM it (observable signals) and what would REJECT it.
5. Generate specific probes (investigation actions) targeting the most likely surfaces.
   - surface options: code | database | logs | shopify | browser | config
   - Only include probes for surfaces that are configured or have the storeDomain/URL available.
   - Probe target should be specific (e.g., for code: glob="**/*.ts", regex="sessionToken|appBridge"; for database: collection="shops", query="shop_domain = ?").
6. List any missing context that would improve the investigation (e.g., "need store URL to run browser probe").

Prioritize: minimize LLM usage downstream — make probes as specific as possible so deterministic code can run them without needing further reasoning.`;

  const result = await structured.invoke(prompt);

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
      suggestedSurfaces: (h.suggestedSurfaces ?? []) as Array<'code' | 'database' | 'logs' | 'shopify' | 'browser' | 'config'>,
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
  newProbes: z.array(z.object({
    surface: z.enum(['code', 'database', 'logs', 'shopify', 'browser', 'config']),
    action: z.string(),
    target: z.record(z.string(), z.string()),
    hint: z.string(),
    hypothesisIds: z.array(z.string()),
  })),
});

export async function runReplanReasoning(input: {
  app: string;
  issueText: string;
  existingPlan?: Plan;
  evidence: unknown[];
  synthesis?: unknown;
  appConfig?: ResolvedAppConfig;
}): Promise<Probe[]> {
  const llm = getLlm();
  const structured = llm.withStructuredOutput(ReplanOutputSchema, { name: 'replan_output' });

  const prompt = `You are a Shopify embedded app support engineer. The initial investigation has low confidence.

App: ${input.app}
Issue: ${input.issueText}
Evidence so far: ${JSON.stringify(input.evidence).slice(0, 2000)}
Current synthesis: ${JSON.stringify(input.synthesis).slice(0, 1000)}

Generate NEW investigation probes to fill the gaps. Do not repeat probes already run. Focus on surfaces not yet covered or deeper queries on surfaces that returned partial data.`;

  const result = await structured.invoke(prompt);

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
