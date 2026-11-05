/** Global in-memory sliding-window limit; every accepted request counts, regardless of priority. */
export class RateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and returns true, or returns false if the limit is reached. */
  tryAcquire(): boolean {
    const t = this.now();
    while (this.hits.length > 0 && this.hits[0]! <= t - this.windowMs) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t);
    return true;
  }
}
