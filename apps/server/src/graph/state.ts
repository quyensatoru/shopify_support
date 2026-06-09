import { Annotation } from '@langchain/langgraph';
import type {
    AgentState,
    RunRequest,
    ResolvedAppConfig,
    CaseMemory,
    CodeContext,
    AppKnowledgeChunk,
    NormalizedIssue,
    Hypothesis,
    Plan,
    ProbeResult,
    Evidence,
    Synthesis,
    FixPlan,
    Approval,
    Artifacts,
    VerifyResult,
    StepLog,
    SupportRunOutput,
    RunStatus,
} from '@shopify-support/shared';

export const SupportState = Annotation.Root({
    // 1. Input
    request: Annotation<RunRequest>(),
    appConfig: Annotation<ResolvedAppConfig | undefined>(),
    retrievedMemories: Annotation<CaseMemory[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
    }),

    // 1a. Search keys (English technical terms for code retrieval)
    searchQuery: Annotation<string | undefined>(),
    searchKeywords: Annotation<string[]>({
        reducer: (_a, b) => b,
        default: () => [],
    }),

    // 1b. Gathered context
    codeContexts: Annotation<CodeContext[]>({
        reducer: (_a, b) => b,
        default: () => [],
    }),
    appKnowledge: Annotation<AppKnowledgeChunk[]>({
        reducer: (_a, b) => b,
        default: () => [],
    }),

    // 2. Plan
    normalized: Annotation<NormalizedIssue | undefined>(),
    hypotheses: Annotation<Hypothesis[]>({
        reducer: (_a, b) => b,
        default: () => [],
    }),
    plan: Annotation<Plan | undefined>(),
    iteration: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
    }),
    // Number of probe-refinement passes (DB query synthesis / env trace) — bounded loop guard.
    refineCount: Annotation<number>({
        reducer: (a, b) => a + b,
        default: () => 0,
    }),
    // Ids resolved from earlier DB probes (e.g. shop_id from a domain lookup) for dependent queries.
    resolvedIds: Annotation<Array<{ field: string; value: string; source?: string }>>({
        reducer: (a, b) => {
            const seen = new Set(a.map((r) => `${r.field}=${r.value}`));
            return [...a, ...b.filter((r) => !seen.has(`${r.field}=${r.value}`))];
        },
        default: () => [],
    }),
    // Set when a refine pass produced no new probes → stop refining.
    refineStalled: Annotation<boolean>({
        reducer: (_a, b) => b,
        default: () => false,
    }),

    // 3. Diagnosis
    probeResults: Annotation<ProbeResult[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
    }),
    evidence: Annotation<Evidence[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
    }),
    strongSignal: Annotation<boolean>({
        reducer: (a, b) => a || b,
        default: () => false,
    }),

    // 4. Analysis
    synthesis: Annotation<Synthesis | undefined>(),

    // 5. Fix
    fixPlan: Annotation<FixPlan | undefined>(),
    approval: Annotation<Approval | undefined>(),
    artifacts: Annotation<Artifacts | undefined>(),

    // 6. Verify
    verification: Annotation<VerifyResult[] | undefined>(),

    // 7. Meta
    newMemories: Annotation<CaseMemory[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
    }),
    status: Annotation<RunStatus>({
        reducer: (_a, b) => b,
        default: () => 'running',
    }),
    missingContext: Annotation<string[]>({
        reducer: (a, b) => [...new Set([...a, ...b])],
        default: () => [],
    }),
    errors: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
    }),
    timeline: Annotation<StepLog[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
    }),
    output: Annotation<SupportRunOutput | undefined>(),
});

export type SupportStateType = typeof SupportState.State;
