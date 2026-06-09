import type { SupportStateType } from '../state.js';
import type { Probe } from '@shopify-support/shared';
import { stepLog } from '../utils.js';
import { logger } from '../../observability/logger.js';
import {
    runDbQueryReasoning,
    collectDiscoveredSources,
    extractResolvedIds,
} from '../../reasoning/dbQuery.js';
import { detectEnvVars, buildEnvTraceProbes } from '../../reasoning/envTrace.js';
import {
    runSnapshotProbeReasoning,
    isRecordingCase,
    findPipelineHint,
} from '../../reasoning/snapshotProbe.js';

const DB_DATA_ACTIONS = ['check_record_exists', 'count_check', 'key_inspect', 'queue_inspect', 'peek_messages'];
const MAX_REFINE = 3;

function plannedProbes(state: SupportStateType): Probe[] {
    return state.plan?.probes ?? [];
}

function dbDataProbePlanned(state: SupportStateType): boolean {
    return plannedProbes(state).some(
        (p) => p.surface === 'database' && DB_DATA_ACTIONS.includes(p.action),
    );
}

function envTraceProbePlanned(state: SupportStateType): boolean {
    return plannedProbes(state).some(
        (p) => p.surface === 'code' && Boolean((p.target as Record<string, unknown>)['__envTrace']),
    );
}

function buildSnapshotProbePlanned(state: SupportStateType): boolean {
    return plannedProbes(state).some(
        (p) => p.surface === 'snapshot' && p.action === 'build_snapshot',
    );
}

/** resolvedIds whose value isn't yet referenced by any planned DB query → still actionable. */
function hasUnusedResolvedIds(state: SupportStateType): boolean {
    const ids = state.resolvedIds ?? [];
    if (!ids.length) return false;
    const queries = plannedProbes(state)
        .filter((p) => p.surface === 'database')
        .map((p) => String((p.target as Record<string, unknown>)['query'] ?? ''))
        .join(' ');
    return ids.some((r) => !queries.includes(r.value));
}

function detectEnvForState(state: SupportStateType): string[] {
    return detectEnvVars({
        issueText: state.request.issueText,
        hypotheses: state.hypotheses,
        expectedConfig: state.appConfig?.expectedConfig,
    });
}

function recordingIdResolved(state: SupportStateType): boolean {
    return (state.resolvedIds ?? []).some((r) => /record|session|page/i.test(r.field));
}

/**
 * Decide whether to deepen probes before analysis. Drives a bounded multi-step loop:
 *   discover → (DB lookup domain→shop_id) → (DB data query by shop_id) → (build_snapshot)
 * plus env-var code tracing. Self-terminating via refineCount, refineStalled, and
 * "is there anything new actionable" checks.
 */
export function needsRefine(state: SupportStateType): boolean {
    if ((state.refineCount ?? 0) >= MAX_REFINE) return false;
    if (state.refineStalled) return false;

    const discovered = collectDiscoveredSources(state.probeResults).length > 0;
    const dbNeeded = discovered && (!dbDataProbePlanned(state) || hasUnusedResolvedIds(state));

    const hasRepos = (state.appConfig?.repos?.length ?? 0) > 0;
    const envNeeded =
        hasRepos && detectEnvForState(state).length > 0 && !envTraceProbePlanned(state);

    const recording = isRecordingCase(
        state.request.issueText,
        state.searchKeywords ?? [],
        state.normalized?.caseType,
    );
    const snapshotNeeded =
        recording && discovered && recordingIdResolved(state) && !buildSnapshotProbePlanned(state);

    return dbNeeded || envNeeded || snapshotNeeded;
}

export async function refineProbesNode(state: SupportStateType) {
    const t0 = Date.now();
    const newProbes: Probe[] = [];
    const notes: string[] = [];

    // Pull ids resolved from DB probes so far (e.g. shop_id from a domain lookup).
    const resolvedIds = extractResolvedIds(state.probeResults);

    try {
        const discovered = collectDiscoveredSources(state.probeResults);

        // ── 1. DB: schema + resolved ids → grounded read-only queries (lookup or data) ──
        if (discovered.length > 0 && (!dbDataProbePlanned(state) || hasUnusedResolvedIds(state))) {
            const dbProbes = await runDbQueryReasoning({
                app: state.request.app,
                issueText: state.request.issueText,
                identifiers: state.request.identifiers ?? [],
                storeDomain: state.request.storeDomain,
                hypotheses: state.hypotheses,
                discovered,
                resolvedIds,
            });
            newProbes.push(...dedupeAgainstPlan(state, dbProbes));
            if (dbProbes.length) notes.push(`${dbProbes.length} db probe(s)`);
        }

        // ── 2. Env: trace the code that reads implicated env vars ─────────
        const hasRepos = (state.appConfig?.repos?.length ?? 0) > 0;
        if (hasRepos && !envTraceProbePlanned(state)) {
            const envVars = detectEnvForState(state);
            if (envVars.length > 0) {
                newProbes.push(...buildEnvTraceProbes(envVars, state.hypotheses));
                notes.push(`env trace: ${envVars.join(', ')}`);
            }
        }

        // ── 3. Snapshot: rebuild the recording once a recording id is known ──
        const recording = isRecordingCase(
            state.request.issueText,
            state.searchKeywords ?? [],
            state.normalized?.caseType,
        );
        if (recording && discovered.length > 0 && recordingIdResolved(state) && !buildSnapshotProbePlanned(state)) {
            const snapProbes = await runSnapshotProbeReasoning({
                issueText: state.request.issueText,
                discovered,
                resolvedIds,
                hypotheses: state.hypotheses,
                pipelineHint: findPipelineHint(state.probeResults),
            });
            newProbes.push(...dedupeAgainstPlan(state, snapProbes));
            if (snapProbes.length) notes.push(`${snapProbes.length} build_snapshot`);
        }

        if (!newProbes.length) {
            return {
                refineCount: 1,
                refineStalled: true,
                resolvedIds,
                timeline: [stepLog('refine_probes', 'skipped', Date.now() - t0, 'No new probes')],
            };
        }

        const updatedPlan = {
            probes: [...(state.plan?.probes ?? []), ...newProbes],
            rationale: state.plan?.rationale ?? '',
        };

        return {
            plan: updatedPlan,
            refineCount: 1,
            refineStalled: false,
            resolvedIds,
            timeline: [
                stepLog(
                    'refine_probes',
                    'completed',
                    Date.now() - t0,
                    `Added ${newProbes.length} probe(s) — ${notes.join('; ')}`,
                ),
            ],
        };
    } catch (err) {
        logger.error(
            { err, runId: state.request.runId, node: 'refine_probes' },
            'refine_probes node failed',
        );
        return {
            refineCount: 1,
            refineStalled: true,
            errors: [`refine_probes failed: ${String(err)}`],
            timeline: [stepLog('refine_probes', 'failed', Date.now() - t0)],
        };
    }
}

/** Drop probes that repeat one already in the plan (by surface/action/source/table/query). */
function dedupeAgainstPlan(state: SupportStateType, probes: Probe[]): Probe[] {
    const sig = (p: Probe) => {
        const t = p.target as Record<string, unknown>;
        return [
            p.surface,
            p.action,
            t['source'] ?? '',
            t['table'] ?? t['collection'] ?? '',
            t['query'] ?? t['recordingId'] ?? t['key'] ?? t['queue'] ?? '',
        ].join('|');
    };
    const existing = new Set((state.plan?.probes ?? []).map(sig));
    const out: Probe[] = [];
    for (const p of probes) {
        const s = sig(p);
        if (existing.has(s)) continue;
        existing.add(s);
        out.push(p);
    }
    return out;
}
