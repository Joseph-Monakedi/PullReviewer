/**
 * Thin, testable wrapper around Octokit for the endpoints this action needs.
 *
 * Security note: repository instructions files are always fetched at `baseSha`
 * (the target branch), never `headSha`, so an untrusted pull request cannot
 * modify its own review rules.
 */
import { getOctokit } from '@actions/github';
import type { PullRequestFile } from '../diff/extract.js';
import { GitHubApiError, describeError, getStatus } from '../errors.js';

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  isFork: boolean;
  htmlUrl: string;
}

export interface ExistingComment {
  id: number;
  body: string;
  htmlUrl: string;
  userLogin: string;
  userType: string;
  updatedAt: string;
}

export interface PublishedComment {
  id: number;
  htmlUrl: string;
}

export interface GitHubClient {
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestDetails>;
  listPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFile[]>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | undefined>;
  listIssueComments(owner: string, repo: string, issueNumber: number): Promise<ExistingComment[]>;
  createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<PublishedComment>;
  updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<PublishedComment>;
}

const MAX_INSTRUCTIONS_FILE_BYTES = 32_768;
const MAX_INSTRUCTIONS_CHARS = 10_000;

function toGitHubError(action: string, err: unknown): GitHubApiError {
  const status = getStatus(err);
  const statusLabel = status !== undefined ? ` (HTTP ${status})` : '';
  return new GitHubApiError(`GitHub API error while ${action}${statusLabel}: ${describeError(err)}`, status);
}

export type OctokitInstance = ReturnType<typeof getOctokit>;

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: OctokitInstance;

  constructor(token: string, octokit?: OctokitInstance) {
    this.octokit = octokit ?? getOctokit(token);
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<PullRequestDetails> {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });
      const headFullName = data.head.repo?.full_name;
      const baseFullName = data.base.repo.full_name;
      const isFork = Boolean(data.head.repo?.fork) || (Boolean(headFullName) && headFullName !== baseFullName);
      return {
        number: data.number,
        title: data.title ?? '',
        body: data.body ?? '',
        draft: Boolean(data.draft),
        headSha: data.head.sha,
        headRef: data.head.ref,
        baseSha: data.base.sha,
        baseRef: data.base.ref,
        isFork,
        htmlUrl: data.html_url,
      };
    } catch (err) {
      throw toGitHubError(`fetching pull request #${pullNumber}`, err);
    }
  }

  async listPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFile[]> {
    try {
      const files = await this.octokit.paginate(
        this.octokit.rest.pulls.listFiles,
        {
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 100,
        },
        (response) => response.data,
      );
      return files.map((file) => ({
        filename: file.filename,
        previous_filename: file.previous_filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch,
      }));
    } catch (err) {
      throw toGitHubError(`listing files for pull request #${pullNumber}`, err);
    }
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
    const cleanPath = path.replace(/^\/+/, '');
    if (!cleanPath) return undefined;
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: cleanPath,
        ref,
      });
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        return undefined;
      }
      if (typeof data.size === 'number' && data.size > MAX_INSTRUCTIONS_FILE_BYTES) {
        return undefined;
      }
      const decoded = Buffer.from(data.content, 'base64').toString('utf8');
      return decoded.slice(0, MAX_INSTRUCTIONS_CHARS).trim() || undefined;
    } catch (err) {
      if (getStatus(err) === 404) return undefined;
      throw toGitHubError(`reading "${cleanPath}" at ref ${ref.slice(0, 7)}`, err);
    }
  }

  async listIssueComments(owner: string, repo: string, issueNumber: number): Promise<ExistingComment[]> {
    try {
      const comments = await this.octokit.paginate(
        this.octokit.rest.issues.listComments,
        {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
        },
        (response) => response.data,
      );
      return comments.map((comment) => ({
        id: comment.id,
        body: comment.body ?? '',
        htmlUrl: comment.html_url,
        userLogin: comment.user?.login ?? '',
        userType: comment.user?.type ?? '',
        updatedAt: comment.updated_at,
      }));
    } catch (err) {
      throw toGitHubError(`listing comments on pull request #${issueNumber}`, err);
    }
  }

  async createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<PublishedComment> {
    try {
      const { data } = await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      return { id: data.id, htmlUrl: data.html_url };
    } catch (err) {
      throw toGitHubError(`creating review comment on pull request #${issueNumber}`, err);
    }
  }

  async updateIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<PublishedComment> {
    try {
      const { data } = await this.octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
      return { id: data.id, htmlUrl: data.html_url };
    } catch (err) {
      throw toGitHubError(`updating review comment ${commentId}`, err);
    }
  }
}

