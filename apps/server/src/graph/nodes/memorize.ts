import type { SupportStateType } from '../state.js';
import { runDistillReasoning } from '../../reasoning/distill.js';
import { writeMemory } from '../../memory/index.js';
import { stepLog } from '../utils.js';

export async function memorizeNode(state: SupportStateType) {
  const t0 = Date.now();

  if (!state.synthesis) {
    return {
      timeline: [stepLog('memorize', 'skipped', Date.now() - t0, 'No synthesis to memorize')],
    };
  }

  try {
    const memory = await runDistillReasoning({
      app: state.request.app,
      runId: state.request.runId,
      caseType: state.normalized?.caseType ?? 'unknown',
      issueText: state.request.issueText,
      synthesis: state.synthesis,
      artifacts: state.artifacts,
    });

    await writeMemory(memory);

    return {
      newMemories: [memory],
      timeline: [stepLog('memorize', 'completed', Date.now() - t0, `Saved case memory: ${memory.title}`)],
    };
  } catch (err) {
    // Memorize failure is non-fatal
    return {
      errors: [`memorize failed (non-fatal): ${String(err)}`],
      timeline: [stepLog('memorize', 'failed', Date.now() - t0)],
    };
  }
}
