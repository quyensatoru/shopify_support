/**
 * Wrapper around @colbymchenry/codegraph for per-repo code intelligence.
 *
 * Responsibilities:
 * - Ensure repo is cloned/pulled before indexing
 * - Open or init the CodeGraph index (SQLite, stored inside repo workspace)
 * - Run incremental sync when repo already indexed
 * - Expose buildContext / searchNodes / getCallGraph for investigators + gatherContext
 *
 * Cache: one CodeGraph instance per absolute repoPath (process-lifetime Map).
 * Multiple nodes in the same run re-use the same instance without re-indexing.
 */

import _codegraphPkg from '@colbymchenry/codegraph';
import type {
    CodeGraph as CodeGraphType,
    SearchResult,
    IndexProgress,
} from '@colbymchenry/codegraph';

// CJS interop: npm-sdk.js does `module.exports = require(platformBundle)`, so Node's
// ESM loader cannot statically synthesize named exports from that dynamic re-export.
// The entire module.exports becomes the default import — access CodeGraph as a property.
const CodeGraph = (_codegraphPkg as unknown as { CodeGraph: typeof CodeGraphType }).CodeGraph;
import path from 'node:path';
import { cloneOrPull } from './gitlab.js';
import type { RepoConfig } from '@shopify-support/shared';
import { logger } from '../observability/logger.js';

type CgInstance = Awaited<ReturnType<typeof CodeGraph.open>>;
type GitlabConfig = { baseUrl: string; token: string } | undefined;

// Process-level cache: repoPath → CodeGraph instance
const _cache = new Map<string, CgInstance>();

/**
 * Ensure the repo is cloned/pulled and the CodeGraph index is ready.
 * Returns the CodeGraph instance (from cache or freshly opened/initialised).
 */
export async function ensureIndex(
    repo: RepoConfig,
    repoPath: string,
    gitlab: GitlabConfig,
): Promise<CgInstance> {
    if (_cache.has(repoPath)) {
        const cg = _cache.get(repoPath)!;
        try {
            await cg.sync();
        } catch (err) {
            logger.warn({ err, repo: repo.name }, 'codegraph sync failed (non-fatal)');
        }
        return cg;
    }

    await cloneOrPull(repo, repoPath, gitlab);

    let cg: CgInstance;
    if (CodeGraph.isInitialized(repoPath)) {
        cg = await CodeGraph.open(repoPath, { sync: true });
    } else {
        logger.info({ repo: repo.name }, 'codegraph: first-time index (may take a moment)');
        cg = await CodeGraph.init(repoPath, {
            index: true,
            onProgress: (p: IndexProgress) => {
                if (p.current % 100 === 0) {
                    logger.debug(
                        { repo: repo.name, phase: p.phase, current: p.current, total: p.total },
                        'codegraph indexing',
                    );
                }
            },
        });
    }

    _cache.set(repoPath, cg);
    return cg;
}

/**
 * Build a markdown context summary for the given query (issue text).
 * Returns null on any error — caller logs and continues without context.
 */
export async function buildRepoContext(cg: CgInstance, query: string): Promise<string | null> {
    try {
        const result = await cg.buildContext(query, {
            maxNodes: 30,
            includeCode: true,
            format: 'markdown',
        });
        if (typeof result === 'string') return result;
        const subgraphNodes = Array.from(result.subgraph.nodes.values()).slice(0, 20);
        return JSON.stringify(
            {
                entryPoints: result.entryPoints
                    .slice(0, 5)
                    .map((n) => ({ name: n.name, file: n.filePath, kind: n.kind })),
                relevantNodes: subgraphNodes.map((n) => ({
                    name: n.name,
                    file: n.filePath,
                    kind: n.kind,
                    line: n.startLine,
                })),
            },
            null,
            2,
        );
    } catch (err) {
        logger.warn({ err }, 'codegraph buildContext failed (non-fatal)');
        return null;
    }
}

/**
 * Search nodes by symbol name/query. Returns up to limit results.
 */
export function searchSymbols(cg: CgInstance, query: string, limit = 10): SearchResult[] {
    try {
        return cg.searchNodes(query, { limit });
    } catch (err) {
        logger.warn({ err, query }, 'codegraph searchNodes failed');
        return [];
    }
}

// Framework/boilerplate symbol names that pollute relevance — almost never the
// answer to a diagnosis query.
const BOILERPLATE_NAMES = new Set([
    'app',
    'koa',
    'Koa',
    'koaBody',
    'koaStatic',
    'koaCompress',
    'cors',
    'Router',
    'router',
    'express',
    'server',
    'index',
    'config',
    'logger',
    'ratelimit',
]);
const BOILERPLATE_KINDS = new Set(['import', 'module']);

/**
 * Search symbols across a set of English technical keywords, drop framework
 * boilerplate, and rank by (a) how many keywords match name/path and (b) whether
 * the file path contains a keyword. Returns the top `limit` distinct symbols.
 *
 * This replaces feeding the raw (often non-English) issue text to searchNodes,
 * which matched common words and surfaced `import koa` / `Router` noise.
 */
export function searchRelevantSymbols(
    cg: CgInstance,
    keywords: string[],
    limit = 8,
): SearchResult[] {
    const keys = keywords.filter((k) => k && k.length >= 2).slice(0, 10);
    if (!keys.length) return [];

    const seen = new Map<string, { result: SearchResult; score: number }>();
    for (const kw of keys) {
        let hits: SearchResult[] = [];
        try {
            hits = cg.searchNodes(kw, { limit: 15 });
        } catch {
            continue;
        }
        for (const r of hits) {
            const n = r.node;
            const name = n.name ?? '';
            if (!name) continue;
            if (BOILERPLATE_KINDS.has(n.kind)) continue;
            if (BOILERPLATE_NAMES.has(name)) continue;

            const id = n.id ?? `${n.filePath}:${name}`;
            const lname = name.toLowerCase();
            const lpath = (n.filePath ?? '').toLowerCase();
            // Score: keyword in name (2) + keyword in path (1), summed across all keys.
            let score = 0;
            for (const k of keys) {
                const lk = k.toLowerCase();
                if (lname.includes(lk)) score += 2;
                if (lpath.includes(lk)) score += 1;
            }
            const prev = seen.get(id);
            if (!prev || score > prev.score) seen.set(id, { result: r, score });
        }
    }

    return [...seen.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((s) => s.result);
}

/**
 * Get callers of a node (by node ID). Returns simplified shape.
 */
export function getCallers(
    cg: CgInstance,
    nodeId: string,
    maxDepth = 2,
): Array<{ name: string; file: string; line: number; kind: string }> {
    try {
        return cg.getCallers(nodeId, maxDepth).map(({ node: n }) => ({
            name: n.name,
            file: n.filePath ?? '',
            line: n.startLine ?? 0,
            kind: n.kind,
        }));
    } catch (err) {
        logger.warn({ err, nodeId }, 'codegraph getCallers failed');
        return [];
    }
}

/**
 * Get callees of a node. Returns simplified shape.
 */
export function getCallees(
    cg: CgInstance,
    nodeId: string,
    maxDepth = 2,
): Array<{ name: string; file: string; line: number; kind: string }> {
    try {
        return cg.getCallees(nodeId, maxDepth).map(({ node: n }) => ({
            name: n.name,
            file: n.filePath ?? '',
            line: n.startLine ?? 0,
            kind: n.kind,
        }));
    } catch (err) {
        logger.warn({ err, nodeId }, 'codegraph getCallees failed');
        return [];
    }
}

/**
 * Get impact radius of a node (what would break if this changes).
 */
export function getImpact(
    cg: CgInstance,
    nodeId: string,
    maxDepth = 3,
): Array<{ name: string; file: string; kind: string }> {
    try {
        const sub = cg.getImpactRadius(nodeId, maxDepth);
        return Array.from(sub.nodes.values()).map((n) => ({
            name: n.name,
            file: n.filePath ?? '',
            kind: n.kind,
        }));
    } catch (err) {
        logger.warn({ err, nodeId }, 'codegraph getImpactRadius failed');
        return [];
    }
}

/**
 * Detect markers that should appear in the rendered page — usable to ground a
 * browser probe ("is the heatmap canvas / mount point actually present?").
 *
 * Works for BOTH Shopify themes (handle fields, custom elements) and SPA/React
 * apps (canvas/container ids, render constants, mount selectors). Seeded by the
 * issue's technical keywords so it surfaces markers relevant to THIS issue.
 */
export function detectExpectedMarkers(cg: CgInstance, keywords: string[] = []): string[] {
    try {
        const markers: string[] = [];
        const push = (v?: string | null) => {
            if (v && /^[\w$-]{2,}$/.test(v)) markers.push(v);
        };

        // 1. Shopify theme style: handle fields + custom elements.
        for (const r of cg.searchNodes('handle', { limit: 20 })) {
            if (r.node.kind === 'field') push(r.node.name);
        }
        for (const r of cg.searchNodes('customElements', { limit: 10 })) {
            if (r.node.name?.includes('-')) push(r.node.name);
        }

        // 2. SPA/React: render/mount/canvas/container symbols + issue keywords.
        const seeds = [
            'canvas',
            'render',
            'mount',
            'container',
            'rootId',
            'elementId',
            ...keywords,
        ];
        for (const seed of seeds.slice(0, 12)) {
            for (const r of cg.searchNodes(seed, { limit: 6 })) {
                const n = r.node;
                // Constants / variables / fields whose value or name is a likely
                // DOM marker (id, class, custom element, render container).
                if (['constant', 'variable', 'field', 'component', 'class'].includes(n.kind)) {
                    push(n.name);
                }
            }
        }

        return [...new Set(markers)].slice(0, 12);
    } catch {
        return [];
    }
}

export type { CodeGraphType as CodeGraph, SearchResult };
