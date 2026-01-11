type Entry = {
  count: number;
  resetAt: number;
};

export class RateLimiter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly entries: Map<string, Entry> = new Map();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.entries.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.limit - 1, resetAt };
    }

    if (entry.count >= this.limit) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }

    entry.count += 1;
    return { allowed: true, remaining: this.limit - entry.count, resetAt: entry.resetAt };
  }
}
