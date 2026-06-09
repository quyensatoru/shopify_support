import zlib from 'node:zlib';
import { searchCode, cloneOrPull } from './gitlab.js';
import type { RepoConfig, ResolvedAppConfig } from '@shopify-support/shared';
import { getEnv } from '../env.js';
import path from 'node:path';

/**
 * Snapshot connector for session-recording apps (heatmaps, session replay).
 *
 * Recordings are stored as a COMPRESSED string in the app's DB. To diagnose
 * "blank canvas / nothing renders" cases we must:
 *   1. discover how the app compresses + renders the snapshot (grounded in its
 *      own code, since the algorithm varies: lz-string, pako/gzip, brotli, …),
 *   2. decompress to the full snapshot,
 *   3. structurally analyze it (cheap), and optionally
 *   4. rebuild + render it headless to see where it breaks.
 */

// ── 1. Pipeline discovery (deterministic code grep) ───────────────────

export type SnapshotPipeline = {
    libraries: string[]; // detected compression/replay libs
    hits: Array<{ file: string; line: number; snippet: string }>;
    likelyAlgorithm: 'lz-string' | 'gzip' | 'brotli' | 'deflate' | 'unknown';
    isRrweb: boolean;
};

const PIPELINE_REGEX =
    'lz-string|LZString|decompressFrom|pako|fflate|inflate|gunzip|brotli|brotliDecompress|rrweb|Replayer|rrwebPlayer|takeFullSnapshot|rebuildSnapshot';

export async function discoverSnapshotPipeline(
    appConfig: ResolvedAppConfig | undefined,
): Promise<SnapshotPipeline> {
    const empty: SnapshotPipeline = {
        libraries: [],
        hits: [],
        likelyAlgorithm: 'unknown',
        isRrweb: false,
    };
    if (!appConfig?.repos?.length) return empty;

    const workspaceDir = getEnv().WORKSPACE_DIR;
    const repo = appConfig.repos[0] as RepoConfig;
    const repoPath = path.join(workspaceDir, repo.name);
    try {
        await cloneOrPull(repo, repoPath, appConfig.gitlab);
    } catch {
        return empty;
    }

    const matches = await searchCode(repoPath, '**/*.{ts,js,tsx,jsx,mjs,cjs}', PIPELINE_REGEX).catch(
        () => [] as Array<{ file: string; line: number }>,
    );

    const hits = matches.slice(0, 15).map((m) => ({
        file: String(m.file).replace(repoPath, ''),
        line: m.line,
        snippet: '',
    }));

    const blob = matches.map((m) => `${m.file}`).join(' ').toLowerCase();
    const libraries = new Set<string>();
    for (const lib of ['lz-string', 'pako', 'fflate', 'rrweb']) {
        if (blob.includes(lib)) libraries.add(lib);
    }

    let likelyAlgorithm: SnapshotPipeline['likelyAlgorithm'] = 'unknown';
    if (blob.includes('lz-string') || blob.includes('lzstring')) likelyAlgorithm = 'lz-string';
    else if (blob.includes('brotli')) likelyAlgorithm = 'brotli';
    else if (blob.includes('pako') || blob.includes('gunzip') || blob.includes('gzip'))
        likelyAlgorithm = 'gzip';
    else if (blob.includes('inflate') || blob.includes('fflate')) likelyAlgorithm = 'deflate';

    return {
        libraries: [...libraries],
        hits,
        likelyAlgorithm,
        isRrweb: blob.includes('rrweb'),
    };
}

// ── 2. Decompression (multi-strategy) ─────────────────────────────────

export type DecompressResult = {
    ok: boolean;
    strategy: string;
    full: unknown; // parsed JSON when possible, else the decompressed text
    text?: string;
    error?: string;
};

function tryJsonParse(text: string): { parsed?: unknown; isJson: boolean } {
    try {
        return { parsed: JSON.parse(text), isJson: true };
    } catch {
        return { isJson: false };
    }
}

async function lzStringDecompressors(): Promise<
    Array<{ name: string; fn: (s: string) => string | null }>
> {
    try {
        const mod = (await import('lz-string')) as unknown as {
            default?: Record<string, (s: string) => string | null>;
        } & Record<string, (s: string) => string | null>;
        const lz = mod.default ?? mod;
        return [
            { name: 'lz-string:base64', fn: lz.decompressFromBase64 },
            { name: 'lz-string:utf16', fn: lz.decompressFromUTF16 },
            { name: 'lz-string:encodedURI', fn: lz.decompressFromEncodedURIComponent },
            { name: 'lz-string:raw', fn: lz.decompress },
        ].filter((d) => typeof d.fn === 'function');
    } catch {
        return [];
    }
}

/** Try a sequence of decompression strategies; return the first that yields valid JSON,
 *  else the first that yields non-empty text. `preferred` (from pipeline discovery) is tried first. */
export async function decompressSnapshot(
    raw: string | Buffer,
    preferred?: SnapshotPipeline['likelyAlgorithm'],
): Promise<DecompressResult> {
    const asBuffer = (s: string | Buffer): Buffer =>
        Buffer.isBuffer(s) ? s : Buffer.from(s, 'base64');

    const zlibStrategies: Array<{ name: string; fn: () => string }> = [
        { name: 'gzip', fn: () => zlib.gunzipSync(asBuffer(raw)).toString('utf8') },
        { name: 'brotli', fn: () => zlib.brotliDecompressSync(asBuffer(raw)).toString('utf8') },
        { name: 'deflate', fn: () => zlib.inflateSync(asBuffer(raw)).toString('utf8') },
        { name: 'deflate-raw', fn: () => zlib.inflateRawSync(asBuffer(raw)).toString('utf8') },
    ];

    const lz = typeof raw === 'string' ? await lzStringDecompressors() : [];
    const lzStrategies = lz.map((d) => ({
        name: d.name,
        fn: () => {
            const out = d.fn(raw as string);
            if (out == null || out === '') throw new Error('empty');
            return out;
        },
    }));

    // Plain (already decompressed JSON/text).
    const plain: Array<{ name: string; fn: () => string }> =
        typeof raw === 'string' ? [{ name: 'plain', fn: () => raw }] : [];

    let ordered = [...zlibStrategies, ...lzStrategies, ...plain];
    if (preferred) {
        ordered = [
            ...ordered.filter((s) => s.name.startsWith(preferred)),
            ...ordered.filter((s) => !s.name.startsWith(preferred)),
        ];
    }

    let firstText: { strategy: string; text: string } | undefined;
    let lastErr = '';
    for (const s of ordered) {
        try {
            const text = s.fn();
            if (!text) continue;
            const { parsed, isJson } = tryJsonParse(text);
            if (isJson) {
                return { ok: true, strategy: s.name, full: parsed, text: text.slice(0, 200) };
            }
            if (!firstText) firstText = { strategy: s.name, text };
        } catch (err) {
            lastErr = String(err);
        }
    }

    if (firstText) {
        return {
            ok: true,
            strategy: `${firstText.strategy} (non-json)`,
            full: firstText.text.slice(0, 5000),
            text: firstText.text.slice(0, 200),
        };
    }
    return { ok: false, strategy: 'none', full: null, error: lastErr || 'no strategy matched' };
}

// ── 3. Structural analysis ────────────────────────────────────────────

export type SnapshotAnalysis = {
    shape: 'rrweb-events' | 'dom-tree' | 'unknown';
    issues: string[];
    stats: Record<string, unknown>;
};

// rrweb event types: 2 = FullSnapshot, 3 = IncrementalSnapshot, 4 = Meta, 0 = DomContentLoaded
export function analyzeSnapshotStructure(full: unknown): SnapshotAnalysis {
    const issues: string[] = [];

    if (Array.isArray(full)) {
        const events = full as Array<{ type?: number; data?: unknown; timestamp?: number }>;
        const typed = events.filter((e) => typeof e?.type === 'number');
        if (typed.length === events.length && events.length > 0) {
            const fullSnaps = events.filter((e) => e.type === 2).length;
            const incremental = events.filter((e) => e.type === 3).length;
            const meta = events.filter((e) => e.type === 4).length;

            if (fullSnaps === 0)
                issues.push(
                    'No FullSnapshot (type=2) event — the player has no initial DOM to build on; canvas/replay will be blank.',
                );
            if (incremental === 0)
                issues.push('No IncrementalSnapshot (type=3) events — nothing changes after load.');
            // Monotonic timestamps / large gaps hint at dropped chunks.
            const ts = events.map((e) => e.timestamp ?? 0).filter(Boolean);
            for (let i = 1; i < ts.length; i++) {
                if (ts[i]! < ts[i - 1]!) {
                    issues.push('Non-monotonic timestamps — events out of order or merged incorrectly.');
                    break;
                }
            }
            return {
                shape: 'rrweb-events',
                issues,
                stats: { totalEvents: events.length, fullSnaps, incremental, meta },
            };
        }
        issues.push('Array payload but not recognizable rrweb events (missing numeric "type").');
        return { shape: 'unknown', issues, stats: { length: events.length } };
    }

    if (full && typeof full === 'object') {
        const obj = full as Record<string, unknown>;
        // rrweb full-snapshot node tree (node with childNodes) or a wrapping object.
        const node = (obj['node'] ?? obj['childNodes'] ? obj : obj['snapshot']) as
            | Record<string, unknown>
            | undefined;
        const root = (node?.['node'] ?? node) as Record<string, unknown> | undefined;
        const children = root?.['childNodes'];
        if (Array.isArray(children)) {
            if (children.length === 0)
                issues.push('Snapshot DOM tree has no child nodes — empty document → blank render.');
            return { shape: 'dom-tree', issues, stats: { topLevelChildren: children.length } };
        }
        issues.push('Object payload but no DOM node tree found (no childNodes).');
        return { shape: 'unknown', issues, stats: { keys: Object.keys(obj).slice(0, 20) } };
    }

    issues.push('Decompressed payload is neither an array nor an object.');
    return { shape: 'unknown', issues, stats: {} };
}

// ── 4. Headless replay (best-effort) ──────────────────────────────────

export type SnapshotReplay = {
    attempted: boolean;
    rendered: boolean;
    blank?: boolean;
    consoleErrors: string[];
    networkErrors: string[];
    reason?: string;
};

/** Reconstruct an rrweb FullSnapshot node tree into an HTML string. Minimal serializer
 *  (node types: 0 Document, 1 DocumentType, 2 Element, 3 Text, 5 Comment). */
function rrwebNodeToHtml(node: unknown): string {
    const n = node as {
        type?: number;
        tagName?: string;
        textContent?: string;
        attributes?: Record<string, string>;
        childNodes?: unknown[];
    };
    if (!n || typeof n !== 'object') return '';
    switch (n.type) {
        case 0: // Document
            return (n.childNodes ?? []).map(rrwebNodeToHtml).join('');
        case 1: // DocumentType
            return '<!DOCTYPE html>';
        case 2: {
            // Element
            const tag = n.tagName ?? 'div';
            const attrs = Object.entries(n.attributes ?? {})
                .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
                .join(' ');
            const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
            const inner = (n.childNodes ?? []).map(rrwebNodeToHtml).join('');
            const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);
            return VOID.has(tag) ? open : `${open}${inner}</${tag}>`;
        }
        case 3: // Text
            return n.textContent ?? '';
        case 5: // Comment
            return `<!--${n.textContent ?? ''}-->`;
        default:
            return (n.childNodes ?? []).map(rrwebNodeToHtml).join('');
    }
}

function extractFullSnapshotNode(full: unknown): unknown {
    if (Array.isArray(full)) {
        const fs = (full as Array<{ type?: number; data?: { node?: unknown } }>).find(
            (e) => e.type === 2,
        );
        return fs?.data?.node;
    }
    if (full && typeof full === 'object') {
        const obj = full as Record<string, unknown>;
        return obj['node'] ?? obj['snapshot'] ?? obj;
    }
    return undefined;
}

export async function replaySnapshotHeadless(full: unknown): Promise<SnapshotReplay> {
    const node = extractFullSnapshotNode(full);
    if (!node) {
        return {
            attempted: false,
            rendered: false,
            consoleErrors: [],
            networkErrors: [],
            reason: 'No FullSnapshot node to rebuild — structural analysis only.',
        };
    }

    let html = rrwebNodeToHtml(node);
    if (!html || html.replace(/<!DOCTYPE html>/i, '').trim().length === 0) {
        return {
            attempted: true,
            rendered: false,
            blank: true,
            consoleErrors: [],
            networkErrors: [],
            reason: 'Reconstructed HTML is empty — snapshot has no renderable DOM.',
        };
    }
    if (!/^\s*<!DOCTYPE/i.test(html)) html = `<!DOCTYPE html>${html}`;

    const consoleErrors: string[] = [];
    const networkErrors: string[] = [];
    try {
        const { chromium } = await import('playwright');
        const browser = await chromium.launch({ headless: getEnv().PLAYWRIGHT_HEADLESS });
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        page.on('console', (m) => {
            if (m.type() === 'error') consoleErrors.push(m.text());
        });
        page.on('requestfailed', (r) =>
            networkErrors.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'failed'}`),
        );
        await page.setContent(html, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => {});
        const bodyText = await page
            .evaluate<string>(`(document.body && document.body.innerText) || ''`)
            .catch(() => '');
        const visibleEls = await page
            .evaluate<number>(`document.querySelectorAll('body *').length`)
            .catch(() => 0);
        await context.close();
        await browser.close();
        const blank = bodyText.trim().length === 0 && visibleEls < 3;
        return {
            attempted: true,
            rendered: true,
            blank,
            consoleErrors: consoleErrors.slice(0, 15),
            networkErrors: networkErrors.slice(0, 10),
            reason: blank ? 'Rebuilt DOM renders blank (no visible content).' : undefined,
        };
    } catch (err) {
        return {
            attempted: true,
            rendered: false,
            consoleErrors,
            networkErrors,
            reason: `Headless replay failed: ${String(err)}`,
        };
    }
}
