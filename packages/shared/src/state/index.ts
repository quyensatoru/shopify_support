import { z } from 'zod';
import {
    AttachmentSchema,
    CaseTypeSchema,
    ConfidenceSchema,
    IdentifierSchema,
    ProbeSchema,
    ResolvedAppConfigSchema,
    RunModeSchema,
    RunStatusSchema,
    SeveritySchema,
    SurfaceSchema,
    VerdictStatusSchema,
} from '../domain/index.js';

// ── Request (immutable after intake) ────────────────────────────────
export const RunRequestSchema = z.object({
    runId: z.string(),
    threadId: z.string(),
    app: z.string(),
    appKey: z.string().optional(),
    storeDomain: z.string().optional(),
    storeUrl: z.string().optional(),
    issueText: z.string().min(1),
    reportedBy: z.string(),
    severity: SeveritySchema.optional(),
    identifiers: z.array(IdentifierSchema).default([]),
    attachments: z.array(AttachmentSchema).optional(),
    mode: RunModeSchema.default('diagnose'),
    interactive: z.boolean().default(false),
    maxIterations: z.number().int().positive().max(5).default(3),
    metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

// ── Plan (LLM output) ────────────────────────────────────────────────
export const HypothesisSchema = z.object({
    id: z.string(),
    rank: z.number().int().positive(),
    statement: z.string(),
    whyPlausible: z.string(),
    confirmSignals: z.array(z.string()).min(1),
    rejectSignals: z.array(z.string()).min(1),
    confidence: z.enum(['low', 'medium', 'high']),
    suggestedSurfaces: z.array(SurfaceSchema),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const NormalizedIssueSchema = z.object({
    caseType: CaseTypeSchema,
    restatement: z.string(),
    identifiers: z.array(IdentifierSchema),
    severity: SeveritySchema,
});
export type NormalizedIssue = z.infer<typeof NormalizedIssueSchema>;

export const PlanSchema = z.object({
    probes: z.array(ProbeSchema),
    rationale: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

// ── Evidence (deterministic probe output) ───────────────────────────
export const ProbeResultSchema = z.object({
    probeId: z.string(),
    surface: SurfaceSchema,
    action: z.string(),
    status: z.enum(['done', 'skipped', 'failed']),
    found: z.boolean(),
    data: z.unknown(),
    reason: z.string().optional(),
    provenance: z.string(), // "db:shops WHERE shop_domain='x'" etc.
    durationMs: z.number().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const EvidenceSchema = z.object({
    id: z.string(),
    surface: SurfaceSchema,
    claim: z.string(),
    value: z.unknown(),
    refs: z.array(z.string()), // probeIds
    source: z.string(),
    // 'negative' = the probe ran successfully but the thing was absent/empty
    // (e.g. shop record not found, queue empty). Negative evidence is often the
    // most diagnostic signal, so it is kept rather than dropped.
    polarity: z.enum(['positive', 'negative']).default('positive'),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ── Synthesis (LLM output) ──────────────────────────────────────────
export const VerdictSchema = z.object({
    hypothesisId: z.string(),
    status: VerdictStatusSchema,
    rationale: z.string(),
    evidenceRefs: z.array(z.string()), // evidence IDs
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const SynthesisSchema = z.object({
    verdicts: z.array(VerdictSchema),
    rootCause: z.string(),
    confidence: ConfidenceSchema,
    recommendedFix: z.string().optional(),
    nextSteps: z.array(z.string()).default([]),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

// ── Fix plan (LLM output) ────────────────────────────────────────────
export const ChangeSchema = z.object({
    kind: z.enum(['code', 'config', 'data']),
    description: z.string(),
    file: z.string().optional(),
    diff: z.string().optional(),
    configKey: z.string().optional(),
    configValue: z.unknown().optional(),
    dataSource: z.string().optional(),
    dataQuery: z.string().optional(),
});
export type Change = z.infer<typeof ChangeSchema>;

export const VerifyStepSchema = z.object({
    surface: SurfaceSchema,
    action: z.string(),
    target: z.record(z.string(), z.unknown()),
    expectedOutcome: z.string(),
});
export type VerifyStep = z.infer<typeof VerifyStepSchema>;

export const FixPlanSchema = z.object({
    changes: z.array(ChangeSchema),
    verification: z.array(VerifyStepSchema),
    risk: z.enum(['low', 'medium', 'high']),
    summary: z.string(),
});
export type FixPlan = z.infer<typeof FixPlanSchema>;

// ── Approval ─────────────────────────────────────────────────────────
export const ApprovalSchema = z.object({
    required: z.boolean(),
    status: z.enum(['pending', 'approved', 'rejected']),
    approver: z.string().optional(),
    note: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

// ── Artifacts (after fixApply) ───────────────────────────────────────
export const ArtifactsSchema = z.object({
    mrUrl: z.string().optional(),
    branch: z.string().optional(),
    commitSha: z.string().optional(),
    configChanges: z.array(z.string()).optional(),
    dataChanges: z.array(z.string()).optional(),
});
export type Artifacts = z.infer<typeof ArtifactsSchema>;

// ── Verify result ────────────────────────────────────────────────────
export const VerifyResultSchema = z.object({
    stepIdx: z.number(),
    surface: SurfaceSchema,
    status: z.enum(['pass', 'fail', 'skipped']),
    detail: z.string(),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

// ── Memory ───────────────────────────────────────────────────────────
export const CaseMemorySchema = z.object({
    id: z.string(),
    app: z.string(),
    caseType: CaseTypeSchema,
    title: z.string(),
    issueSummary: z.string(),
    rootCause: z.string(),
    fix: z.string().optional(),
    signals: z.array(z.string()),
    reusableInsight: z.string(),
    confidence: ConfidenceSchema,
    sourceRunId: z.string(),
    createdAt: z.string(),
});
export type CaseMemory = z.infer<typeof CaseMemorySchema>;

// ── Timeline / step log ──────────────────────────────────────────────
export const StepLogSchema = z.object({
    seq: z.number().int().nonnegative(),
    node: z.string(),
    status: z.enum(['started', 'completed', 'failed', 'skipped', 'interrupted']),
    summary: z.string().optional(),
    durationMs: z.number().optional(),
    ts: z.string(),
});
export type StepLog = z.infer<typeof StepLogSchema>;

// ── Full run output ──────────────────────────────────────────────────
export const SupportRunOutputSchema = z.object({
    runId: z.string(),
    threadId: z.string(),
    app: z.string(),
    issueText: z.string(),
    mode: RunModeSchema,
    status: RunStatusSchema,
    caseType: CaseTypeSchema.optional(),
    rootCause: z.string().optional(),
    confidence: ConfidenceSchema.optional(),
    recommendedFix: z.string().optional(),
    mrUrl: z.string().optional(),
    nextSteps: z.array(z.string()).default([]),
    summary: z.string(),
    timeline: z.array(StepLogSchema),
    missingContext: z.array(z.string()),
    errors: z.array(z.string()),
    completedAt: z.string(),
});
export type SupportRunOutput = z.infer<typeof SupportRunOutputSchema>;

// ── Code context (from codegraph, per-repo) ──────────────────────────
export const CodeContextSchema = z.object({
    repo: z.string(),
    framework: z.string().optional(),
    contextMarkdown: z.string(),
    relevantSymbols: z
        .array(
            z.object({
                name: z.string(),
                file: z.string(),
                kind: z.string(),
                line: z.number().optional(),
            }),
        )
        .default([]),
    expectedMarkers: z.array(z.string()).default([]),
});
export type CodeContext = z.infer<typeof CodeContextSchema>;

// ── App knowledge chunks (from web / docs) ───────────────────────────
export const AppKnowledgeChunkSchema = z.object({
    chunkId: z.string(),
    source: z.enum(['web_search', 'doc_url', 'app_store']),
    url: z.string().optional(),
    title: z.string(),
    chunk: z.string(),
});
export type AppKnowledgeChunk = z.infer<typeof AppKnowledgeChunkSchema>;

// ── Full agent state (used as LangGraph Annotation source) ──────────
// Note: exported as plain zod — server builds Annotation.Root from this.
export const AgentStateSchema = z.object({
    // 1. Input
    request: RunRequestSchema,
    appConfig: ResolvedAppConfigSchema.optional(),
    retrievedMemories: z.array(CaseMemorySchema).default([]),

    // 1b. Gathered context (deterministic, from gather_context node)
    codeContexts: z.array(CodeContextSchema).default([]),
    appKnowledge: z.array(AppKnowledgeChunkSchema).default([]),

    // 2. Plan
    normalized: NormalizedIssueSchema.optional(),
    hypotheses: z.array(HypothesisSchema).default([]),
    plan: PlanSchema.optional(),
    iteration: z.number().int().nonnegative().default(0),

    // 3. Diagnosis
    probeResults: z.array(ProbeResultSchema).default([]),
    evidence: z.array(EvidenceSchema).default([]),
    strongSignal: z.boolean().default(false),

    // 4. Synthesis
    synthesis: SynthesisSchema.optional(),

    // 5. Fix
    fixPlan: FixPlanSchema.optional(),
    approval: ApprovalSchema.optional(),
    artifacts: ArtifactsSchema.optional(),

    // 6. Verify
    verification: z.array(VerifyResultSchema).optional(),

    // 7. Meta
    newMemories: z.array(CaseMemorySchema).default([]),
    status: RunStatusSchema.default('running'),
    missingContext: z.array(z.string()).default([]),
    errors: z.array(z.string()).default([]),
    timeline: z.array(StepLogSchema).default([]),
    output: SupportRunOutputSchema.optional(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;
