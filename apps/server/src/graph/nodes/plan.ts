import type { SupportStateType } from '../state.js';
import { runPlanReasoning } from '../../reasoning/plan.js';
import { stepLog } from '../utils.js';

export async function planNode(state: SupportStateType) {
    const t0 = Date.now();
    const { request, appConfig, retrievedMemories } = state;

    try {
        const result = await runPlanReasoning({
            app: request.app,
            issueText: request.issueText,
            storeDomain: request.storeDomain,
            storeUrl: request.storeUrl,
            identifiers: request.identifiers,
            appConfig,
            retrievedMemories,
        });

        return {
            normalized: result.normalized,
            hypotheses: result.hypotheses,
            plan: result.plan,
            missingContext: result.missingContext,
            timeline: [
                stepLog(
                    'plan',
                    'completed',
                    Date.now() - t0,
                    `caseType=${result.normalized.caseType}, ${result.hypotheses.length} hypotheses, ${result.plan.probes.length} probes`,
                ),
            ],
        };
    } catch (err) {
        return {
            errors: [`plan failed: ${String(err)}`],
            timeline: [stepLog('plan', 'failed', Date.now() - t0)],
        };
    }
}
