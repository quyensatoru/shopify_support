import Anthropic from '@anthropic-ai/sdk';
import type { SupportStateType } from '../state.js';
import type { Evidence, ProbeResult, Synthesis } from '@shopify-support/shared';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../../env.js';
import { stepLog } from '../utils.js';
import { logger } from '../../observability/logger.js';
import {
    INVESTIGATION_TOOLS,
    executeProbeTool,
    type ProbeToolInput,
    type SubmitFindingsInput,
} from '../agent/tools.js';

const MODEL = 'claude-sonnet-4-6';

function evidenceFromResult(r: ProbeResult): Evidence | null {
    if (r.status !== 'done') return null;
    return {
        id: randomUUID(),
        surface: r.surface,
        claim: r.found
            ? `[${r.surface}] ${r.action}: found`
            : `[${r.surface}] ${r.action}: NOT found / empty`,
        value: r.data,
        refs: [r.probeId],
        source: r.provenance,
        polarity: r.found ? 'positive' : 'negative',
    };
}

function buildContext(state: SupportStateType): string {
    const { request, appConfig } = state;
    const repos = (appConfig?.repos ?? [])
        .map((r) => (r.role ? `${r.name} — ${r.role}` : r.name))
        .join('; ');
    const dbs = (appConfig?.dbSources ?? []).map((d) => `${d.key}(${d.type})`).join(', ');
    const ids = (request.identifiers ?? []).map((i) => `${i.kind}=${i.value}`).join(', ');
    const codeSyms = (state.codeContexts ?? [])
        .flatMap((c) =>
            c.relevantSymbols.slice(0, 8).map((s) => `  ${c.repo}: ${s.kind} ${s.name} @ ${s.file}${s.line ? `:${s.line}` : ''}`),
        )
        .join('\n');
    const knowledge = (state.appKnowledge ?? [])
        .slice(0, 4)
        .map((k) => `- ${k.title}: ${k.chunk.slice(0, 200)}`)
        .join('\n');

    return [
        `App: ${request.app}`,
        `Issue: ${request.issueText}`,
        request.storeUrl ? `Store URL: ${request.storeUrl}` : '',
        ids ? `Identifiers: ${ids}` : '',
        repos ? `Repos (with roles): ${repos}` : '',
        dbs ? `DB sources: ${dbs}` : '',
        state.searchKeywords?.length ? `Technical keywords: ${state.searchKeywords.join(', ')}` : '',
        codeSyms ? `\nRelevant code symbols:\n${codeSyms}` : '',
        knowledge ? `\nApp knowledge:\n${knowledge}` : '',
        `\nInvestigate the issue by running read-only probes. Look up ids before querying data tables keyed by them. When confident (or out of useful probes), call submit_findings. Write rootCause/recommendedFix in the SAME language as the Issue.`,
    ]
        .filter(Boolean)
        .join('\n');
}

/**
 * Bounded-agency investigation loop (alternative to the structured plan→diagnose→analyze core).
 * The model freely chooses read-only probes step by step, observing each result, until it
 * submits findings or hits the step budget. Side-effects remain impossible (read-only tools).
 */
export async function investigateLoopNode(state: SupportStateType) {
    const t0 = Date.now();
    const env = getEnv();
    if (!env.ANTHROPIC_API_KEY) {
        return {
            errors: ['investigate_loop: ANTHROPIC_API_KEY required for agentic mode'],
            timeline: [stepLog('investigate_loop', 'failed', Date.now() - t0, 'no ANTHROPIC_API_KEY')],
        };
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const maxSteps = env.INVESTIGATION_MAX_STEPS;
    const system =
        'You are a Shopify app support engineer doing root-cause analysis. You can ONLY run read-only probes (no writes, no side-effects). Be efficient: each probe should test a specific hypothesis. Use earlier results to decide the next probe (e.g. resolve shop_id from domain before querying data). Negative results (not found / empty) are valuable evidence. Stop and call submit_findings as soon as you can name the root cause or you run out of useful probes.';

    const messages: Anthropic.Messages.MessageParam[] = [
        { role: 'user', content: buildContext(state) },
    ];

    const probeResults: ProbeResult[] = [];
    const evidence: Evidence[] = [];
    let synthesis: Synthesis | undefined;
    let steps = 0;

    try {
        while (steps < maxSteps) {
            steps++;
            const resp = await client.messages.create({
                model: MODEL,
                max_tokens: 4096,
                system,
                tools: INVESTIGATION_TOOLS,
                messages,
            });

            messages.push({ role: 'assistant', content: resp.content });

            const toolUses = resp.content.filter(
                (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
            );

            if (!toolUses.length) break; // model returned text without a tool → stop

            const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
            let submitted = false;

            for (const tu of toolUses) {
                if (tu.name === 'submit_findings') {
                    const f = tu.input as SubmitFindingsInput;
                    synthesis = {
                        verdicts: [],
                        rootCause: f.rootCause,
                        confidence: f.confidence,
                        recommendedFix: f.recommendedFix,
                        nextSteps: f.nextSteps ?? [],
                    };
                    submitted = true;
                    toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'recorded' });
                    continue;
                }
                // run_probe
                try {
                    const result = await executeProbeTool(tu.input as ProbeToolInput, {
                        appConfig: state.appConfig,
                        request: state.request,
                        codeContexts: state.codeContexts,
                    });
                    probeResults.push(result);
                    const ev = evidenceFromResult(result);
                    if (ev) evidence.push(ev);
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: tu.id,
                        content: JSON.stringify({
                            status: result.status,
                            found: result.found,
                            provenance: result.provenance,
                            data: result.data,
                            reason: result.reason,
                        }).slice(0, 6000),
                    });
                } catch (err) {
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: tu.id,
                        content: `error: ${String(err).slice(0, 300)}`,
                        is_error: true,
                    });
                }
            }

            messages.push({ role: 'user', content: toolResults });
            if (submitted) break;
        }
    } catch (err) {
        logger.error({ err, runId: state.request.runId }, 'investigate_loop failed');
        return {
            probeResults,
            evidence,
            errors: [`investigate_loop failed: ${String(err)}`],
            timeline: [stepLog('investigate_loop', 'failed', Date.now() - t0, `${steps} steps`)],
        };
    }

    // Budget hit without explicit findings → low-confidence summary from what we have.
    if (!synthesis) {
        synthesis = {
            verdicts: [],
            rootCause:
                'Investigation did not converge within the step budget. Review collected evidence for partial signals.',
            confidence: 'low',
            nextSteps: ['Increase INVESTIGATION_MAX_STEPS or narrow the issue scope.'],
        };
    }

    return {
        normalized: state.normalized ?? {
            caseType: 'unknown' as const,
            restatement: state.request.issueText,
            identifiers: state.request.identifiers ?? [],
            severity: state.request.severity ?? ('normal' as const),
        },
        probeResults,
        evidence,
        synthesis,
        strongSignal: evidence.some((e) => e.polarity === 'positive'),
        timeline: [
            stepLog(
                'investigate_loop',
                'completed',
                Date.now() - t0,
                `${steps} steps, ${probeResults.length} probes, confidence=${synthesis.confidence}`,
            ),
        ],
    };
}
