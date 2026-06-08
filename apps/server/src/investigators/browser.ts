import type { Probe, ProbeResult, RunRequest, CodeContext } from '@shopify-support/shared';
import { renderPage } from '../connectors/playwright.js';

function extractCspFrameAncestors(headers: Record<string, string>): string | null {
    const csp =
        headers['content-security-policy'] ?? headers['content-security-policy-report-only'] ?? '';
    const match = /frame-ancestors\s+([^;]+)/i.exec(csp);
    return match ? match[1]!.trim() : null;
}

function detectAppBridge(scripts: string[], html: string): boolean {
    return (
        scripts.some((s) => s.includes('app-bridge') || s.includes('app_bridge')) ||
        html.includes('@shopify/app-bridge') ||
        (html.includes('createApp') && html.includes('shopify')) ||
        html.includes('AppBridge')
    );
}

function network4xxOr5xx(networkErrors: string[]): string[] {
    return networkErrors.filter((e) => /\s[45]\d{2}\b/.test(e) || /40[0-9]|5\d{2}/.test(e));
}

export async function investigateBrowser(
    probe: Probe,
    request: RunRequest,
    codeContexts?: CodeContext[],
): Promise<ProbeResult> {
    const base = { probeId: probe.id, surface: probe.surface as 'browser', action: probe.action };
    const url = (probe.target['url'] as string | undefined) ?? request.storeUrl;

    if (!url) {
        return {
            ...base,
            status: 'skipped',
            found: false,
            data: null,
            reason: 'No URL available for browser probe',
            provenance: 'browser:missing_url',
        };
    }

    try {
        const page = await renderPage(url);

        const frameAncestors = extractCspFrameAncestors(page.responseHeaders);
        const appBridgePresent = detectAppBridge(page.scripts, page.html);
        const networkIssues = network4xxOr5xx(page.networkErrors);
        const richSignals = {
            httpStatus: page.status,
            frameAncestors,
            appBridgePresent,
            consoleErrors: page.consoleErrors.slice(0, 15),
            networkIssues: networkIssues.slice(0, 10),
            scriptCount: page.scripts.length,
        };

        if (probe.action === 'check_markers') {
            const explicitMarker = probe.target['marker'] as string | undefined;
            const groundedMarkers: string[] = explicitMarker
                ? [explicitMarker]
                : (codeContexts ?? []).flatMap((ctx) => ctx.expectedMarkers).slice(0, 10);

            if (!groundedMarkers.length) {
                return {
                    ...base,
                    status: 'skipped',
                    found: false,
                    data: null,
                    reason: 'No markers to check: probe.target.marker not set and codeContext.expectedMarkers is empty',
                    provenance: `browser:${url}`,
                };
            }

            const markerResults = groundedMarkers.map((marker) => ({
                marker,
                foundInHtml: page.html.includes(marker),
                foundInScripts: page.scripts.some((s) => s.includes(marker)),
            }));
            const anyFound = markerResults.some((m) => m.foundInHtml || m.foundInScripts);

            return {
                ...base,
                status: 'done',
                found: anyFound,
                data: { markers: markerResults, ...richSignals },
                provenance: `browser:${url}`,
            };
        }

        // ── action: render (full page signals) ────────────────────────
        return {
            ...base,
            status: 'done',
            found: page.status > 0 && page.status < 500,
            data: {
                title: page.title,
                scripts: page.scripts,
                ...richSignals,
            },
            provenance: `browser:${url}`,
        };
    } catch (err) {
        return {
            ...base,
            status: 'failed',
            found: false,
            data: null,
            reason: String(err),
            provenance: `browser:${url}`,
        };
    }
}
