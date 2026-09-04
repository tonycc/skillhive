import { describe, expect, it } from "vitest";
import { createKeyedRateLimiter } from "./request-rate-limit.js";

describe("createKeyedRateLimiter", () => {
  it("isolates authenticated callers by their selected key", () => {
    const limiter = createKeyedRateLimiter(60_000, 2);
    expect(limiter.consume("token-a", 1).allowed).toBe(true);
    expect(limiter.consume("token-a", 2).allowed).toBe(true);
    expect(limiter.consume("token-a", 3).allowed).toBe(false);
    expect(limiter.consume("token-b", 3).allowed).toBe(true);
  });

  it("allows a key again after its window expires", () => {
    const limiter = createKeyedRateLimiter(60_000, 1);
    expect(limiter.consume("shared-ip", 1).allowed).toBe(true);
    expect(limiter.consume("shared-ip", 2).allowed).toBe(false);
    expect(limiter.consume("shared-ip", 60_002).allowed).toBe(true);
  });
});
