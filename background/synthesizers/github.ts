// GitHub source adapter: turn an embedded poller context into a proposal prompt.

import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { BACKGROUND_DIR, getWorkspacePath } from 'draft-core/config';
import {
  cleanupContextSnapshot,
  createContextSnapshot,
  type ContextSnapshot,
} from './synthesis-runtime';
import { buildMaintainerContractPrompt } from './maintainer-contract';

interface TeamProfile {
  github?: string;
  name?: string;
  slack?: string;
}

interface GitHubContext {
  merged_prs?: Array<Record<string, unknown>>;
  releases?: Array<Record<string, unknown>>;
  open_prs?: Array<Record<string, unknown>>;
}

interface GitHubJob {
  profile?: string;
  github_context?: GitHubContext;
}

export interface GitHubPromptInput {
  activity: string;
  teamProfilesMap: string;
  outputPath: string;
  intelligence: string;
  timestamp: string;
  profile: string;
  snapshot: ContextSnapshot;
}

function log(msg: string): void {
  process.stderr.write(`[github.ts] ${msg}\n`);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function formatBodyPreview(value: unknown): string {
  return text(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

function evidenceBlock(label: string, value: string, indent = '  '): string[] {
  if (!value) return [];
  return [
    `${indent}${label}:`,
    ...value.split('\n').map(line => `${indent}  ${line}`),
  ];
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

export function formatActivity(context: GitHubContext, profiles: TeamProfile[]): string {
  const resolveName = (login: string): string => {
    const match = profiles.find(profile => text(profile.github).toLowerCase() === login.toLowerCase());
    return text(match?.name) || login;
  };
  const lines: string[] = [];

  const merged = Array.isArray(context.merged_prs) ? context.merged_prs : [];
  if (merged.length > 0) {
    lines.push('### Merged PRs (shipped work)');
    for (const pr of merged) {
      const author = pr.author && typeof pr.author === 'object'
        ? resolveName(text((pr.author as Record<string, unknown>).login) || 'unknown')
        : 'unknown';
      lines.push(`- [${text(pr.repo)}] #${String(pr.number ?? '?')} by ${author} on ${text(pr.mergedAt).slice(0, 10)}: ${text(pr.title) || '(no title)'}`);
      lines.push(...evidenceBlock('Body evidence', formatBodyPreview(pr.body)));
      const commits = stringItems(pr.commits);
      if (commits.length > 0) {
        lines.push('  Commit evidence:');
        for (const commit of commits) {
          const normalized = formatBodyPreview(commit);
          const [first, ...rest] = normalized.split('\n');
          lines.push(`    - ${first}`);
          lines.push(...rest.map(line => `      ${line}`));
        }
      }
      const files = stringItems(pr.files);
      if (files.length > 0) {
        lines.push('  File evidence:');
        lines.push(...files.map(file => `    - ${file}`));
      }
    }
    lines.push('');
  }

  const releases = Array.isArray(context.releases) ? context.releases : [];
  if (releases.length > 0) {
    lines.push('### New Releases');
    for (const release of releases) {
      const tag = text(release.tagName) || '?';
      lines.push(`- [${text(release.repo)}] ${tag} (${text(release.name) || tag}) — published ${text(release.publishedAt).slice(0, 10)}`);
      lines.push(...evidenceBlock('Release notes', formatBodyPreview(release.body)));
    }
    lines.push('');
  }

  const openPrs = Array.isArray(context.open_prs) ? context.open_prs : [];
  if (openPrs.length > 0) {
    lines.push('### Open PRs (in-flight work)');
    for (const pr of openPrs) {
      const author = pr.author && typeof pr.author === 'object'
        ? resolveName(text((pr.author as Record<string, unknown>).login) || 'unknown')
        : 'unknown';
      lines.push(`- [${text(pr.repo)}] #${String(pr.number ?? '?')} by ${author} (opened ${text(pr.createdAt).slice(0, 10)}, ${text(pr.reviewDecision) || 'pending review'}): ${text(pr.title) || '(no title)'}`);
    }
    lines.push('');
  }

  return lines.join('\n') || '(no new GitHub activity)';
}

export function buildGitHubPrompt(input: GitHubPromptInput): string {
  return `# Draft Synthesis Task — GitHub Activity

You are a context synthesis agent for Draft. Your job is to extract relevant signal from recent GitHub activity and propose updates to the team's workspace context.

## Team member profiles (GitHub username -> display name)
${input.teamProfilesMap}

## Recent GitHub activity
${input.activity}

---

## Your task

Read the immutable context snapshot in the shared contract below. Then synthesize the GitHub activity above into durable current state — focusing on outcomes and rationale a product lead or engineering manager would need later.

**Signal that matters:**
- What shipped (merged PRs, releases) — the durable outcome, why it matters, and rationale supported by the PR or release evidence
- Releases with meaningful notes about features, breaking changes, or user-visible fixes
- What's actively in progress only when it establishes a durable priority, owner, constraint, or blocker
- Release milestones

**Signal to ignore:**
- Low-signal PRs (dependency bumps, typo fixes, config changes)
- Releases with blank or missing notes, or notes limited to chores and dependency updates
- Activity that's already captured in existing context
- Open PRs that were just created today (too early to be meaningful)

**Rules:**
- Use display names from the team profile map, not raw GitHub usernames
- Prefer outcome-and-rationale language over implementation summaries or activity-feed recaps
- If a PR description clarifies why the outcome matters or records a decision, preserve that rationale
- Do NOT repeat what's already in workspace context files

${buildMaintainerContractPrompt({
    snapshot: input.snapshot,
    metadata: {
      session_id: `github:${input.timestamp}`,
      input_source: 'github',
      synthesized_by: input.intelligence,
      timestamp: input.timestamp,
      profile: input.profile,
    },
    outputPath: input.outputPath,
  })}
`;
}

async function main(): Promise<void> {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('job file path required as argv[2]');

  let job: GitHubJob;
  try {
    job = JSON.parse(await Bun.file(jobPath).text()) as GitHubJob;
  } catch {
    throw new Error(`could not parse job file: ${jobPath}`);
  }
  if (!job.github_context || typeof job.github_context !== 'object') {
    throw new Error('job is missing github_context');
  }

  const profile = job.profile ?? 'default';
  const workspace = getWorkspacePath(profile);
  const teamProfilesPath = join(workspace, 'config', 'team-profiles.json');
  const tmpDir = join(workspace, 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  let profiles: TeamProfile[] = [];
  let teamProfilesMap: string;
  try {
    const parsed = JSON.parse(await Bun.file(teamProfilesPath).text());
    profiles = Array.isArray(parsed) ? parsed : [];
    const mappings = profiles
      .filter(member => text(member.github))
      .map(member => `  - ${member.github} -> ${text(member.name) || member.github}${member.slack ? ` (Slack: ${member.slack})` : ''}`);
    teamProfilesMap = mappings.length > 0 ? mappings.join('\n') : '  (no team profiles configured)';
  } catch {
    teamProfilesMap = '  (not configured — run /draft:connect github to add team member mappings)';
  }

  const intelligence = process.env.DRAFT_GITHUB_INTELLIGENCE ?? 'claude-code';
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const promptPath = join(tmpDir, `github-prompt-${Date.now()}-${crypto.randomUUID()}`);
  const outputPath = join(tmpDir, `github-synthesis-${Date.now()}-${crypto.randomUUID()}`);
  const snapshot = createContextSnapshot(workspace);

  const prompt = buildGitHubPrompt({
    activity: formatActivity(job.github_context, profiles),
    teamProfilesMap,
    outputPath,
    intelligence,
    timestamp,
    profile,
    snapshot,
  });

  await Bun.write(promptPath, prompt);

  try {
    const jsAdapterPath = join(BACKGROUND_DIR, 'intelligence', `${intelligence}.js`);
    const tsAdapterPath = join(BACKGROUND_DIR, 'intelligence', `${intelligence}.ts`);
    const shAdapterPath = join(BACKGROUND_DIR, 'intelligence', `${intelligence}.sh`);
    const adapterCmd = existsSync(jsAdapterPath)
      ? ['bun', 'run', jsAdapterPath, promptPath, outputPath]
      : existsSync(tsAdapterPath)
        ? ['bun', 'run', tsAdapterPath, promptPath, outputPath]
        : existsSync(shAdapterPath)
          ? ['bash', shAdapterPath, promptPath, outputPath]
          : null;
    if (!adapterCmd) {
      throw new Error(`intelligence adapter not found for "${intelligence}" (tried .js, .ts, and .sh)`);
    }

    log(`calling intelligence adapter: ${intelligence}`);
    const proc = Bun.spawn(adapterCmd, {
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`intelligence adapter exited ${exitCode}`);
    if (!existsSync(outputPath)) throw new Error('intelligence adapter returned success but output file is missing');

    const output = await Bun.file(outputPath).text();
    if (!output.trim()) throw new Error('intelligence adapter returned empty output');
    if (output.split('\n')[0]?.trim() !== '---') {
      throw new Error('intelligence adapter output is missing YAML frontmatter');
    }
    process.stdout.write(output);
  } finally {
    cleanupContextSnapshot(snapshot);
    try { unlinkSync(promptPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
  }
}

if (import.meta.main) {
  await main().catch(error => {
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
