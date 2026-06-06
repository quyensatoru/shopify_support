import type { SupportStateType } from '../state.js';
import { runFixPlanReasoning } from '../../reasoning/fixPlan.js';
import { stepLog } from '../utils.js';

export async function fixPlanNode(state: SupportStateType) {
    const t0 = Date.now();
    try {
        const fixPlan = await runFixPlanReasoning({
            app: state.request.app,
            issueText: state.request.issueText,
            synthesis: state.synthesis!,
            evidence: state.evidence,
            appConfig: state.appConfig,
        });

        return {
            fixPlan,
            approval: { required: true, status: 'pending' as const },
            timeline: [
                stepLog(
                    'fixPlan',
                    'completed',
                    Date.now() - t0,
                    `${fixPlan.changes.length} changes, risk=${fixPlan.risk}`,
                ),
            ],
        };
    } catch (err) {
        return {
            errors: [`fixPlan failed: ${String(err)}`],
            timeline: [stepLog('fixPlan', 'failed', Date.now() - t0)],
        };
    }
}
