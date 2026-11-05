import type { SendOutcome } from './channel.js';

/** Never return response bodies or exception messages: they may contain credentials. */
export async function postJson(
  url: string,
  body: unknown,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<SendOutcome> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      await response.body?.cancel();
      return { ok: true };
    }
    if (response.status === 429) {
      const data = (await response.json().catch(() => null)) as { retry_after?: unknown } | null;
      const raw = response.headers.get('retry-after');
      const seconds =
        typeof data?.retry_after === 'number' ? data.retry_after : raw === null ? NaN : Number(raw);
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : raw
          ? Date.parse(raw) - Date.now()
          : NaN;
      return {
        ok: false,
        error: 'rate_limited',
        ...(Number.isFinite(delay) && delay >= 0 ? { retryAfterMs: delay } : {}),
      };
    }
    await response.body?.cancel();
    return {
      ok: false,
      error:
        response.status === 401 || response.status === 403
          ? 'provider_auth_failed'
          : response.status >= 500
            ? 'provider_error'
            : 'provider_rejected',
    };
  } catch {
    return { ok: false, error: signal.aborted ? 'provider_timeout' : 'provider_unreachable' };
  }
}
