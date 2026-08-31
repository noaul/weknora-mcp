import { describe, expect, it, vi } from "vitest";

import { retry } from "../src/retry.js";

describe("retry", () => {
  it("waits for a transient dependency to become ready", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue("ready");
    const sleep = vi.fn(async () => undefined);

    await expect(
      retry(operation, { attempts: 3, delayMs: 1_000, sleep }),
    ).resolves.toBe("ready");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns the final error after all attempts", async () => {
    const failure = new Error("still unavailable");
    await expect(
      retry(async () => Promise.reject(failure), {
        attempts: 2,
        delayMs: 0,
        sleep: async () => undefined,
      }),
    ).rejects.toBe(failure);
  });
});
