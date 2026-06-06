import type { Probe, ProbeResult, ResolvedAppConfig } from '@shopify-support/shared';
import { queryLogs } from '../connectors/logs.js';

export async function investigateLogs(
  probe: Probe,
  appConfig: ResolvedAppConfig | undefined,
): Promise<ProbeResult> {
  const base = { probeId: probe.id, surface: probe.surface as 'logs', action: probe.action };

  if (!appConfig?.logSources?.length) {
    return { ...base, status: 'skipped', found: false, data: null, reason: 'logSources not configured (optional)', provenance: 'logs:none' };
  }

  const sourceKey = probe.target['source'];
  const source = sourceKey
    ? appConfig.logSources.find((s) => s.key === sourceKey)
    : appConfig.logSources[0];

  if (!source) {
    return { ...base, status: 'skipped', found: false, data: null, reason: `Log source "${sourceKey}" not found`, provenance: 'logs:sources' };
  }

  try {
    const lines = await queryLogs(source, {
      keyword: probe.target['keyword'],
      level: probe.target['level'],
      timeWindowMinutes: probe.target['timeWindowMinutes'] ? Number(probe.target['timeWindowMinutes']) : 60,
    });

    return {
      ...base,
      status: 'done',
      found: lines.length > 0,
      data: lines.slice(0, 50),
      provenance: `logs:${source.key}(${source.type}) keyword=${probe.target['keyword']}`,
    };
  } catch (err) {
    return { ...base, status: 'failed', found: false, data: null, reason: String(err), provenance: `logs:${source.key}` };
  }
}
