/** Only suppress EADDRINUSE when the existing listener identifies itself as NotifyPaul. */
export async function isNotifyPaulRunning(host: string, port: number): Promise<boolean> {
  const address =
    host === '0.0.0.0'
      ? '127.0.0.1'
      : host === '::'
        ? '[::1]'
        : host.includes(':')
          ? `[${host}]`
          : host;
  try {
    const response = await fetch(`http://${address}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown; service?: unknown };
    return body.status === 'ok' && body.service === 'notify-paul';
  } catch {
    return false;
  }
}
