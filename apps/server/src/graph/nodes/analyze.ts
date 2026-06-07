import type { SupportStateType } from '../state.js';
import { runAnalyzeReasoning } from '../../reasoning/analyze.js';
import { stepLog } from '../utils.js';
import { logger } from '../../observability/logger.js';

export async function analyzeNode(state: SupportStateType) {
    const t0 = Date.now();

    if (!state.hypotheses.length) {
        logger.warn({ runId: state.request.runId, node: 'analyze' }, 'analyze skipped — no hypotheses');
        return {
            timeline: [stepLog('analyze', 'skipped', Date.now() - t0, 'no hypotheses from planner')],
        };
    }

    try {
        const synthesis = await runAnalyzeReasoning({
            app: state.request.app,
            issueText: state.request.issueText,
            caseType: state.normalized?.caseType ?? 'unknown',
            hypotheses: state.hypotheses,
            evidence: state.evidence,
            missingContext: state.missingContext,
            codeContexts: state.codeContexts,
        });

        return {
            synthesis,
            timeline: [
                stepLog(
                    'analyze',
                    'completed',
                    Date.now() - t0,
                    `confidence=${synthesis.confidence}, rootCause: ${synthesis.rootCause.slice(0, 80)}...`,
                ),
            ],
        };
    } catch (err) {
        logger.error({ err, runId: state.request.runId, node: 'analyze' }, 'analyze node failed');
        return {
            errors: [`analyze failed: ${String(err)}`],
            timeline: [stepLog('analyze', 'failed', Date.now() - t0)],
        };
    }
}
