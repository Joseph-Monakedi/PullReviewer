import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../src/config.js';
import { GeminiError, clearRegisteredSecrets } from '../src/errors.js';
import type { GeminiClient } from '../src/gemini/client.js';
import type { GitHubClient, PullRequestDetails } from '../src/github/client.js';
import { type ActionHost, type EventContext, run } from '../src/main.js';
import { COMMENT_MARKER } from '../src/review/format.js';

interface TestHarness {
  host: ActionHost;
  outputs: Record<string, string | number>;
  secrets: string[];
  notices: string[];
  warnings: string[];
  failures: string[];
  github: GitHubClient;
  gemini: GeminiClient;
  event: EventContext;
}

const defaultPr: PullRequestDetails = {
  number: 12,
  title: 'Implement user service',
  body: 'Adds user lookup.',
  draft: false,
  headSha: '1111111222222233333334444444555555566666',
  headRef: 'feat/user-service',
  baseSha: '9999999888888877777776666666555555544444',
  baseRef: 'main',
  isFork: false,
  htmlUrl: 'https://github.com/acme/service/pull/12',
};

function createHarness(
  inputOverrides: Record<string, string> = {},
  eventOverrides: Partial<EventContext> = {},
): TestHarness {
  const inputs: Record<string, string> = {
    gemini_api_key: 'AIzaSyTestGeminiKey12345678901234567890',
    github_token: 'ghs_testGitHubToken12345678901234567890',
    ...inputOverrides,
  };
  const outputs: Record<string, string | number> = {};
  const secrets: string[] = [];
  const notices: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];

  const host: ActionHost = {
    getInput: (name: string) => inputs[name] ?? '',
    setSecret: (s: string) => secrets.push(s),
    setOutput: (name: string, val: string | number) => {
      outputs[name] = val;
    },
    info: vi.fn(),
    notice: (msg: string) => notices.push(msg),
    warning: (msg: string) => warnings.push(msg),
    error: vi.fn(),
    setFailed: (msg: string) => failures.push(msg),
  };

  const github: GitHubClient = {
    getPullRequest: vi.fn().mockResolvedValue(defaultPr),
    listPullRequestFiles: vi.fn().mockResolvedValue([
      {
        filename: 'src/user.ts',
        status: 'added',
        additions: 3,
        deletions: 0,
        changes: 3,
        patch: '@@ -0,0 +1,3 @@\n+export function getUser(id: string) {\n+  return id;\n+}',
      },
      {
        filename: 'package-lock.json',
        status: 'modified',
        additions: 50,
        deletions: 50,
        changes: 100,
        patch: '@@ -1,1 +1,1 @@\n-old\n+new',
      },
    ]),
    getFileContent: vi.fn().mockResolvedValue('Always check input types.'),
    listIssueComments: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue({
      id: 501,
      htmlUrl: 'https://github.com/acme/service/pull/12#issuecomment-501',
    }),
    updateIssueComment: vi.fn().mockResolvedValue({
      id: 501,
      htmlUrl: 'https://github.com/acme/service/pull/12#issuecomment-501',
    }),
  };

  const gemini: GeminiClient = {
    generateReview: vi.fn().mockResolvedValue({
      text: JSON.stringify({
        summary: 'Clean implementation with one medium finding.',
        risk_level: 'medium',
        findings: [
          {
            file: 'src/user.ts',
            line: 2,
            severity: 'medium',
            category: 'bug',
            title: 'Missing validation on id',
            description: 'Validate that id is non-empty.',
            impact: 'Empty user lookups may hit downstream caches.',
            suggestion: 'if (!id.trim()) throw new Error("Invalid id");',
            evidence: 'return id;',
          },
        ],
        positive_observations: ['Simple, focused function.'],
      }),
      usage: { promptTokens: 200, candidateTokens: 80, totalTokens: 280 },
    }),
  };

  const event: EventContext = {
    eventName: 'pull_request',
    owner: 'acme',
    repo: 'service',
    pullNumber: 12,
    isForkFromPayload: false,
    isDraftFromPayload: false,
    ...eventOverrides,
  };

  return { host, outputs, secrets, notices, warnings, failures, github, gemini, event };
}

describe('main orchestration (end-to-end)', () => {
  beforeEach(() => {
    clearRegisteredSecrets();
  });

  it('completes the happy path: masks secrets, reads base instructions, calls Gemini, and upserts comment', async () => {
    const h = createHarness();
    await run({
      host: h.host,
      event: h.event,
      createGitHubClient: () => h.github,
      createGeminiClient: () => h.gemini,
    });

    expect(h.failures).toEqual([]);
    expect(h.secrets).toHaveLength(2);
    expect(h.github.getFileContent).toHaveBeenCalledWith(
      'acme',
      'service',
      DEFAULTS.instructionsFile,
      defaultPr.baseSha,
    );
    expect(h.outputs).toEqual({
      reviewed_files: 1,
      excluded_files: 1,
      risk_level: 'medium',
      findings_count: 1,
      comment_id: 501,
      comment_url: 'https://github.com/acme/service/pull/12#issuecomment-501',
    });

    const bodyArg = vi.mocked(h.github.createIssueComment).mock.calls[0]?.[3] ?? '';
    expect(bodyArg).toContain(COMMENT_MARKER);
    expect(bodyArg).toContain('Missing validation on id');
    expect(bodyArg).toContain(
      'https://github.com/acme/service/blob/1111111222222233333334444444555555566666/src/user.ts#L2',
    );
  });

  it('re-asks Gemini once when the first response is malformed JSON', async () => {
    const h = createHarness();
    vi.mocked(h.gemini.generateReview)
      .mockResolvedValueOnce({
        text: 'not valid json {{{',
        usage: { promptTokens: 100, candidateTokens: 20, totalTokens: 120 },
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          summary: 'Recovered on repair attempt.',
          risk_level: 'low',
          findings: [],
          positive_observations: [],
        }),
        usage: { promptTokens: 150, candidateTokens: 30, totalTokens: 180 },
      });

    await run({
      host: h.host,
      event: h.event,
      createGitHubClient: () => h.github,
      createGeminiClient: () => h.gemini,
    });

    expect(h.failures).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.gemini.generateReview).toHaveBeenCalledTimes(2);
    expect(h.outputs.risk_level).toBe('low');
    expect(h.outputs.findings_count).toBe(0);
  });

  it('exits neutrally with a notice when triggered by a fork PR without GEMINI_API_KEY', async () => {
    const h = createHarness(
      { gemini_api_key: '' },
      { isForkFromPayload: true },
    );

    await run({
      host: h.host,
      event: h.event,
      createGitHubClient: () => h.github,
      createGeminiClient: () => h.gemini,
    });

    expect(h.failures).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('fork');
    expect(h.gemini.generateReview).not.toHaveBeenCalled();
  });

  it('fails when GEMINI_API_KEY is missing on a same-repo PR', async () => {
    const h = createHarness(
      { gemini_api_key: '' },
      { isForkFromPayload: false },
    );

    await run({
      host: h.host,
      event: h.event,
      createGitHubClient: () => h.github,
      createGeminiClient: () => h.gemini,
    });

    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toContain('gemini_api_key');
  });

  it('skips draft PRs without calling Gemini or posting a comment', async () => {
    const h = createHarness();
    vi.mocked(h.github.getPullRequest).mockResolvedValue({
      ...defaultPr,
      draft: true,
    });

    await run({
      host: h.host,
      event: h.event,
      createGitHubClient: () => h.github,
      createGeminiClient: () => h.gemini,
    });

    expect(h.failures).toEqual([]);
    expect(h.gemini.generateReview).not.toHaveBeenCalled();
    expect(h.github.createIssueComment).not.toHaveBeenCalled();
  });

  it('posts a skipped-review comment and does not call Gemini when all files are excluded', async () => {
    const h = createHarness();
    vi.mocked(h.github.listPullRequestFiles).mockResolvedValue([
      {
        filename: 'package-lock.json',
        status: 'modified',
        additions: 10,
        deletions: 10,
        changes: 20,
        patch: '@@ -1 +1 @@\n-a\n+b',
      },
    ]);

    await run({
      host: h.host,
      event: h.event,
      createGitHubClient: () => h.github,
      createGeminiClient: () => h.gemini,
    });

    expect(h.failures).toEqual([]);
    expect(h.gemini.generateReview).not.toHaveBeenCalled();
    expect(h.github.createIssueComment).toHaveBeenCalledTimes(1);
    expect(h.outputs.reviewed_files).toBe(0);
    expect(h.outputs.excluded_files).toBe(1);
  });

  it('upserts a failure comment and calls setFailed when Gemini fails (or warns if fail_on_error=false)', async () => {
    const hFail = createHarness({ fail_on_error: 'true' });
    vi.mocked(hFail.gemini.generateReview).mockRejectedValue(
      new GeminiError('Quota exceeded (HTTP 429)', 429, false),
    );

    await run({
      host: hFail.host,
      event: hFail.event,
      createGitHubClient: () => hFail.github,
      createGeminiClient: () => hFail.gemini,
    });

    expect(hFail.failures).toHaveLength(1);
    expect(hFail.github.createIssueComment).toHaveBeenCalledTimes(1);
    const failureComment = vi.mocked(hFail.github.createIssueComment).mock.calls[0]?.[3] ?? '';
    expect(failureComment).toContain('Automated review could not be completed');

    // Now verify fail_on_error: false downgrades step failure to a warning
    const hWarn = createHarness({ fail_on_error: 'false' });
    vi.mocked(hWarn.gemini.generateReview).mockRejectedValue(
      new GeminiError('Quota exceeded (HTTP 429)', 429, false),
    );

    await run({
      host: hWarn.host,
      event: hWarn.event,
      createGitHubClient: () => hWarn.github,
      createGeminiClient: () => hWarn.gemini,
    });

    expect(hWarn.failures).toEqual([]);
    expect(hWarn.warnings.some((w) => w.includes('fail_on_error=false'))).toBe(true);
  });
});

