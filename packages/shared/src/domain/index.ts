import { z } from 'zod';

export const CaseTypeSchema = z.enum([
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
]);
export type CaseType = z.infer<typeof CaseTypeSchema>;

export const SurfaceSchema = z.enum(['code', 'database', 'logs', 'shopify', 'browser', 'config', 'rabbitmq']);
export type Surface = z.infer<typeof SurfaceSchema>;

export const SeveritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const IdentifierKindSchema = z.enum([
    'store_domain',
    'store_url',
    'order_id',
    'product_id',
    'customer_id',
    'variant_id',
    'shop_id',
    'other',
]);
export type IdentifierKind = z.infer<typeof IdentifierKindSchema>;

export const IdentifierSchema = z.object({
    kind: IdentifierKindSchema,
    value: z.string().trim().min(1),
});
export type Identifier = z.infer<typeof IdentifierSchema>;

export const RunModeSchema = z.enum(['diagnose', 'fix']);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RunStatusSchema = z.enum([
    'running',
    'awaiting_input',
    'awaiting_approval',
    'completed',
    'partial',
    'failed',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ProbeStatusSchema = z.enum(['pending', 'running', 'done', 'skipped', 'failed']);
export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

export const VerdictStatusSchema = z.enum(['confirmed', 'rejected', 'inconclusive']);
export type VerdictStatus = z.infer<typeof VerdictStatusSchema>;

// Surface-specific probe target (flexible by surface type)
export const ProbeTargetSchema = z.object({
    // code — search_code (regex grep)
    repo: z.string().optional(),
    glob: z.string().optional(),
    regex: z.string().optional(),
    // code — codegraph actions (find_symbol, find_callers, find_callees, impact, build_context)
    symbol: z.string().optional(), // symbol name to look up
    nodeId: z.string().optional(), // node ID for caller/callee/impact
    depth: z.number().optional(), // traversal depth
    // database — sql table, mongo collection, raw query
    source: z.string().optional(),
    table: z.string().optional(),
    collection: z.string().optional(),
    query: z.string().optional(),
    // logs
    keyword: z.string().optional(),
    level: z.string().optional(),
    timeWindowMinutes: z.number().optional(),
    // shopify
    action: z.string().optional(),
    // browser
    url: z.string().optional(),
    marker: z.string().optional(),
    // config
    key: z.string().optional(),
    pattern: z.string().optional(),
    // rabbitmq
    queue: z.string().optional(),
    n: z.string().optional(),
});
export type ProbeTarget = z.infer<typeof ProbeTargetSchema>;

export const ProbeSchema = z.object({
    id: z.string(),
    surface: SurfaceSchema,
    action: z.string(),
    target: ProbeTargetSchema,
    hint: z.string(),
    hypothesisIds: z.array(z.string()),
    status: ProbeStatusSchema,
});
export type Probe = z.infer<typeof ProbeSchema>;

export const AttachmentSchema = z.object({
    name: z.string(),
    mimeType: z.string(),
    content: z.string(), // base64
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// ── App Config types (used in shared for contracts) ─────────────────
export const DbSourceTypeSchema = z.enum(['sql', 'mongo', 'redis', 'rabbitmq']);
export type DbSourceType = z.infer<typeof DbSourceTypeSchema>;

export const DbSourceSchema = z.object({
    key: z.string(),
    type: DbSourceTypeSchema,
    connectionString: z.string(),
    mgmtUrl: z.string().optional(), // rabbitmq management API
    readOnly: z.boolean().default(true),
});
export type DbSource = z.infer<typeof DbSourceSchema>;

export const LogSourceSchema = z.object({
    key: z.string(),
    type: z.string(), // elk|loki|cloudwatch|file
    endpoint: z.string(),
    token: z.string().optional(),
});
export type LogSource = z.infer<typeof LogSourceSchema>;

export const RepoConfigSchema = z.object({
    name: z.string(),
    gitlabProjectId: z.string().optional(),
    url: z.string(),
    branch: z.string().default('main'),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const ShopifyConfigSchema = z.object({
    apiVersion: z.string(),
    adminToken: z.string().optional(),
    oauthRef: z.string().optional(),
    requiredScopes: z.array(z.string()),
    expectedWebhooks: z.array(z.string()),
});
export type ShopifyConfig = z.infer<typeof ShopifyConfigSchema>;

export const ServiceConfigSchema = z.object({
    key: z.string(),
    baseUrl: z.string(),
    token: z.string().optional(),
});
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

// Resolved = secrets already decrypted in RAM
export const ResolvedAppConfigSchema = z.object({
    appKey: z.string(),
    name: z.string(),
    repos: z.array(RepoConfigSchema).default([]),
    gitlab: z
        .object({
            baseUrl: z.string(),
            token: z.string(),
        })
        .optional(),
    dbSources: z.array(DbSourceSchema).default([]),
    logSources: z.array(LogSourceSchema).optional(),
    shopify: ShopifyConfigSchema.optional(),
    services: z.array(ServiceConfigSchema).default([]),
    expectedConfig: z.record(z.string(), z.unknown()).default({}),
    // Non-secret public fields for app knowledge (Phase C)
    appStoreUrl: z.string().url().optional(),
    docUrls: z.array(z.string().url()).default([]),
    homepage: z.string().url().optional(),
    appDescription: z.string().optional(),
});
export type ResolvedAppConfig = z.infer<typeof ResolvedAppConfigSchema>;
