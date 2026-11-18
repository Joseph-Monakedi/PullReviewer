/**
 * Marker-based upsert for the pull request review comment.
 *
 * Only comments containing `COMMENT_MARKER` and authored by a GitHub bot
 * account (`userType === 'Bot'` or login ending in `[bot]`) are eligible for
 * in-place updates, preventing untrusted users from spoofing the marker in
 * their own comments.
 */
import type { ExistingComment, GitHubClient, PublishedComment } from '../github/client.js';
import { COMMENT_MARKER } from './format.js';

export interface UpsertCommentResult extends PublishedComment {
  updated: boolean;
}

export function isBotCommentWithMarker(comment: ExistingComment): boolean {
  if (!comment.body.includes(COMMENT_MARKER)) return false;
  const login = comment.userLogin.toLowerCase();
  return comment.userType === 'Bot' || login.endsWith('[bot]') || login === 'github-actions';
}

export async function upsertReviewComment(
  github: GitHubClient,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
): Promise<UpsertCommentResult> {
  const existing = await github.listIssueComments(owner, repo, pullNumber);
  const matching = existing.filter(isBotCommentWithMarker);
  const target = matching.at(-1);

  if (target) {
    const published = await github.updateIssueComment(owner, repo, target.id, body);
    return { ...published, updated: true };
  }

  const created = await github.createIssueComment(owner, repo, pullNumber, body);
  return { ...created, updated: false };
}

