import type { SupportStateType } from '../state.js';
import { runAnalyzeReasoning } from '../../reasoning/analyze.js';
import { stepLog } from '../utils.js';

export async function analyzeNode(state: SupportStateType) {
    const t0 = Date.now();

    try {
        const synthesis = await runAnalyzeReasoning({
            app: state.request.app,
            issueText: state.request.issueText,
            caseType: state.normalized?.caseType ?? 'unknown',
            hypotheses: state.hypotheses,
            evidence: state.evidence,
            missingContext: state.missingContext,
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
        return {
            errors: [`analyze failed: ${String(err)}`],
            timeline: [stepLog('analyze', 'failed', Date.now() - t0)],
        };
    }
}
