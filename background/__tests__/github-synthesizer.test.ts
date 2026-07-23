import { describe, expect, it, mock } from 'bun:test';

mock.module('draft-core/config', () => ({
  BACKGROUND_DIR: '/tmp/draft-github-synthesizer-unused',
  getWorkspacePath: () => '/tmp/draft-github-synthesizer-unused-workspace',
}));

const { buildGitHubPrompt, formatActivity, formatBodyPreview } = await import('../synthesizers/github');

describe('GitHub synthesis activity formatting', () => {
  it('includes a normalized release-notes preview', () => {
    const activity = formatActivity({ releases: [{
      repo: 'draft/example',
      tagName: 'v2.0.0',
      name: 'Summer release',
      publishedAt: '2026-07-22T12:00:00Z',
      body: '  New dashboard\n\n\tFaster exports   and sharing  ',
    }] }, []);

    expect(activity).toContain('- [draft/example] v2.0.0 (Summer release) — published 2026-07-22');
    expect(activity).toContain('  Release notes: New dashboard Faster exports and sharing');
  });

  it('normalizes whitespace before bounding previews to 200 characters', () => {
    const body = `${'a'.repeat(198)}\n\n  trailing words`;
    const preview = formatBodyPreview(body);

    expect(preview).toHaveLength(200);
    expect(preview).toBe(`${'a'.repeat(198)} t`);
    expect(preview).not.toContain('\n');
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
      contextFilesList: '(context)',
      outputPath: '/tmp/output',
      intelligence: 'fake',
      timestamp: '2026-07-22T12:00:00Z',
      profile: 'test',
    });

    expect(prompt).toContain('Releases with meaningful notes about features, breaking changes, or user-visible fixes');
    expect(prompt).toContain('Releases with blank or missing notes, or notes limited to chores and dependency updates');
    expect(prompt).toContain('action: append');
    expect(prompt).toContain('action: tension');
    expect(prompt).toContain('Use this exact YAML frontmatter followed by a markdown preview');
    expect(prompt).toContain('Do NOT repeat what\'s already in workspace context files');
  });
});
