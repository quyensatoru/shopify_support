import { interrupt } from '@langchain/langgraph';
import type { SupportStateType } from '../state.js';
import type { Probe } from '@shopify-support/shared';
import { needsRefine } from './probeRefine.js';

// ── After plan ───────────────────────────────────────────────────────

function blockingMissingContext(state: SupportStateType): string[] {
    if (!state.request.interactive) return [];
    return state.missingContext;
}

export function decideAfterPlan(state: SupportStateType): 'ask_context' | 'diagnose' | 'memorize' {
    if (!state.plan) return 'memorize';
    const blocking = blockingMissingContext(state);
    if (blocking.length > 0) return 'ask_context';
    return 'diagnose';
}

export async function askContextNode(state: SupportStateType) {
    const question = state.missingContext.join('\n');
    const answer = interrupt({
        reason: 'need_context',
        question,
        missingContext: state.missingContext,
    });
    // Merge answer back into request metadata
    return {
        request: {
            ...state.request,
            metadata: { ...state.request.metadata, providedContext: answer },
        },
        missingContext: [],
        status: 'running' as const,
    };
}

// ── After diagnose ────────────────────────────────────────────────────

function hasPendingProbes(state: SupportStateType): boolean {
    if (!state.plan) return false;
    const doneIds = new Set(state.probeResults.map((r) => r.probeId));
    return state.plan.probes.some((p: Probe) => p.status === 'pending' && !doneIds.has(p.id));
}

export function decideAfterDiagnose(
    state: SupportStateType,
): 'diagnose' | 'refine_probes' | 'analyze' {
    // Run any probes still pending in the current batch first.
    if (hasPendingProbes(state)) return 'diagnose';
    // Deepen with DB query synthesis / env-trace before committing to analysis.
    if (needsRefine(state)) return 'refine_probes';
    return 'analyze';
}

// ── After analyze ─────────────────────────────────────────────────────

export function decideAfterAnalyze(state: SupportStateType): 'replan' | 'fix_planner' | 'memorize' {
    const { synthesis, iteration, request } = state;
    const maxIter = request.maxIterations ?? 3;

    // Low confidence + iterations remaining → replan
    if (synthesis?.confidence === 'low' && iteration < maxIter) return 'replan';

    // Fix mode + synthesis is actionable → fix_planner
    if (request.mode === 'fix' && synthesis?.recommendedFix) return 'fix_planner';

    // Otherwise: diagnose-only or not actionable
    return 'memorize';
}

// ── After agentic investigate_loop ────────────────────────────────────

export function decideAfterInvestigate(state: SupportStateType): 'fix_planner' | 'memorize' {
    if (state.request.mode === 'fix' && state.synthesis?.recommendedFix) return 'fix_planner';
    return 'memorize';
}

// ── After approve ─────────────────────────────────────────────────────

export function decideAfterApprove(state: SupportStateType): 'fixApply' | 'memorize' {
    return state.approval?.status === 'approved' ? 'fixApply' : 'memorize';
}
