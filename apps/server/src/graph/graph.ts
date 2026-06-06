import {
  START,
  END,
  StateGraph,
  Command,
  type CompiledStateGraph,
} from '@langchain/langgraph';
import { SupportState } from './state.js';
import { getCheckpointer } from './checkpointer.js';
import { intakeNode } from './nodes/intake.js';
import { planNode } from './nodes/plan.js';
import { diagnoseNode } from './nodes/diagnose.js';
import { analyzeNode } from './nodes/analyze.js';
import { replanNode } from './nodes/replan.js';
import { fixPlanNode } from './nodes/fixPlan.js';
import { approveNode } from './nodes/approve.js';
import { fixApplyNode } from './nodes/fixApply.js';
import { verifyNode } from './nodes/verify.js';
import { memorizeNode } from './nodes/memorize.js';
import { finalizeNode } from './nodes/finalize.js';
import {
  decideAfterPlan,
  askContextNode,
  decideAfterDiagnose,
  decideAfterAnalyze,
  decideAfterApprove,
} from './nodes/decide.js';
import type { RunRequest, SupportRunOutput, StreamEvent } from '@shopify-support/shared';
import { logger } from '../observability/logger.js';

// Build & compile the graph (lazy singleton)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _compiled: CompiledStateGraph<any, any, any> | undefined;

function buildGraph() {
  const wf = new StateGraph(SupportState)
    .addNode('intake', intakeNode)
    .addNode('planner', planNode)
    .addNode('ask_context', askContextNode)
    .addNode('diagnose', diagnoseNode)
    .addNode('analyze', analyzeNode)
    .addNode('replan', replanNode)
    .addNode('fix_planner', fixPlanNode)
    .addNode('approve', approveNode)
    .addNode('fixApply', fixApplyNode)
    .addNode('verify', verifyNode)
    .addNode('memorize', memorizeNode)
    .addNode('finalize', finalizeNode)

    .addEdge(START, 'intake')
    .addEdge('intake', 'planner')
    .addConditionalEdges('planner', decideAfterPlan, {
      ask_context: 'ask_context',
      diagnose: 'diagnose',
    })
    .addEdge('ask_context', 'diagnose')
    .addConditionalEdges('diagnose', decideAfterDiagnose, {
      diagnose: 'diagnose',
      analyze: 'analyze',
    })
    .addConditionalEdges('analyze', decideAfterAnalyze, {
      replan: 'replan',
      fix_planner: 'fix_planner',
      memorize: 'memorize',
    })
    .addEdge('replan', 'diagnose')
    .addEdge('fix_planner', 'approve')
    .addConditionalEdges('approve', decideAfterApprove, {
      fixApply: 'fixApply',
      memorize: 'memorize',
    })
    .addEdge('fixApply', 'verify')
    .addEdge('verify', 'memorize')
    .addEdge('memorize', 'finalize')
    .addEdge('finalize', END);

  return wf; // compile happens after checkpointer is ready
}

async function getCompiledGraph() {
  if (_compiled) return _compiled;
  const checkpointer = await getCheckpointer();
  _compiled = buildGraph().compile({ checkpointer });
  return _compiled;
}

// ── Types ──────────────────────────────────────────────────────────────
export type GraphRunResult =
  | { status: 'completed'; threadId: string; output: SupportRunOutput }
  | { status: 'interrupted'; threadId: string; interrupts: Array<{ value?: unknown }> }
  | { status: 'failed'; threadId: string; error: string };

// ── Invoke (fire & forget, used by HTTP route) ─────────────────────────
export async function invokeSupportGraphStep(
  request: Omit<RunRequest, 'runId' | 'threadId'> & { runId: string; threadId: string },
): Promise<GraphRunResult> {
  const graph = await getCompiledGraph();
  const config = { configurable: { thread_id: request.threadId }, recursionLimit: 50 };

  try {
    const result = await graph.invoke({ request }, config) as Record<string, unknown>;
    const interrupts = result['__interrupt__'] as Array<{ value?: unknown }> | undefined;
    if (interrupts?.length) {
      return { status: 'interrupted', threadId: request.threadId, interrupts };
    }
    if (!result['output']) throw new Error('Graph produced no output');
    return { status: 'completed', threadId: request.threadId, output: result['output'] as SupportRunOutput };
  } catch (err) {
    logger.error({ err, threadId: request.threadId }, 'Graph invocation failed');
    return { status: 'failed', threadId: request.threadId, error: String(err) };
  }
}

// ── Resume ─────────────────────────────────────────────────────────────
export async function resumeSupportGraphStep(
  threadId: string,
  resume: unknown,
): Promise<GraphRunResult> {
  const graph = await getCompiledGraph();
  const config = { configurable: { thread_id: threadId }, recursionLimit: 50 };

  try {
    const result = await graph.invoke(new Command({ resume }), config) as Record<string, unknown>;
    const interrupts = result['__interrupt__'] as Array<{ value?: unknown }> | undefined;
    if (interrupts?.length) {
      return { status: 'interrupted', threadId, interrupts };
    }
    if (!result['output']) throw new Error('Graph produced no output after resume');
    return { status: 'completed', threadId, output: result['output'] as SupportRunOutput };
  } catch (err) {
    return { status: 'failed', threadId, error: String(err) };
  }
}

// ── Stream ─────────────────────────────────────────────────────────────
export async function* streamSupportGraph(params: {
  threadId: string;
  request?: RunRequest;
  resume?: unknown;
}): AsyncGenerator<StreamEvent> {
  const graph = await getCompiledGraph();
  const config = { configurable: { thread_id: params.threadId }, recursionLimit: 50 };
  const now = () => new Date().toISOString();

  const payload =
    params.resume !== undefined
      ? new Command({ resume: params.resume })
      : ({ request: params.request } as Parameters<typeof graph.stream>[0]);

  let interruptValue: unknown;
  const stream = await graph.stream(payload, { ...config, streamMode: 'updates' });

  for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
    if (Array.isArray(chunk['__interrupt__'])) {
      interruptValue = (chunk['__interrupt__'] as Array<{ value?: unknown }>)[0]?.value;
      continue;
    }
    for (const [node, update] of Object.entries(chunk)) {
      const upd = update as Record<string, unknown> | undefined;
      const lastStep = (upd?.['timeline'] as Array<{ status?: string }> | undefined)?.at(-1);
      yield {
        type: 'step',
        node,
        status: (lastStep?.status as StreamEvent extends { type: 'step' } ? StreamEvent['status'] : never) ?? 'completed',
        summary: (upd?.['synthesis'] as { summary?: string } | undefined)?.summary,
        ts: now(),
      };
    }
  }

  const snapshot = await graph.getState(config);
  const taskInterrupt = (snapshot.tasks as Array<{ interrupts?: Array<{ value?: unknown }> }> | undefined)
    ?.find((t) => (t.interrupts?.length ?? 0) > 0)
    ?.interrupts?.[0]?.value;
  const iv = interruptValue ?? taskInterrupt;

  if (iv !== undefined) {
    const v = iv as { reason?: string; question?: string };
    yield {
      type: 'interrupt',
      reason: (v.reason as 'need_context' | 'need_approval') ?? 'need_context',
      question: v.question ?? JSON.stringify(iv),
      value: iv,
      ts: now(),
    };
    return;
  }

  const output = snapshot.values?.['output'] as SupportRunOutput | undefined;
  if (output) {
    yield { type: 'output', output, ts: now() };
  }
}
