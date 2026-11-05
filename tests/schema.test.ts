import { describe, expect, it } from 'vitest';
import { INPUT_LIMITS, parseNotificationInput } from '../src/core/schema.js';

function issuesOf(raw: unknown): string[] {
  const result = parseNotificationInput(raw);
  if (result.ok) throw new Error('expected validation to fail');
  return result.issues;
}

describe('parseNotificationInput', () => {
  it('accepts a minimal input and defaults the priority', () => {
    expect(parseNotificationInput({ title: 'Build done', message: '0 errors' })).toEqual({
      ok: true,
      value: { title: 'Build done', message: '0 errors', priority: 'normal' },
    });
  });

  it('accepts a full input and trims text', () => {
    const result = parseNotificationInput({
      title: '  Unity Build abgeschlossen ',
      message: 'Build erfolgreich.\nDauer: 3 min\r\n\tfertig ',
      priority: 'urgent',
      source: 'claude-code',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        title: 'Unity Build abgeschlossen',
        message: 'Build erfolgreich.\nDauer: 3 min\r\n\tfertig',
        priority: 'urgent',
        source: 'claude-code',
      },
    });
  });

  it('requires title and message', () => {
    const issues = issuesOf({});
    expect(issues.some((i) => i.startsWith('title:'))).toBe(true);
    expect(issues.some((i) => i.startsWith('message:'))).toBe(true);
  });

  it('rejects whitespace-only text', () => {
    const issues = issuesOf({ title: '   ', message: '\n' });
    expect(issues).toHaveLength(2);
  });

  it('enforces length limits', () => {
    expect(
      parseNotificationInput({
        title: 't'.repeat(INPUT_LIMITS.title),
        message: 'm'.repeat(INPUT_LIMITS.message),
        source: 's'.repeat(INPUT_LIMITS.source),
      }).ok,
    ).toBe(true);

    const issues = issuesOf({
      title: 't'.repeat(INPUT_LIMITS.title + 1),
      message: 'm'.repeat(INPUT_LIMITS.message + 1),
      source: 's'.repeat(INPUT_LIMITS.source + 1),
    });
    expect(issues.map((i) => i.split(':')[0])).toEqual(['title', 'message', 'source']);
  });

  it('rejects line breaks in the title and control characters', () => {
    expect(issuesOf({ title: 'a\nb', message: 'x' })).toEqual([
      'title: must not contain line breaks or control characters',
    ]);
    expect(issuesOf({ title: 'a', message: 'bell\u0007' })).toEqual([
      'message: must not contain control characters',
    ]);
  });

  it('rejects unknown priorities', () => {
    expect(issuesOf({ title: 'a', message: 'b', priority: 'critical' })[0]).toMatch(/^priority:/);
  });

  it('rejects channel selection by callers', () => {
    const issues = issuesOf({ title: 'a', message: 'b', channels: ['telegram'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/channels/);
  });

  it('rejects unexpected fields such as recipient overrides', () => {
    const issues = issuesOf({ title: 'a', message: 'b', chat_id: '123', webhookUrl: 'https://x' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/chat_id/);
    expect(issues[0]).toMatch(/webhookUrl/);
  });

  it('restricts source to a safe character set', () => {
    expect(parseNotificationInput({ title: 'a', message: 'b', source: 'codex/cli:v1.2' }).ok).toBe(
      true,
    );
    expect(issuesOf({ title: 'a', message: 'b', source: '<b>x</b>' })[0]).toMatch(/^source:/);
  });

  it('rejects non-object input', () => {
    expect(issuesOf('hello')).toHaveLength(1);
    expect(issuesOf(null)).toHaveLength(1);
  });
});
