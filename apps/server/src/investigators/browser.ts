import type { Probe, ProbeResult, RunRequest } from '@shopify-support/shared';
import { renderPage } from '../connectors/playwright.js';

export async function investigateBrowser(
  probe: Probe,
  request: RunRequest,
): Promise<ProbeResult> {
  const base = { probeId: probe.id, surface: probe.surface as 'browser', action: probe.action };
  const url = probe.target['url'] ?? request.storeUrl;

  if (!url) {
    return { ...base, status: 'skipped', found: false, data: null, reason: 'No URL available for browser probe', provenance: 'browser:missing_url' };
  }

  try {
    const page = await renderPage(url);

    if (probe.action === 'check_markers') {
      const marker = probe.target['marker'];
      if (!marker) return { ...base, status: 'skipped', found: false, data: null, reason: 'No marker to check', provenance: `browser:${url}` };
      const found = page.html.includes(marker) || page.scripts.some((s) => s.includes(marker));
      return {
        ...base,
        status: 'done',
        found,
        data: { marker, found, consoleErrors: page.consoleErrors.slice(0, 10) },
        provenance: `browser:${url}`,
      };
    }

    // action=render: return full page signals
    return {
      ...base,
      status: 'done',
      found: true,
      data: {
        title: page.title,
        status: page.status,
        consoleErrors: page.consoleErrors.slice(0, 20),
        networkErrors: page.networkErrors.slice(0, 10),
        scripts: page.scripts.slice(0, 20),
      },
      provenance: `browser:${url}`,
    };
  } catch (err) {
    return { ...base, status: 'failed', found: false, data: null, reason: String(err), provenance: `browser:${url}` };
  }
}
