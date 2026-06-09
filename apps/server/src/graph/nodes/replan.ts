import type { SupportStateType } from '../state.js';
import type { Probe } from '@shopify-support/shared';
import { runReplanReasoning } from '../../reasoning/plan.js';
import {
    runDbQueryReasoning,
    collectDiscoveredSources,
    summarizeDiscoveredSchema,
} from '../../reasoning/dbQuery.js';
import { stepLog } from '../utils.js';
import { logger } from '../../observability/logger.js';

/** A stable signature for a probe, used to drop follow-up probes that repeat one already planned. */
function probeSig(p: Pick<Probe, 'surface' | 'action' | 'target'>): string {
    const t = p.target as Record<string, unknown>;
    return [
        p.surface,
        p.action,
        t['source'] ?? '',
        t['table'] ?? t['collection'] ?? '',
        t['query'] ?? t['key'] ?? t['pattern'] ?? t['queue'] ?? '',
    ].join('|');
}

/** Summarize what the tentative analysis still needs, to steer follow-up DB queries. */
function analysisGaps(state: SupportStateType): string {
    const s = state.synthesis;
    if (!s) return '';
    const parts: string[] = [`Tentative root cause: ${s.rootCause}`];
    if (s.nextSteps?.length) parts.push(`Next steps: ${s.nextSteps.join('; ')}`);
    const inconclusive = (s.verdicts ?? [])
        .filter((v) => v.status === 'inconclusive')
        .map((v) => v.rationale)
        .slice(0, 3);
    if (inconclusive.length) parts.push(`Unresolved: ${inconclusive.join(' | ')}`);
    return parts.join('\n');
}

export async function replanNode(state: SupportStateType) {
    const t0 = Date.now();
    try {
        const discovered = collectDiscoveredSources(state.probeResults);
        const discoveredSchema = discovered.length
            ? summarizeDiscoveredSchema(discovered)
            : undefined;

        // Generic replan probes (any surface), grounded with DB schema when available.
        const generic = await runReplanReasoning({
            app: state.request.app,
            issueText: state.request.issueText,
            existingPlan: state.plan,
            evidence: state.evidence,
            synthesis: state.synthesis,
            appConfig: state.appConfig,
            discoveredSchema,
        });

        // Targeted DB follow-up: read more context from the DB to firm up the analysis.
        const dbProbes = discovered.length
            ? await runDbQueryReasoning({
                  app: state.request.app,
                  issueText: state.request.issueText,
                  identifiers: state.request.identifiers ?? [],
                  storeDomain: state.request.storeDomain,
                  hypotheses: state.hypotheses,
                  discovered,
                  focus: analysisGaps(state),
              })
            : [];

        // Drop anything that repeats a probe already in the plan.
        const existing = new Set((state.plan?.probes ?? []).map(probeSig));
        const newProbes: Probe[] = [];
        for (const p of [...generic, ...dbProbes]) {
            const sig = probeSig(p);
            if (existing.has(sig)) continue;
            existing.add(sig);
            newProbes.push(p);
        }

        const updatedPlan = {
            probes: [...(state.plan?.probes ?? []), ...newProbes],
            rationale: state.plan?.rationale ?? '',
        };

        return {
            plan: updatedPlan,
            iteration: 1,
            timeline: [
                stepLog(
                    'replan',
                    'completed',
                    Date.now() - t0,
                    `Added ${newProbes.length} probe(s)${dbProbes.length ? ` (${dbProbes.length} DB follow-up)` : ''}`,
                ),
            ],
        };
    } catch (err) {
        logger.error({ err, runId: state.request.runId, node: 'replan' }, 'replan node failed');
        return {
            errors: [`replan failed: ${String(err)}`],
            timeline: [stepLog('replan', 'failed', Date.now() - t0)],
        };
    }
}
