import type { SupportStateType } from '../state.js';
import { runReplanReasoning } from '../../reasoning/plan.js';
import { stepLog } from '../utils.js';

export async function replanNode(state: SupportStateType) {
  const t0 = Date.now();
  try {
    const newProbes = await runReplanReasoning({
      app: state.request.app,
      issueText: state.request.issueText,
      existingPlan: state.plan,
      evidence: state.evidence,
      synthesis: state.synthesis,
      appConfig: state.appConfig,
    });

    const updatedPlan = {
      probes: [...(state.plan?.probes ?? []), ...newProbes],
      rationale: state.plan?.rationale ?? '',
    };

    return {
      plan: updatedPlan,
      iteration: 1,
      timeline: [stepLog('replan', 'completed', Date.now() - t0, `Added ${newProbes.length} new probes`)],
    };
  } catch (err) {
    return {
      errors: [`replan failed: ${String(err)}`],
      timeline: [stepLog('replan', 'failed', Date.now() - t0)],
    };
  }
}
