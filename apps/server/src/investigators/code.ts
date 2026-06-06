import type { Probe, ProbeResult, ResolvedAppConfig } from '@shopify-support/shared';
import { cloneOrPull, searchCode, readContext } from '../connectors/gitlab.js';
import { getEnv } from '../env.js';
import path from 'node:path';

export async function investigateCode(
  probe: Probe,
  appConfig: ResolvedAppConfig | undefined,
): Promise<ProbeResult> {
  const base = { probeId: probe.id, surface: probe.surface as 'code', action: probe.action };

  if (!appConfig?.repos?.length) {
    return { ...base, status: 'skipped', found: false, data: null, reason: 'No repos configured', provenance: 'code:repos' };
  }

  const repoName = probe.target['repo'];
  const repos = repoName
    ? appConfig.repos.filter((r) => r.name === repoName)
    : appConfig.repos.slice(0, 1); // default: first repo

  if (!repos.length) {
    return { ...base, status: 'skipped', found: false, data: null, reason: `Repo "${repoName}" not found in config`, provenance: 'code:repos' };
  }

  const workspaceDir = getEnv().WORKSPACE_DIR;
  const results: Array<{ repo: string; file: string; line: number; snippet: string }> = [];

  for (const repo of repos) {
    const repoPath = path.join(workspaceDir, repo.name);

    try {
      await cloneOrPull(repo, repoPath, appConfig.gitlab);
    } catch (err) {
      return { ...base, status: 'failed', found: false, data: null, reason: `Clone failed: ${String(err)}`, provenance: `git:${repo.url}` };
    }

    const glob = probe.target['glob'] ?? '**/*.{ts,js,tsx,jsx,liquid}';
    const regex = probe.target['regex'];

    if (!regex) {
      return { ...base, status: 'skipped', found: false, data: null, reason: 'No regex target provided for code probe', provenance: `code:${repo.name}` };
    }

    const matches = await searchCode(repoPath, glob, regex);
    for (const match of matches.slice(0, 10)) {
      const snippet = await readContext(match.file, match.line, 5);
      results.push({ repo: repo.name, file: match.file.replace(repoPath, ''), line: match.line, snippet });
    }
  }

  return {
    ...base,
    status: 'done',
    found: results.length > 0,
    data: results,
    provenance: `code:search glob=${probe.target['glob']} regex=${probe.target['regex']}`,
  };
}
