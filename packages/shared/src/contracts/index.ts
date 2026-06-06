import { z } from 'zod';
import {
    RunModeSchema,
    RunStatusSchema,
    SeveritySchema,
    IdentifierSchema,
} from '../domain/index.js';
import { SupportRunOutputSchema } from '../state/index.js';

// ── POST /api/runs ───────────────────────────────────────────────────
export const CreateRunRequestSchema = z.object({
    app: z.string().min(1),
    appKey: z.string().optional(),
    storeDomain: z.string().optional(),
    storeUrl: z.string().optional(),
    issueText: z.string().min(1),
    reportedBy: z.string().min(1),
    severity: SeveritySchema.optional(),
    identifiers: z.array(IdentifierSchema).optional(),
    mode: RunModeSchema.optional(),
    interactive: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const CreateRunResponseSchema = z.object({
    runId: z.string(),
    threadId: z.string(),
    status: RunStatusSchema,
});
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

// ── POST /api/runs/:id/resume ────────────────────────────────────────
export const ResumeRunRequestSchema = z.union([
    // context answer (ask_context interrupt)
    z.object({
        type: z.literal('context'),
        value: z.record(z.string(), z.unknown()),
    }),
    // approval decision (approve interrupt)
    z.object({
        type: z.literal('approval'),
        decision: z.enum(['approve', 'reject']),
        note: z.string().optional(),
    }),
]);
export type ResumeRunRequest = z.infer<typeof ResumeRunRequestSchema>;

// ── GET /api/runs/:id ────────────────────────────────────────────────
export const RunDetailSchema = z.object({
    runId: z.string(),
    threadId: z.string(),
    app: z.string(),
    issueText: z.string(),
    mode: RunModeSchema,
    status: RunStatusSchema,
    reportedBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    output: SupportRunOutputSchema.optional(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

// ── GET /api/runs (list) ─────────────────────────────────────────────
export const ListRunsQuerySchema = z.object({
    app: z.string().optional(),
    status: RunStatusSchema.optional(),
    reportedBy: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
    offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;

// ── App config (stored, secrets omitted on read) ─────────────────────
export const AppConfigWriteSchema = z.object({
    name: z.string().min(1),
    repos: z
        .array(
            z.object({
                name: z.string(),
                gitlabProjectId: z.string().optional(),
                url: z.string(),
                branch: z.string().optional(),
            }),
        )
        .optional(),
    gitlab: z.object({ baseUrl: z.string(), token: z.string() }).optional(),
    dbSources: z
        .array(
            z.object({
                key: z.string(),
                type: z.enum(['sql', 'mongo', 'redis', 'rabbitmq']),
                connectionString: z.string(),
                mgmtUrl: z.string().optional(),
            }),
        )
        .optional(),
    logSources: z
        .array(
            z.object({
                key: z.string(),
                type: z.string(),
                endpoint: z.string(),
                token: z.string().optional(),
            }),
        )
        .optional(),
    shopify: z
        .object({
            apiVersion: z.string(),
            adminToken: z.string().optional(),
            requiredScopes: z.array(z.string()).optional(),
            expectedWebhooks: z.array(z.string()).optional(),
        })
        .optional(),
    services: z
        .array(z.object({ key: z.string(), baseUrl: z.string(), token: z.string().optional() }))
        .optional(),
    expectedConfig: z.record(z.string(), z.unknown()).optional(),
});
export type AppConfigWrite = z.infer<typeof AppConfigWriteSchema>;

export const AppSummarySchema = z.object({
    appKey: z.string(),
    name: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type AppSummary = z.infer<typeof AppSummarySchema>;

// ── Memory ────────────────────────────────────────────────────────────
export const ListMemoriesQuerySchema = z.object({
    app: z.string().optional(),
    caseType: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().positive().max(50).default(10),
});
export type ListMemoriesQuery = z.infer<typeof ListMemoriesQuerySchema>;

// ── Tools ─────────────────────────────────────────────────────────────
export const ToolInfoSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    surface: z.string(),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

// ── Config test result ────────────────────────────────────────────────
export const ConfigTestResultSchema = z.object({
    surface: z.string(),
    key: z.string(),
    ok: z.boolean(),
    message: z.string(),
});
export type ConfigTestResult = z.infer<typeof ConfigTestResultSchema>;
