import type { SupportStateType } from '../state.js';
import type { RunStatus, SupportRunOutput } from '@shopify-support/shared';
import { stepLog } from '../utils.js';

function deriveStatus(state: SupportStateType): RunStatus {
  if (state.errors.some((e) => !e.includes('non-fatal'))) {
    const hasOutput = Boolean(state.synthesis);
    return hasOutput ? 'partial' : 'failed';
  }
  if (state.request.mode === 'fix' && state.artifacts?.mrUrl) return 'completed';
  if (state.synthesis) return 'completed';
  return 'partial';
}

function buildSummary(state: SupportStateType): string {
  if (state.synthesis) {
    const conf = state.synthesis.confidence;
    const rc = state.synthesis.rootCause;
    return `[${conf}] ${rc}`;
  }
  return `Diagnostic run for "${state.request.issueText.slice(0, 80)}" — no synthesis produced.`;
}

export function finalizeNode(state: SupportStateType) {
  const t0 = Date.now();
  const status = deriveStatus(state);
  const summary = buildSummary(state);

  const output: SupportRunOutput = {
    runId: state.request.runId,
    threadId: state.request.threadId,
    app: state.request.app,
    issueText: state.request.issueText,
    mode: state.request.mode,
    status,
    caseType: state.normalized?.caseType,
    rootCause: state.synthesis?.rootCause,
    confidence: state.synthesis?.confidence,
    recommendedFix: state.synthesis?.recommendedFix,
    mrUrl: state.artifacts?.mrUrl,
    nextSteps: state.synthesis?.nextSteps ?? [],
    summary,
    timeline: [...state.timeline, stepLog('finalize', 'completed', Date.now() - t0)],
    missingContext: state.missingContext,
    errors: state.errors,
    completedAt: new Date().toISOString(),
  };

  return { output, status };
}
