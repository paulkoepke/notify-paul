import { z } from 'zod';
import { PRIORITIES } from './types.js';

export const INPUT_LIMITS = {
  title: 200,
  message: 4000,
  source: 64,
} as const;

// eslint-disable-next-line no-control-regex
const TITLE_FORBIDDEN = /[\u0000-\u001F\u007F]/;
// Like TITLE_FORBIDDEN, but tab, line feed and carriage return are allowed.
// eslint-disable-next-line no-control-regex
const MESSAGE_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/;

/**
 * Shared by the MCP tool and `POST /notify`. Callers cannot pick channels or recipients;
 * unknown fields (e.g. `channels`, `chat_id`) are rejected by the strict object below.
 */
export const notificationInputShape = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_LIMITS.title)
    .refine((v) => !TITLE_FORBIDDEN.test(v), 'must not contain line breaks or control characters')
    .describe('Short headline, e.g. "Unity build finished".'),
  message: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_LIMITS.message)
    .refine((v) => !MESSAGE_FORBIDDEN.test(v), 'must not contain control characters')
    .describe('Plain-text body. Keep it concise; line breaks are allowed.'),
  priority: z
    .enum(PRIORITIES)
    .default('normal')
    .describe('"low" is delivered silently where supported, "urgent" as a high-priority alert.'),
  source: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_LIMITS.source)
    .regex(SOURCE_PATTERN, 'may only contain letters, digits, spaces and . _ : / -')
    .optional()
    .describe('Optional sender label shown in the notification, e.g. "claude-code".'),
};

export const notificationInputSchema = z.strictObject(notificationInputShape);

export type NotificationInput = z.input<typeof notificationInputSchema>;
export type ParsedNotificationInput = z.output<typeof notificationInputSchema>;

export type ParseResult =
  { ok: true; value: ParsedNotificationInput } | { ok: false; issues: string[] };

export function parseNotificationInput(raw: unknown): ParseResult {
  const result = notificationInputSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: result.error.issues.map(formatIssue) };
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
