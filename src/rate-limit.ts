export interface LimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export class SlidingWindowLimiter {
  private readonly entries = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  get trackedKeys(): number {
    return this.entries.size;
  }

  consume(key: string, now = Date.now()): LimitResult {
    if (!this.entries.has(key) && this.entries.size >= this.maxKeys) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    const cutoff = now - this.windowMs;
    const active = (this.entries.get(key) ?? []).filter((time) => time > cutoff);

    if (active.length >= this.limit) {
      this.entries.set(key, active);
      const oldest = active[0] ?? now;
      return { allowed: false, retryAfterMs: oldest + this.windowMs - now };
    }

    active.push(now);
    this.entries.set(key, active);
    return { allowed: true };
  }
}
