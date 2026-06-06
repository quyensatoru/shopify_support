import { interrupt } from '@langchain/langgraph';
import type { SupportStateType } from '../state.js';
import type { Approval } from '@shopify-support/shared';
import { stepLog } from '../utils.js';

export async function approveNode(state: SupportStateType) {
    const t0 = Date.now();

    const answer = interrupt({
        reason: 'need_approval',
        question: 'Review the fix plan and decide: approve or reject.',
        fixPlan: state.fixPlan,
        synthesis: state.synthesis,
    }) as { decision: 'approve' | 'reject'; note?: string; approver?: string };

    const approval: Approval = {
        required: true,
        status: answer.decision === 'approve' ? 'approved' : 'rejected',
        approver: answer.approver,
        note: answer.note,
    };

    return {
        approval,
        status: approval.status === 'approved' ? ('running' as const) : ('running' as const),
        timeline: [
            stepLog(
                'approve',
                approval.status === 'approved' ? 'completed' : 'skipped',
                Date.now() - t0,
                `decision=${answer.decision}`,
            ),
        ],
    };
}
