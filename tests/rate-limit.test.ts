import { describe, expect, it } from "vitest";

import { SlidingWindowLimiter } from "../src/rate-limit.js";

describe("SlidingWindowLimiter", () => {
  it("rejects requests over the configured limit", () => {
    const limiter = new SlidingWindowLimiter(2, 60_000);

    expect(limiter.consume("user", 1_000)).toEqual({ allowed: true });
    expect(limiter.consume("user", 2_000)).toEqual({ allowed: true });
    expect(limiter.consume("user", 3_000)).toEqual({
      allowed: false,
      retryAfterMs: 58_000,
    });
  });

  it("forgets entries after the window", () => {
    const limiter = new SlidingWindowLimiter(1, 1_000);

    expect(limiter.consume("user", 1_000).allowed).toBe(true);
    expect(limiter.consume("user", 2_001).allowed).toBe(true);
  });

  it("caps tracked identities", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, 2);

    limiter.consume("a", 1_000);
    limiter.consume("b", 2_000);
    limiter.consume("c", 3_000);

    expect(limiter.trackedKeys).toBe(2);
    expect(limiter.consume("a", 4_000).allowed).toBe(true);
  });
});
