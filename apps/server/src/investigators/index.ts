import type { Probe, ProbeResult, ResolvedAppConfig, RunRequest } from '@shopify-support/shared';
import { investigateCode } from './code.js';
import { investigateDatabase } from './database.js';
import { investigateLogs } from './logs.js';
import { investigateShopify } from './shopify.js';
import { investigateBrowser } from './browser.js';
import { investigateConfig } from './config.js';

export async function dispatchInvestigator(
  probe: Probe,
  appConfig: ResolvedAppConfig | undefined,
  request: RunRequest,
): Promise<ProbeResult> {
  const t0 = Date.now();

  const base = {
    probeId: probe.id,
    surface: probe.surface,
    action: probe.action,
    durationMs: 0,
  };

  let result: ProbeResult;

  switch (probe.surface) {
    case 'code':
      result = await investigateCode(probe, appConfig);
      break;
    case 'database':
      result = await investigateDatabase(probe, appConfig);
      break;
    case 'logs':
      result = await investigateLogs(probe, appConfig);
      break;
    case 'shopify':
      result = await investigateShopify(probe, appConfig, request);
      break;
    case 'browser':
      result = await investigateBrowser(probe, request);
      break;
    case 'config':
      result = await investigateConfig(probe, appConfig);
      break;
    default:
      result = { ...base, status: 'skipped', found: false, data: null, reason: `Unknown surface: ${probe.surface}`, provenance: probe.surface };
  }

  return { ...result, durationMs: Date.now() - t0 };
}
