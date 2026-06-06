import type { Probe, ProbeResult, ResolvedAppConfig } from '@shopify-support/shared';

export async function investigateConfig(
  probe: Probe,
  appConfig: ResolvedAppConfig | undefined,
): Promise<ProbeResult> {
  const base = { probeId: probe.id, surface: probe.surface as 'config', action: probe.action };

  if (!appConfig) {
    return { ...base, status: 'skipped', found: false, data: null, reason: 'App config not available', provenance: 'config:none' };
  }

  if (probe.action === 'get_app_config') {
    const key = probe.target['key'];
    const value = key ? appConfig.expectedConfig[key] : appConfig.expectedConfig;
    return { ...base, status: 'done', found: value !== undefined, data: value ?? null, provenance: `config:${key ?? 'all'}` };
  }

  if (probe.action === 'diff_expected') {
    const expected = appConfig.expectedConfig;
    const diffs: Array<{ key: string; expected: unknown; actual: string }> = [];
    // surface: compare expected config vs what's resolvable
    for (const [key, expectedVal] of Object.entries(expected)) {
      diffs.push({ key, expected: expectedVal, actual: '(runtime value — not checked at planning time)' });
    }
    return { ...base, status: 'done', found: diffs.length > 0, data: diffs, provenance: 'config:diff_expected' };
  }

  return { ...base, status: 'skipped', found: false, data: null, reason: `Unknown config action: ${probe.action}`, provenance: 'config' };
}
