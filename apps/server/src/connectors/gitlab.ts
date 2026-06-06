import { simpleGit, type SimpleGit } from 'simple-git';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { glob } from 'node:fs/promises';
import type { RepoConfig, FixPlan, ResolvedAppConfig, Artifacts } from '@shopify-support/shared';

type GitlabConfig = { baseUrl: string; token: string } | undefined;

export async function cloneOrPull(
  repo: RepoConfig,
  repoPath: string,
  gitlab: GitlabConfig,
): Promise<void> {
  const { mkdirSync, existsSync } = await import('node:fs');

  // Build authenticated URL
  let repoUrl = repo.url;
  if (gitlab?.token && repoUrl.startsWith('http')) {
    const u = new URL(repoUrl);
    u.username = 'oauth2';
    u.password = gitlab.token;
    repoUrl = u.toString();
  }

  if (existsSync(path.join(repoPath, '.git'))) {
    const git: SimpleGit = simpleGit(repoPath);
    await git.pull('origin', repo.branch ?? 'main');
  } else {
    mkdirSync(repoPath, { recursive: true });
    const git: SimpleGit = simpleGit();
    await git.clone(repoUrl, repoPath, ['--branch', repo.branch ?? 'main', '--depth', '1']);
  }
}

export async function searchCode(
  repoPath: string,
  globPattern: string,
  regex: string,
): Promise<Array<{ file: string; line: number; match: string }>> {
  const results: Array<{ file: string; line: number; match: string }> = [];
  const re = new RegExp(regex, 'i');

  const files: string[] = [];
  for await (const f of glob(globPattern, { cwd: repoPath })) {
    files.push(path.join(repoPath, f));
  }

  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          results.push({ file, line: i + 1, match: lines[i]!.trim().slice(0, 200) });
          if (results.length >= 50) return results;
        }
      }
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

export async function readContext(file: string, line: number, radius = 5): Promise<string> {
  try {
    const content = await readFile(file, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, line - radius - 1);
    const end = Math.min(lines.length, line + radius);
    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
  } catch {
    return '';
  }
}

export async function applyFix(input: {
  fixPlan: FixPlan;
  appConfig: ResolvedAppConfig;
  runId: string;
}): Promise<Artifacts> {
  const { fixPlan, appConfig, runId } = input;
  const codeChanges = fixPlan.changes.filter((c) => c.kind === 'code');

  if (!codeChanges.length || !appConfig.gitlab) {
    return {};
  }

  const repo = appConfig.repos[0];
  if (!repo) return {};

  const { mkdirSync } = await import('node:fs');
  const { writeFile } = await import('node:fs/promises');

  const workspaceDir = (await import('../env.js')).getEnv().WORKSPACE_DIR;
  const repoPath = path.join(workspaceDir, repo.name);
  const branch = `support/fix-${runId}`;

  // Clone or update repo
  await cloneOrPull(repo, repoPath, appConfig.gitlab);

  const git: SimpleGit = simpleGit(repoPath);
  await git.checkoutLocalBranch(branch);

  // Apply diffs (write files)
  for (const change of codeChanges) {
    if (change.file && change.diff) {
      // Apply unified diff — simplified: write the diff as a patch file for manual review
      const patchPath = path.join(repoPath, `support-${runId}.patch`);
      await writeFile(patchPath, `# ${change.description}\n${change.diff}`);
    }
  }

  await git.add('.');
  await git.commit(`[support] ${runId}: ${codeChanges[0]?.description ?? 'fix'}`);

  // Push
  let repoUrl = repo.url;
  if (appConfig.gitlab.token && repoUrl.startsWith('http')) {
    const u = new URL(repoUrl);
    u.username = 'oauth2';
    u.password = appConfig.gitlab.token;
    repoUrl = u.toString();
  }
  await git.addRemote('support_origin', repoUrl).catch(() => {});
  await git.push('support_origin', branch);

  // Create MR via GitLab API
  const mrUrl = await openMr({
    baseUrl: appConfig.gitlab.baseUrl,
    token: appConfig.gitlab.token,
    projectId: repo.gitlabProjectId ?? repo.name,
    sourceBranch: branch,
    targetBranch: repo.branch ?? 'main',
    title: `[Support] ${runId}: ${codeChanges[0]?.description ?? 'fix'}`,
  });

  const sha = await git.revparse(['HEAD']);

  return { mrUrl, branch, commitSha: sha.trim() };
}

async function openMr(params: {
  baseUrl: string;
  token: string;
  projectId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
}): Promise<string | undefined> {
  const projectEncoded = encodeURIComponent(params.projectId);
  const url = `${params.baseUrl}/api/v4/projects/${projectEncoded}/merge_requests`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'PRIVATE-TOKEN': params.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_branch: params.sourceBranch,
        target_branch: params.targetBranch,
        title: params.title,
        remove_source_branch: true,
      }),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { web_url?: string };
    return data.web_url;
  } catch {
    return undefined;
  }
}
