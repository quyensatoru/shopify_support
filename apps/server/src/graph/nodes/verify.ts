import type { SupportStateType } from '../state.js';
import type { VerifyResult } from '@shopify-support/shared';
import { dispatchInvestigator } from '../../investigators/index.js';
import { stepLog } from '../utils.js';

export async function verifyNode(state: SupportStateType) {
  const t0 = Date.now();

  if (!state.fixPlan?.verification.length) {
    return {
      verification: [],
      timeline: [stepLog('verify', 'skipped', Date.now() - t0, 'No verification steps')],
    };
  }

  const results: VerifyResult[] = await Promise.all(
    state.fixPlan.verification.map(async (step, idx) => {
      try {
        const probe = {
          id: `verify-${idx}`,
          surface: step.surface,
          action: step.action,
          target: step.target,
          hint: step.expectedOutcome,
          hypothesisIds: [],
          status: 'pending' as const,
        };
        const result = await dispatchInvestigator(probe, state.appConfig, state.request);
        const pass = result.status === 'done' && result.found;
        return { stepIdx: idx, surface: step.surface, status: pass ? ('pass' as const) : ('fail' as const), detail: pass ? 'Verified' : (result.reason ?? 'Not found') };
      } catch (err) {
        return { stepIdx: idx, surface: step.surface, status: 'fail' as const, detail: String(err) };
      }
    }),
  );

  const passCount = results.filter((r) => r.status === 'pass').length;
  return {
    verification: results,
    timeline: [stepLog('verify', 'completed', Date.now() - t0, `${passCount}/${results.length} checks passed`)],
  };
}
