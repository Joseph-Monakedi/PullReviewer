/**
 * Structured output schema for the Gemini review response.
 *
 * We keep the Gemini `responseJsonSchema` flat and free of `$ref`/`oneOf` so it
 * stays within the JSON Schema subset supported by the Gemini API, and pair it
 * with a strict Zod schema for runtime validation after parsing.
 */
import { z } from 'zod';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const CATEGORIES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'testing',
  'style',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RawFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().nullable().optional(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  title: z.string().min(1),
  description: z.string().min(1),
  impact: z.string().optional().default(''),
  suggestion: z.string().optional().default(''),
  evidence: z.string().optional().default(''),
});

export const RawReviewResponseSchema = z.object({
  summary: z.string().min(1),
  risk_level: z.enum(RISK_LEVELS),
  findings: z.array(RawFindingSchema),
  positive_observations: z.array(z.string()).optional().default([]),
});

export type RawFinding = z.infer<typeof RawFindingSchema>;
export type RawReviewResponse = z.infer<typeof RawReviewResponseSchema>;

export interface ValidatedFinding {
  file: string;
  line: number | null;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  impact: string;
  suggestion: string;
  evidence: string;
}

export interface ValidatedReview {
  summary: string;
  riskLevel: RiskLevel;
  findings: ValidatedFinding[];
  positiveObservations: string[];
  discardedFindingsCount: number;
  nulledLineCount: number;
  cappedFindingsCount: number;
}

/**
 * Gemini-compatible JSON Schema (flat, no $ref or oneOf) passed as `responseJsonSchema`.
 */
export const REVIEW_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['summary', 'risk_level', 'findings', 'positive_observations'],
  properties: {
    summary: {
      type: 'string',
      description: 'Concise 2-4 sentence executive summary of the pull request changes and overall quality.',
    },
    risk_level: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'critical'],
      description: 'Overall merge risk of this pull request.',
    },
    findings: {
      type: 'array',
      description: 'Actionable code review findings ordered from highest to lowest severity.',
      items: {
        type: 'object',
        required: [
          'file',
          'line',
          'severity',
          'category',
          'title',
          'description',
          'impact',
          'suggestion',
          'evidence',
        ],
        properties: {
          file: {
            type: 'string',
            description: 'Exact repository-relative path of the reviewed file from the diff.',
          },
          line: {
            type: 'integer',
            nullable: true,
            description:
              'New-file line number shown in the left gutter of the annotated diff, or null for file-level issues.',
          },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
          },
          category: {
            type: 'string',
            enum: ['bug', 'security', 'performance', 'maintainability', 'testing', 'style'],
          },
          title: {
            type: 'string',
            description: 'Short, specific one-line title for the finding.',
          },
          description: {
            type: 'string',
            description: 'Clear explanation of what is wrong and why.',
          },
          impact: {
            type: 'string',
            description: 'Concrete runtime, security, or maintenance consequence if left unaddressed.',
          },
          suggestion: {
            type: 'string',
            description: 'Concrete, actionable recommendation or replacement code snippet.',
          },
          evidence: {
            type: 'string',
            description: 'Short code excerpt from the diff illustrating the issue.',
          },
        },
      },
    },
    positive_observations: {
      type: 'array',
      description: 'Brief callouts of well-written, well-tested, or thoughtful parts of the change.',
      items: {
        type: 'string',
      },
    },
  },
};

