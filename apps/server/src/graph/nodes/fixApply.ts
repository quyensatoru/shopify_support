import type { SupportStateType } from '../state.js';
import { applyFix } from '../../connectors/gitlab.js';
import { stepLog } from '../utils.js';

export async function fixApplyNode(state: SupportStateType) {
    const t0 = Date.now();
    if (!state.fixPlan || !state.appConfig) {
        return {
            errors: ['fixApply: missing fixPlan or appConfig'],
            timeline: [
                stepLog('fixApply', 'skipped', Date.now() - t0, 'Missing fixPlan or appConfig'),
            ],
        };
    }

    try {
        const artifacts = await applyFix({
            fixPlan: state.fixPlan,
            appConfig: state.appConfig,
            runId: state.request.runId,
        });

        return {
            artifacts,
            timeline: [
                stepLog(
                    'fixApply',
                    'completed',
                    Date.now() - t0,
                    artifacts.mrUrl ? `MR: ${artifacts.mrUrl}` : 'Fix applied',
                ),
            ],
        };
    } catch (err) {
        return {
            errors: [`fixApply failed: ${String(err)}`],
            timeline: [stepLog('fixApply', 'failed', Date.now() - t0)],
        };
    }
}
