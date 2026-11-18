/**
 * Core orchestration for the Gemini PR Reviewer action.
 *
 * All external collaborators (Actions runtime host, GitHub client, Gemini client)
 * are injected so the full workflow can be tested end-to-end without network calls.
 */
import * as core from '@actions/core';
import { context as githubContext } from '@actions/github';
import { type ReviewerConfig, loadConfig } from './config.js';
import { type ExtractedDiff, extractDiff } from './diff/extract.js';
import { FileFilter } from './diff/filters.js';
import {
  ConfigError,
  MissingApiKeyError,
  ResponseValidationError,
  describeError,
  registerSecret,
} from './errors.js';
import {
  type GeminiClient,
  GoogleGenAIClient,
  type TokenUsage,
} from './gemini/client.js';
import {
  type GitHubClient,
  OctokitGitHubClient,
} from './github/client.js';
import {
  formatFailureComment,
  formatReviewComment,
  formatSkippedReviewComment,
} from './review/format.js';
import {
  buildRepairUserPrompt,
  buildReviewPrompt,
} from './review/prompt.js';
import { upsertReviewComment } from './review/publish.js';
import type { ValidatedReview } from './review/schema.js';
import { validateAndGroundReview } from './review/validate.js';

export interface ActionHost {
  getInput(name: string): string;
  setSecret(secret: string): void;
  setOutput(name: string, value: string | number): void;
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  setFailed(message: string): void;
}

export interface EventContext {
  eventName: string;
  owner: string;
  repo: string;
  pullNumber?: number;
  isForkFromPayload?: boolean;
  isDraftFromPayload?: boolean;
}

export interface RunDependencies {
  host?: ActionHost;
  event?: EventContext;
  createGitHubClient?: (token: string) => GitHubClient;
  createGeminiClient?: (apiKey: string, host: ActionHost) => GeminiClient;
}

export function createDefaultHost(): ActionHost {
  return {
    getInput: (name: string) => core.getInput(name),
    setSecret: (secret: string) => core.setSecret(secret),
    setOutput: (name: string, value: string | number) => core.setOutput(name, String(value)),
    info: (message: string) => core.info(message),
    notice: (message: string) => core.notice(message),
    warning: (message: string) => core.warning(message),
    error: (message: string) => core.error(message),
    setFailed: (message: string) => core.setFailed(message),
  };
}

export function extractEventContext(ctx = githubContext): EventContext {
  const pr = ctx.payload.pull_request as
    | {
        number?: number;
        draft?: boolean;
        head?: { repo?: { fork?: boolean; full_name?: string } };
        base?: { repo?: { full_name?: string } };
      }
    | undefined;

  const headFull = pr?.head?.repo?.full_name;
  const baseFull = pr?.base?.repo?.full_name;
  const isFork =
    Boolean(pr?.head?.repo?.fork) || (Boolean(headFull) && Boolean(baseFull) && headFull !== baseFull);

  return {
    eventName: ctx.eventName,
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    pullNumber: pr?.number ?? ctx.issue.number,
    isForkFromPayload: isFork,
    isDraftFromPayload: Boolean(pr?.draft),
  };
}

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  const promptTokens = (a.promptTokens ?? 0) + (b.promptTokens ?? 0);
  const candidateTokens = (a.candidateTokens ?? 0) + (b.candidateTokens ?? 0);
  const totalTokens = (a.totalTokens ?? 0) + (b.totalTokens ?? 0);
  return {
    promptTokens: a.promptTokens !== undefined || b.promptTokens !== undefined ? promptTokens : undefined,
    candidateTokens:
      a.candidateTokens !== undefined || b.candidateTokens !== undefined ? candidateTokens : undefined,
    totalTokens: a.totalTokens !== undefined || b.totalTokens !== undefined ? totalTokens : undefined,
  };
}

export async function run(deps: RunDependencies = {}): Promise<void> {
  const host = deps.host ?? createDefaultHost();

  // Immediately mask raw secrets before any parsing or logging can happen.
  const rawGeminiKey = host.getInput('gemini_api_key').trim();
  if (rawGeminiKey) {
    host.setSecret(rawGeminiKey);
    registerSecret(rawGeminiKey);
  }
  const rawGithubToken = host.getInput('github_token').trim();
  if (rawGithubToken) {
    host.setSecret(rawGithubToken);
    registerSecret(rawGithubToken);
  }

  let event: EventContext;
  try {
    event = deps.event ?? extractEventContext();
  } catch (err) {
    host.setFailed(`Failed to read GitHub event context: ${describeError(err)}`);
    return;
  }

  if (!event.pullNumber || Number.isNaN(event.pullNumber)) {
    host.setFailed(
      `This action must be run on a pull_request event (current event: "${event.eventName}").`,
    );
    return;
  }

  let config: ReviewerConfig;
  try {
    config = loadConfig((name) => host.getInput(name));
  } catch (err) {
    if (err instanceof MissingApiKeyError && event.isForkFromPayload) {
      host.notice(
        'Skipping Gemini PR review: pull request originates from a fork and GEMINI_API_KEY is not available to fork workflows.',
      );
      host.setOutput('reviewed_files', 0);
      host.setOutput('excluded_files', 0);
      host.setOutput('findings_count', 0);
      return;
    }
    if (err instanceof ConfigError) {
      host.setFailed(describeError(err));
      return;
    }
    host.setFailed(`Unexpected configuration error: ${describeError(err)}`);
    return;
  }

  const github = (deps.createGitHubClient ?? ((token) => new OctokitGitHubClient(token)))(
    config.githubToken,
  );
  const gemini = (
    deps.createGeminiClient ??
    ((apiKey, h) =>
      new GoogleGenAIClient(apiKey, {
        onRetry: (attempt, delayMs, error) => {
          h.warning(
            `Gemini request attempt ${attempt} failed (${describeError(error)}); retrying in ${delayMs}ms…`,
          );
        },
      }))
  )(config.geminiApiKey, host);

  let prHeadSha = '';
  let extracted: ExtractedDiff = {
    reviewed: [],
    excluded: [],
    totalDiffChars: 0,
    reachedGitHubFileLimit: false,
  };

  try {
    const pr = await github.getPullRequest(event.owner, event.repo, event.pullNumber);
    prHeadSha = pr.headSha;

    if (pr.draft) {
      host.info(`Pull request #${pr.number} is a draft; skipping Gemini review.`);
      host.setOutput('reviewed_files', 0);
      host.setOutput('excluded_files', 0);
      host.setOutput('findings_count', 0);
      return;
    }

    const rawFiles = await github.listPullRequestFiles(event.owner, event.repo, event.pullNumber);
    const filter = new FileFilter(config.ignorePatterns, config.useDefaultIgnores);
    extracted = extractDiff(rawFiles, {
      filter,
      maxFiles: config.maxFiles,
      maxDiffChars: config.maxDiffChars,
    });

    host.setOutput('reviewed_files', extracted.reviewed.length);
    host.setOutput('excluded_files', extracted.excluded.length);

    if (extracted.reviewed.length === 0) {
      host.info(
        `No reviewable files remained after filtering (${extracted.excluded.length} excluded). Posting skipped-review summary without calling Gemini.`,
      );
      const body = formatSkippedReviewComment({
        commentTitle: config.commentTitle,
        owner: event.owner,
        repo: event.repo,
        headSha: pr.headSha,
        model: config.model,
        extracted,
      });
      const published = await upsertReviewComment(
        github,
        event.owner,
        event.repo,
        event.pullNumber,
        body,
      );
      host.setOutput('risk_level', 'low');
      host.setOutput('findings_count', 0);
      host.setOutput('comment_id', published.id);
      host.setOutput('comment_url', published.htmlUrl);
      return;
    }

    let repoInstructions: string | undefined;
    if (config.instructionsFile) {
      repoInstructions = await github.getFileContent(
        event.owner,
        event.repo,
        config.instructionsFile,
        pr.baseSha,
      );
      if (repoInstructions) {
        host.info(`Loaded repository review instructions from "${config.instructionsFile}" (base branch).`);
      }
    }

    const builtPrompt = buildReviewPrompt({
      prNumber: pr.number,
      prTitle: pr.title,
      prBody: pr.body,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      reviewedFiles: extracted.reviewed,
      reviewLanguage: config.reviewLanguage,
      maxFindings: config.maxFindings,
      customInstructions: config.customInstructions,
      repoInstructions,
    });

    host.info(
      `Requesting Gemini review with model "${config.model}" (${extracted.reviewed.length} file(s), ${extracted.totalDiffChars} diff chars)…`,
    );

    const firstAttempt = await gemini.generateReview({
      model: config.model,
      systemInstruction: builtPrompt.systemInstruction,
      userPrompt: builtPrompt.userPrompt,
      temperature: config.temperature,
    });

    let totalUsage: TokenUsage = firstAttempt.usage;
    let validated: ValidatedReview;

    try {
      validated = validateAndGroundReview(
        firstAttempt.text,
        extracted.reviewed,
        config.maxFindings,
      );
    } catch (validationErr) {
      if (!(validationErr instanceof ResponseValidationError)) {
        throw validationErr;
      }
      host.warning(
        `Initial Gemini response failed validation (${describeError(validationErr)}). Requesting a single schema-repair pass…`,
      );
      const repairPrompt = buildRepairUserPrompt(
        builtPrompt.userPrompt,
        firstAttempt.text,
        validationErr.message,
        builtPrompt.nonce,
      );
      const secondAttempt = await gemini.generateReview({
        model: config.model,
        systemInstruction: builtPrompt.systemInstruction,
        userPrompt: repairPrompt,
        temperature: 0,
      });
      totalUsage = addTokens(totalUsage, secondAttempt.usage);
      validated = validateAndGroundReview(
        secondAttempt.text,
        extracted.reviewed,
        config.maxFindings,
      );
    }

    if (validated.discardedFindingsCount > 0) {
      host.info(
        `Discarded ${validated.discardedFindingsCount} finding(s) that referenced files outside the reviewed diff.`,
      );
    }
    if (validated.nulledLineCount > 0) {
      host.info(
        `Reset line number to null on ${validated.nulledLineCount} finding(s) whose line was not in the visible diff hunks.`,
      );
    }

    const body = formatReviewComment({
      commentTitle: config.commentTitle,
      owner: event.owner,
      repo: event.repo,
      headSha: pr.headSha,
      model: config.model,
      extracted,
      review: validated,
      usage: totalUsage,
    });

    const published = await upsertReviewComment(
      github,
      event.owner,
      event.repo,
      event.pullNumber,
      body,
    );

    host.setOutput('risk_level', validated.riskLevel);
    host.setOutput('findings_count', validated.findings.length);
    host.setOutput('comment_id', published.id);
    host.setOutput('comment_url', published.htmlUrl);
    host.info(
      `Published Gemini review comment (${published.updated ? 'updated' : 'created'}): ${published.htmlUrl}`,
    );
  } catch (err) {
    const safeMessage = describeError(err);

    if (prHeadSha) {
      try {
        const failureBody = formatFailureComment({
          commentTitle: config.commentTitle,
          owner: event.owner,
          repo: event.repo,
          headSha: prHeadSha,
          model: config.model,
          extracted,
          errorMessage: safeMessage,
        });
        const published = await upsertReviewComment(
          github,
          event.owner,
          event.repo,
          event.pullNumber,
          failureBody,
        );
        host.setOutput('comment_id', published.id);
        host.setOutput('comment_url', published.htmlUrl);
      } catch (commentErr) {
        host.warning(`Could not post failure notice comment on PR: ${describeError(commentErr)}`);
      }
    }

    if (config.failOnError) {
      host.setFailed(safeMessage);
    } else {
      host.warning(`Gemini PR review did not complete (fail_on_error=false): ${safeMessage}`);
    }
  }
}

