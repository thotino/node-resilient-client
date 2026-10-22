import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter, RateLimiterAlgorithms } from "../RateLimiter";

const algorithms = Object.values(RateLimiterAlgorithms);

describe("RateLimiter", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        [RateLimiterAlgorithms.FIXED_WINDOW, 100],
        [RateLimiterAlgorithms.SLIDING_WINDOW, 100],
        [RateLimiterAlgorithms.SLIDING_WINDOW_COUNTER, 100],
        [RateLimiterAlgorithms.TOKEN_BUCKET, 10],
    ] as const)(
        "exposes the default capacity for %s",
        (algorithm, capacity) => {
            expect(new RateLimiter(algorithm).maxRequests).toBe(capacity);
        },
    );

    it("enforces a fixed-window limit and resets at the next window boundary", () => {
        vi.useFakeTimers();
        vi.setSystemTime(59_999);
        const limiter = new RateLimiter(RateLimiterAlgorithms.FIXED_WINDOW);

        for (let request = 0; request < limiter.maxRequests; request++) {
            const result = limiter.attempt("client");
            expect(result.allowed).toBe(true);
        }
        const rejected = limiter.attempt("client");
        expect(rejected).toEqual({
            allowed: false,
            remaining: 0,
        });
        // Fixed-window denials do not expose a retryAfter or resetAt value.
        expect(rejected).not.toHaveProperty("retryAfter");
        expect(rejected).not.toHaveProperty("resetAt");

        vi.setSystemTime(60_000);
        expect(limiter.attempt("client")).toEqual({
            allowed: true,
            remaining: 99,
        });
    });

    it("uses a rolling request log and reports when the oldest request expires", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const limiter = new RateLimiter(RateLimiterAlgorithms.SLIDING_WINDOW);

        for (let request = 0; request < limiter.maxRequests; request++) {
            expect(limiter.attempt("client").allowed).toBe(true);
        }
        expect(limiter.attempt("client")).toEqual({
            allowed: false,
            remaining: 0,
            resetAt: 60_000,
        });

        vi.setSystemTime(59_999);
        expect(limiter.attempt("client")).toEqual({
            allowed: false,
            remaining: 0,
            resetAt: 60_000,
        });
        vi.setSystemTime(60_000);
        expect(limiter.attempt("client")).toEqual({
            allowed: true,
            remaining: 99,
        });
    });

    it("weights the previous window in the sliding-window counter", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const limiter = new RateLimiter(
            RateLimiterAlgorithms.SLIDING_WINDOW_COUNTER,
        );

        for (let request = 0; request < limiter.maxRequests; request++) {
            expect(limiter.attempt("client").allowed).toBe(true);
        }

        vi.setSystemTime(60_000);
        const rejected = limiter.attempt("client");
        expect(rejected).toEqual({
            allowed: false,
            remaining: 0,
            currentCount: 100,
        });
        // currentCount is a weighted count, not a retry-time estimate.
        expect(rejected).not.toHaveProperty("retryAfter");
        expect(rejected).not.toHaveProperty("resetAt");

        vi.setSystemTime(90_000);
        expect(limiter.attempt("client")).toEqual({
            allowed: true,
            remaining: 49,
        });

        vi.setSystemTime(120_000);
        expect(limiter.attempt("client")).toEqual({
            allowed: true,
            remaining: 98,
        });
    });

    it("consumes token-bucket capacity and refills tokens over elapsed time", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const limiter = new RateLimiter(RateLimiterAlgorithms.TOKEN_BUCKET);

        for (let request = 0; request < limiter.maxRequests; request++) {
            expect(limiter.attempt("client").allowed).toBe(true);
        }
        expect(limiter.attempt("client")).toEqual({
            allowed: false,
            remaining: 0,
            retryAfter: 1,
        });

        vi.advanceTimersByTime(1_500);
        expect(limiter.attempt("client")).toEqual({
            allowed: true,
            remaining: 0,
            retryAfter: 0,
        });
        expect(limiter.attempt("client")).toEqual({
            allowed: false,
            remaining: 0,
            retryAfter: 1,
        });
    });

    it.each(algorithms)(
        "starts and stops the cleanup interval for %s without leaking timers",
        algorithm => {
            vi.useFakeTimers();
            const limiter = new RateLimiter(algorithm);

            expect(vi.getTimerCount()).toBe(0);
            limiter.connect();
            limiter.connect();
            expect(vi.getTimerCount()).toBe(1);

            vi.advanceTimersByTime(60_000);
            expect(vi.getTimerCount()).toBe(1);

            limiter.close();
            limiter.close();
            expect(vi.getTimerCount()).toBe(0);

            vi.advanceTimersByTime(60_000);
            expect(vi.getTimerCount()).toBe(0);
        },
    );
});
