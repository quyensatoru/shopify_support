import type { SupportStateType } from '../state.js';
import type { Probe, ProbeResult, Evidence } from '@shopify-support/shared';
import { dispatchInvestigator } from '../../investigators/index.js';
import { stepLog } from '../utils.js';
import { randomUUID } from 'node:crypto';

function pendingProbes(state: SupportStateType): Probe[] {
  if (!state.plan) return [];
  const doneIds = new Set(state.probeResults.map((r) => r.probeId));
  return state.plan.probes.filter((p) => p.status === 'pending' && !doneIds.has(p.id));
}

function evidenceFromResult(result: ProbeResult): Evidence | null {
  if (!result.found || result.status !== 'done') return null;
  return {
    id: randomUUID(),
    surface: result.surface,
    claim: `[${result.surface}] ${result.action}: found`,
    value: result.data,
    refs: [result.probeId],
    source: result.provenance,
  };
}

function isStrongSignal(results: ProbeResult[]): boolean {
  // Strong signal: any code probe found something concrete
  return results.some((r) => r.surface === 'code' && r.found && r.status === 'done');
}

export async function diagnoseNode(state: SupportStateType) {
  const t0 = Date.now();
  const batch = pendingProbes(state);

  if (!batch.length) {
    return {
      timeline: [stepLog('diagnose', 'skipped', Date.now() - t0, 'No pending probes')],
    };
  }

  // Mark probes as running
  const updatedProbes = (state.plan?.probes ?? []).map((p) =>
    batch.find((b) => b.id === p.id) ? { ...p, status: 'running' as const } : p,
  );

  // Dispatch all probes in parallel
  const results = await Promise.all(
    batch.map((probe) =>
      dispatchInvestigator(probe, state.appConfig, state.request).catch(
        (err): ProbeResult => ({
          probeId: probe.id,
          surface: probe.surface,
          action: probe.action,
          status: 'failed',
          found: false,
          data: null,
          reason: String(err),
          provenance: `${probe.surface}:${probe.action}`,
          durationMs: 0,
        }),
      ),
    ),
  );

  // Mark probes as done/skipped/failed
  const finalProbes = (state.plan?.probes ?? []).map((p) => {
    const r = results.find((res) => res.probeId === p.id);
    if (!r) return p;
    return { ...p, status: r.status === 'done' ? ('done' as const) : r.status === 'skipped' ? ('skipped' as const) : ('failed' as const) };
  });

  const newEvidence = results.flatMap((r) => {
    const ev = evidenceFromResult(r);
    return ev ? [ev] : [];
  });

  const strong = isStrongSignal(results);
  const doneCount = results.filter((r) => r.status === 'done').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;

  return {
    plan: state.plan ? { ...state.plan, probes: finalProbes } : undefined,
    probeResults: results,
    evidence: newEvidence,
    strongSignal: strong,
    timeline: [
      stepLog(
        'diagnose',
        'completed',
        Date.now() - t0,
        `${batch.length} probes run: ${doneCount} done, ${skippedCount} skipped${strong ? ' [STRONG SIGNAL]' : ''}`,
      ),
    ],
  };
}
