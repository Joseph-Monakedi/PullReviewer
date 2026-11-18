import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from '../src/errors.js';
import { OctokitGitHubClient, type OctokitInstance } from '../src/github/client.js';

describe('OctokitGitHubClient', () => {
  it('fetches PR details, detects forks, and reads base-branch files safely', async () => {
    const fakeOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 7,
              title: 'Add cache layer',
              body: 'PR body',
              draft: false,
              head: {
                sha: 'headsha123',
                ref: 'feat/cache',
                repo: { fork: true, full_name: 'forker/widget' },
              },
              base: {
                sha: 'basesha456',
                ref: 'main',
                repo: { full_name: 'acme/widget' },
              },
              html_url: 'https://github.com/acme/widget/pull/7',
            },
          }),
          listFiles: vi.fn(),
        },
        repos: {
          getContent: vi
            .fn()
            .mockResolvedValueOnce({
              data: {
                type: 'file',
                size: 20,
                content: Buffer.from('# Review Rules\nBe strict.').toString('base64'),
              },
            })
            .mockRejectedValueOnce({ status: 404, message: 'Not Found' }),
        },
        issues: {
          listComments: vi.fn(),
          createComment: vi.fn().mockResolvedValue({
            data: { id: 99, html_url: 'https://github.com/acme/widget/pull/7#issuecomment-99' },
          }),
          updateComment: vi.fn().mockResolvedValue({
            data: { id: 99, html_url: 'https://github.com/acme/widget/pull/7#issuecomment-99' },
          }),
        },
      },
      paginate: vi.fn().mockResolvedValue([
        {
          filename: 'src/cache.ts',
          status: 'added',
          additions: 10,
          deletions: 0,
          changes: 10,
          patch: '@@ -0,0 +1,1 @@\n+export const cache = new Map();',
        },
      ]),
    } as unknown as OctokitInstance;

    const client = new OctokitGitHubClient('token', fakeOctokit);
    const pr = await client.getPullRequest('acme', 'widget', 7);
    expect(pr.isFork).toBe(true);
    expect(pr.baseSha).toBe('basesha456');

    const files = await client.listPullRequestFiles('acme', 'widget', 7);
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe('src/cache.ts');

    const rules = await client.getFileContent('acme', 'widget', '.github/gemini-review.md', 'basesha456');
    expect(rules).toBe('# Review Rules\nBe strict.');

    const missing = await client.getFileContent('acme', 'widget', '.github/missing.md', 'basesha456');
    expect(missing).toBeUndefined();

    const created = await client.createIssueComment('acme', 'widget', 7, 'Hello');
    expect(created.id).toBe(99);

    const updated = await client.updateIssueComment('acme', 'widget', 99, 'Updated');
    expect(updated.id).toBe(99);
  });

  it('wraps Octokit errors in GitHubApiError with HTTP status', async () => {
    const fakeOctokit = {
      rest: {
        pulls: {
          get: vi.fn().mockRejectedValue({ status: 403, message: 'Resource not accessible by integration' }),
        },
      },
    } as unknown as OctokitInstance;

    const client = new OctokitGitHubClient('token', fakeOctokit);
    await expect(client.getPullRequest('acme', 'widget', 1)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(403);
      return true;
    });
  });
});

