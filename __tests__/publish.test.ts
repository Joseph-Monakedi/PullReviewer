import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from '../src/github/client.js';
import { COMMENT_MARKER } from '../src/review/format.js';
import { upsertReviewComment } from '../src/review/publish.js';

function makeMockGitHub(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: vi.fn(),
    listPullRequestFiles: vi.fn(),
    getFileContent: vi.fn(),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue({
      id: 101,
      htmlUrl: 'https://github.com/acme/repo/pull/1#issuecomment-101',
    }),
    updateIssueComment: vi.fn().mockResolvedValue({
      id: 202,
      htmlUrl: 'https://github.com/acme/repo/pull/1#issuecomment-202',
    }),
    ...overrides,
  };
}

describe('upsertReviewComment', () => {
  it('creates a new comment when no existing bot comment has the marker', async () => {
    const github = makeMockGitHub({
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 50,
          body: `${COMMENT_MARKER}\nSpoofed marker by a regular user`,
          htmlUrl: 'https://github.com/acme/repo/pull/1#issuecomment-50',
          userLogin: 'malicious-contributor',
          userType: 'User',
          updatedAt: '2026-11-18T10:00:00Z',
        },
      ]),
    });

    const result = await upsertReviewComment(github, 'acme', 'repo', 1, `${COMMENT_MARKER}\nBody`);
    expect(result.updated).toBe(false);
    expect(result.id).toBe(101);
    expect(github.createIssueComment).toHaveBeenCalledWith('acme', 'repo', 1, `${COMMENT_MARKER}\nBody`);
    expect(github.updateIssueComment).not.toHaveBeenCalled();
  });

  it('updates the most recent bot comment containing COMMENT_MARKER', async () => {
    const github = makeMockGitHub({
      listIssueComments: vi.fn().mockResolvedValue([
        {
          id: 10,
          body: `${COMMENT_MARKER}\nOlder bot review`,
          htmlUrl: 'https://github.com/acme/repo/pull/1#issuecomment-10',
          userLogin: 'github-actions[bot]',
          userType: 'Bot',
          updatedAt: '2026-11-18T09:00:00Z',
        },
        {
          id: 202,
          body: `${COMMENT_MARKER}\nLatest bot review`,
          htmlUrl: 'https://github.com/acme/repo/pull/1#issuecomment-202',
          userLogin: 'github-actions[bot]',
          userType: 'Bot',
          updatedAt: '2026-11-18T11:00:00Z',
        },
      ]),
    });

    const result = await upsertReviewComment(github, 'acme', 'repo', 1, `${COMMENT_MARKER}\nUpdated`);
    expect(result.updated).toBe(true);
    expect(result.id).toBe(202);
    expect(github.updateIssueComment).toHaveBeenCalledWith('acme', 'repo', 202, `${COMMENT_MARKER}\nUpdated`);
    expect(github.createIssueComment).not.toHaveBeenCalled();
  });
});

