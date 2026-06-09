import type Anthropic from '@anthropic-ai/sdk';
import type {
    ProbeResult,
    ResolvedAppConfig,
    RunRequest,
    CodeContext,
    Probe,
} from '@shopify-support/shared';
import { randomUUID } from 'node:crypto';
import { dispatchInvestigator } from '../../investigators/index.js';

/**
 * Tool layer for the bounded-agency investigation loop.
 *
 * Agency boundary: the model chooses WHAT to investigate (run_probe) and when it
 * is done (submit_findings). It can NEVER cause a side-effect — run_probe goes
 * through the same read-only investigators as the structured path (read-only DB
 * adapters + guards), and any fix still goes through the separate approval gate.
 */

export const INVESTIGATION_TOOLS: Anthropic.Messages.Tool[] = [
    {
        name: 'run_probe',
        description:
            'Run ONE read-only investigation probe and get its result. Surfaces:\n' +
            '- code: actions search_code (target.regex, target.glob), find_symbol/find_callers/find_callees/impact/build_context (target.symbol).\n' +
            '- database: discover (target.source) to list tables/collections+schema; then check_record_exists/count_check (target.source, target.table|collection, target.query); redis key_inspect (target.key|pattern); rabbitmq queue_inspect/peek_messages (target.queue). Multi-step: look up shop_id by domain first, then query data by shop_id.\n' +
            '- snapshot: inspect_pipeline (how the app compresses/renders recordings); build_snapshot (target.source, collection|table, idField, snapshotField, recordingId) to decompress+rebuild+replay a recording.\n' +
            '- logs: query_logs (target.keyword, level, timeWindowMinutes). shopify: app_status/granted_scopes/list_webhooks/billing_status. browser: render (target.url) or check_markers (target.marker). config: get_app_config (target.key).\n' +
            'All queries are READ-ONLY. Prefer real table/column/symbol names from earlier results; do not invent them.',
        input_schema: {
            type: 'object',
            properties: {
                surface: {
                    type: 'string',
                    enum: ['code', 'database', 'logs', 'shopify', 'browser', 'config', 'snapshot'],
                },
                action: { type: 'string', description: 'surface-specific action (see description)' },
                target: {
                    type: 'object',
                    description: 'surface-specific parameters (source, table, collection, query, regex, glob, symbol, url, key, queue, idField, snapshotField, recordingId, ...)',
                    additionalProperties: true,
                },
                hint: { type: 'string', description: 'why you are running this probe' },
            },
            required: ['surface', 'action', 'target'],
        },
    },
    {
        name: 'submit_findings',
        description:
            'Call this when you have enough evidence to conclude (or when no more useful probes remain). Provide the root cause grounded in the probe results you gathered.',
        input_schema: {
            type: 'object',
            properties: {
                rootCause: { type: 'string' },
                confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
                recommendedFix: { type: 'string' },
                nextSteps: { type: 'array', items: { type: 'string' } },
            },
            required: ['rootCause', 'confidence'],
        },
    },
];

export type ProbeToolInput = {
    surface: Probe['surface'];
    action: string;
    target?: Record<string, unknown>;
    hint?: string;
};

export type SubmitFindingsInput = {
    rootCause: string;
    confidence: 'low' | 'medium' | 'high';
    recommendedFix?: string;
    nextSteps?: string[];
};

/** Execute a run_probe tool call via the deterministic, read-only investigators. */
export async function executeProbeTool(
    input: ProbeToolInput,
    ctx: { appConfig?: ResolvedAppConfig; request: RunRequest; codeContexts?: CodeContext[] },
): Promise<ProbeResult> {
    const probe: Probe = {
        id: randomUUID(),
        surface: input.surface,
        action: input.action,
        target: (input.target ?? {}) as Probe['target'],
        hint: input.hint ?? '',
        hypothesisIds: [],
        status: 'pending',
    };
    return dispatchInvestigator(probe, ctx.appConfig, ctx.request, ctx.codeContexts);
}
