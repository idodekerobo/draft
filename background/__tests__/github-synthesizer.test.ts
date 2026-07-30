import { describe, expect, it } from 'bun:test';
import { buildGitHubPrompt, formatActivity, formatBodyPreview } from '../synthesizers/github';
const SNAPSHOT = {
  snapshotPath: '/tmp/snapshot',
  files: [{
    relativePath: 'context/product/index.md',
    snapshotPath: '/tmp/snapshot/context/product/index.md',
    sha256: 'abc123',
  }],
  tensions: null,
};

describe('GitHub synthesis activity formatting', () => {
  it('includes complete multiline release notes without truncation', () => {
    const longLine = 'x'.repeat(260);
    const activity = formatActivity({ releases: [{
      repo: 'draft/example',
      tagName: 'v2.0.0',
      name: 'Summer release',
      publishedAt: '2026-07-22T12:00:00Z',
      body: `  New dashboard\n\n${longLine}  `,
    }] }, []);

    expect(activity).toContain('- [draft/example] v2.0.0 (Summer release) — published 2026-07-22');
    expect(activity).toContain('  Release notes:\n    New dashboard\n    \n');
    expect(activity).toContain(longLine);
  });

  it('normalizes line endings and trailing whitespace without bounding body text', () => {
    const body = `${'a'.repeat(220)}\r\n\r\n  trailing words  `;
    const preview = formatBodyPreview(body);

    expect(preview).toBe(`${'a'.repeat(220)}\n\n  trailing words`);
    expect(preview.length).toBeGreaterThan(200);
  });

  it('renders PR body, commits, and file pointers as separate full evidence sections', () => {
    const longRationale = `Rationale: ${'important '.repeat(30)}`.trim();
    const activity = formatActivity({ merged_prs: [{
      repo: 'draft/example',
      number: 52,
      title: 'Evidence-aware synthesis',
      mergedAt: '2026-07-22T12:00:00Z',
      author: { login: 'octo' },
      body: `Customer problem\n\n${longRationale}`,
      commits: ['Implement evidence model\n\nKeep all rationale.\nNo truncation.'],
      files: ['background/github.ts (+42/-3)', 'background/github.test.ts (+70/-0)'],
    }] }, [{ github: 'octo', name: 'Octavia' }]);

    expect(activity).toContain('#52 by Octavia');
    expect(activity).toContain('  Body evidence:\n    Customer problem');
    expect(activity).toContain(longRationale);
    expect(activity).toContain(
      '  Commit evidence:\n    - Implement evidence model\n      \n      Keep all rationale.\n      No truncation.',
    );
    expect(activity).toContain(
      '  File evidence:\n    - background/github.ts (+42/-3)\n    - background/github.test.ts (+70/-0)',
    );
  });

  it('omits release-notes lines for missing and blank bodies', () => {
    const activity = formatActivity({ releases: [
      { repo: 'draft/example', tagName: 'v1', publishedAt: '2026-07-20T00:00:00Z' },
      { repo: 'draft/example', tagName: 'v2', publishedAt: '2026-07-21T00:00:00Z', body: ' \n\t ' },
    ] }, []);

    expect(activity).toContain('[draft/example] v1');
    expect(activity).toContain('[draft/example] v2');
    expect(activity).not.toContain('Release notes:');
  });
});

describe('GitHub synthesis guidance', () => {
  it('classifies meaningful release notes as signal and empty or maintenance-only notes as noise', () => {
    const prompt = buildGitHubPrompt({
      activity: '(activity)',
      teamProfilesMap: '(profiles)',
      outputPath: '/tmp/output',
      intelligence: 'fake',
      timestamp: '2026-07-22T12:00:00Z',
      profile: 'test',
      snapshot: SNAPSHOT,
    });

    expect(prompt).toContain('Releases with meaningful notes about features, breaking changes, or user-visible fixes');
    expect(prompt).toContain('Releases with blank or missing notes, or notes limited to chores and dependency updates');
    expect(prompt).toContain('outcome: rewrite');
    expect(prompt).toContain('base_sha256: abc123');
    expect(prompt).toContain('needs_input');
    expect(prompt).not.toContain('context_updates');
    expect(prompt).toContain('Do NOT repeat what\'s already in workspace context files');
    expect(prompt).toContain('Prefer outcome-and-rationale language');
  });
});
