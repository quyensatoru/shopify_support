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
import type { CodeGraph as CodeGraphType, SearchResult, IndexProgress } from '@colbymchenry/codegraph';

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
                    logger.debug({ repo: repo.name, phase: p.phase, current: p.current, total: p.total }, 'codegraph indexing');
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
export async function buildRepoContext(
    cg: CgInstance,
    query: string,
): Promise<string | null> {
    try {
        const result = await cg.buildContext(query, {
            maxNodes: 30,
            includeCode: true,
            format: 'markdown',
        });
        if (typeof result === 'string') return result;
        const subgraphNodes = Array.from(result.subgraph.nodes.values()).slice(0, 20);
        return JSON.stringify({
            entryPoints: result.entryPoints.slice(0, 5).map((n) => ({ name: n.name, file: n.filePath, kind: n.kind })),
            relevantNodes: subgraphNodes.map((n) => ({ name: n.name, file: n.filePath, kind: n.kind, line: n.startLine })),
        }, null, 2);
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
        return Array.from(sub.nodes.values())
            .map((n) => ({ name: n.name, file: n.filePath ?? '', kind: n.kind }));
    } catch (err) {
        logger.warn({ err, nodeId }, 'codegraph getImpactRadius failed');
        return [];
    }
}

/**
 * Detect framework-specific markers that should appear in the rendered storefront/admin.
 */
export function detectExpectedMarkers(cg: CgInstance): string[] {
    try {
        const markers: string[] = [];

        const handleNodes = cg.searchNodes('handle', { limit: 20 });
        for (const r of handleNodes) {
            const n = r.node;
            if (n.name && /^[\w-]+$/.test(n.name) && n.kind === 'field') {
                markers.push(n.name);
            }
        }

        const elementNodes = cg.searchNodes('customElements', { limit: 10 });
        for (const r of elementNodes) {
            if (r.node.name?.includes('-')) markers.push(r.node.name);
        }

        return [...new Set(markers)].slice(0, 10);
    } catch {
        return [];
    }
}

export type { CodeGraphType as CodeGraph, SearchResult };
