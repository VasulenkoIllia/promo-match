import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

function clockAt(startMs = 0) {
  const clock = { ms: startMs };
  return { clock, now: () => clock.ms };
}

describe("RateLimiter", () => {
  it("lets the limit through, then says how many seconds are left", () => {
    const { clock, now } = clockAt();
    const limiter = new RateLimiter(2, 60_000, now);
    expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBeNull();
    clock.ms = 20_500;
    expect(limiter.take("a")).toBe(40);
  });

  it("starts over when the window ends", () => {
    const { clock, now } = clockAt();
    const limiter = new RateLimiter(1, 60_000, now);
    limiter.take("a");
    clock.ms = 60_000;
    expect(limiter.take("a")).toBeNull();
  });

  it("counts each key apart, and reset clears one", () => {
    const limiter = new RateLimiter(1, 60_000, clockAt().now);
    limiter.take("a");
    expect(limiter.take("b")).toBeNull();
    expect(limiter.take("a")).not.toBeNull();
    limiter.reset("a");
    expect(limiter.take("a")).toBeNull();
  });

  it("does not grow past its bound: the oldest window goes first", () => {
    const limiter = new RateLimiter(1, 60_000, clockAt().now);
    limiter.take("first");
    limiter.take("second");
    for (let index = 0; index < 10_000; index += 1) limiter.take(`key${index}`);
    expect(limiter.take("first")).toBeNull();
    expect(limiter.take("key9999")).not.toBeNull();
  });
});
