import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidRetryOptionError } from "../errors/InvalidRetryOptionError";
import { GlobalTimeoutError } from "../errors/GlobalTimeoutError";
import { ResilienceError } from "../errors/ResilienceError";
import { JitterStatuses } from "../constants";
import type { RetryOptions } from "../types";
import { Retry } from "../Retry";

const { setTimeoutPromise } = vi.hoisted(() => ({
    setTimeoutPromise:
        vi.fn<
            (
                delay: number,
                value: unknown,
                options?: { signal?: AbortSignal },
            ) => Promise<unknown>
        >(),
}));

vi.mock("node:timers/promises", () => ({
    setTimeout: setTimeoutPromise,
}));

const defaultOptions: RetryOptions = {
    maxAttempts: 3,
    initialDelay: 1,
    maxDelay: 100,
    factor: 2,
    jitter: JitterStatuses.NONE,
    timeout: 100,
    retryableErrors: [],
    retryableStatusCodes: [],
};

function createRetry(options: Partial<RetryOptions> = {}) {
    return new Retry({ ...defaultOptions, ...options });
}

function retryableError(message: string) {
    return new Error(message, { cause: { code: "ECONNRESET" } });
}

function retryAfterError(value: string) {
    return new ResilienceError(
        "service unavailable",
        "ERR_SERVICE_UNAVAILABLE",
        true,
        true,
        new Response(null, {
            status: 503,
            headers: { "retry-after": value },
        }),
    );
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("Retry", () => {
    beforeEach(() => {
        setTimeoutPromise.mockReset();
        setTimeoutPromise.mockImplementation((delay, value, options) => {
            const signal = options?.signal;
            return new Promise((resolve, reject) => {
                const makeAbortError = () => {
                    const error = new Error("The operation was aborted", {
                        cause: signal?.reason,
                    });
                    error.name = "AbortError";
                    return Object.assign(error, { code: "ABORT_ERR" });
                };
                if (signal?.aborted) {
                    reject(makeAbortError());
                    return;
                }

                const onAbort = () => {
                    globalThis.clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    reject(makeAbortError());
                };
                const timer = globalThis.setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve(value);
                }, delay);
                signal?.addEventListener("abort", onAbort, { once: true });
            });
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        { option: "maxAttempts", value: 0 },
        { option: "maxAttempts", value: -1 },
        { option: "maxAttempts", value: 1.5 },
        { option: "initialDelay", value: 0 },
        { option: "initialDelay", value: Number.NaN },
        { option: "maxDelay", value: 0 },
        { option: "maxDelay", value: 0.5 },
        { option: "factor", value: 0 },
        { option: "factor", value: Number.POSITIVE_INFINITY },
        { option: "timeout", value: 0 },
        { option: "timeout", value: Number.NaN },
    ])("rejects invalid options ($option)", ({ option, value }) => {
        expect(() => createRetry({ [option]: value })).toThrow(
            InvalidRetryOptionError,
        );
        expect(() => createRetry({ [option]: value })).toThrow(
            "One or several options are invalid",
        );
    });

    it("returns the first successful result without retrying", async () => {
        const retry = createRetry();
        const operation = vi.fn(async () => "ok");

        await expect(
            retry.execute(operation, {
                cancelSignal: new AbortController().signal,
            }),
        ).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("does not start an attempt when already cancelled", async () => {
        const retry = createRetry();
        const cancelController = new AbortController();
        const operation = vi.fn(async () => "must not run");
        cancelController.abort();

        await expect(
            retry.execute(operation, {
                cancelSignal: cancelController.signal,
            }),
        ).rejects.toBeInstanceOf(GlobalTimeoutError);
        expect(operation).not.toHaveBeenCalled();
        expect(retry.getMetrics()).toEqual({
            attempts: 0,
            attemptsDurationMS: 0,
        });
    });

    it("retries once after a transient error and then succeeds", async () => {
        vi.useFakeTimers();
        const retry = createRetry();
        const operation = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(retryableError("temporary failure"))
            .mockResolvedValueOnce("ok");

        const execution = retry.execute(operation, {
            cancelSignal: new AbortController().signal,
        });
        await vi.advanceTimersByTimeAsync(10);

        await expect(execution).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("retries errors explicitly configured by code or status", async () => {
        vi.useFakeTimers();
        const cases = [
            {
                options: { retryableErrors: ["E_CUSTOM"] },
                error: new Error("custom transient", {
                    cause: { code: "E_CUSTOM" },
                }),
            },
            {
                options: { retryableStatusCodes: [418] },
                error: new Error("custom transient status", {
                    cause: new Response(null, { status: 418 }),
                }),
            },
        ];

        for (const { options, error } of cases) {
            const retry = createRetry(options);
            const operation = vi
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce("ok");
            const execution = retry.execute(operation, {
                cancelSignal: new AbortController().signal,
            });

            await vi.advanceTimersByTimeAsync(1);
            await expect(execution).resolves.toBe("ok");
            expect(operation).toHaveBeenCalledTimes(2);
        }
    });

    it("uses exponential backoff and caps each delay at maxDelay", async () => {
        vi.useFakeTimers();
        const retry = createRetry({
            maxAttempts: 4,
            initialDelay: 10,
            factor: 2,
            maxDelay: 25,
        });
        const callTimes: number[] = [];
        const operation = vi.fn<() => Promise<string>>(() => {
            callTimes.push(Date.now());
            return callTimes.length < 4
                ? Promise.reject(retryableError("temporary failure"))
                : Promise.resolve("ok");
        });
        const start = Date.now();

        const execution = retry.execute(operation, {
            cancelSignal: new AbortController().signal,
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(callTimes).toEqual([start, start + 10]);
        await vi.advanceTimersByTimeAsync(20);
        expect(callTimes).toEqual([start, start + 10, start + 30]);
        await vi.advanceTimersByTimeAsync(25);

        await expect(execution).resolves.toBe("ok");
        expect(callTimes).toEqual([start, start + 10, start + 30, start + 55]);
        expect(operation).toHaveBeenCalledTimes(4);
    });

    it.each([
        { jitter: JitterStatuses.NONE, delay: 20, randomCalls: 0 },
        { jitter: JitterStatuses.FULL, delay: 10, randomCalls: 1 },
        { jitter: JitterStatuses.EQUAL, delay: 15, randomCalls: 1 },
        { jitter: JitterStatuses.DECORRELATE, delay: 40, randomCalls: 1 },
    ])(
        "applies $jitter jitter to the retry delay",
        async ({ jitter, delay, randomCalls }) => {
            vi.useFakeTimers();
            const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
            const retry = createRetry({
                maxAttempts: 2,
                initialDelay: 20,
                maxDelay: 100,
                jitter,
            });
            const callTimes: number[] = [];
            const operation = vi.fn<() => Promise<string>>(() => {
                callTimes.push(Date.now());
                return callTimes.length === 1
                    ? Promise.reject(retryableError("temporary failure"))
                    : Promise.resolve("ok");
            });
            const start = Date.now();

            const execution = retry.execute(operation, {
                cancelSignal: new AbortController().signal,
            });
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(operation).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);

            await expect(execution).resolves.toBe("ok");
            expect(callTimes).toEqual([start, start + delay]);
            expect(random).toHaveBeenCalledTimes(randomCalls);
        },
    );

    it("wraps a non-retryable error and stops immediately", async () => {
        const retry = createRetry();
        const error = new Error("invalid request");
        const operation = vi.fn(async () => {
            throw error;
        });

        const rejection = await retry
            .execute(operation, {
                cancelSignal: new AbortController().signal,
            })
            .catch((reason: unknown) => reason);

        expect(rejection).toBeInstanceOf(ResilienceError);
        expect(rejection).not.toBeInstanceOf(TypeError);
        expect(rejection).toMatchObject({
            message: "invalid request",
            isRetryable: false,
            isCircuitBreakerFailure: false,
        });
        expect(rejection).toHaveProperty("cause", error);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("preserves an existing ResilienceError without retrying", async () => {
        const retry = createRetry();
        const error = new ResilienceError(
            "already classified",
            "ERR_CUSTOM",
            false,
            true,
            null,
        );
        const operation = vi.fn(async () => {
            throw error;
        });

        await expect(
            retry.execute(operation, {
                cancelSignal: new AbortController().signal,
            }),
        ).rejects.toBe(error);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("converts a rejected non-Error value to a ResilienceError", async () => {
        const retry = createRetry();
        const operation = vi.fn(async () => {
            throw { reason: "invalid request" };
        });

        await expect(
            retry.execute(operation, {
                cancelSignal: new AbortController().signal,
            }),
        ).rejects.toMatchObject({
            message: '{"reason":"invalid request"}',
            isRetryable: false,
            isCircuitBreakerFailure: false,
        });
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("propagates the last classified error when all attempts fail", async () => {
        vi.useFakeTimers();
        const retry = createRetry({ maxAttempts: 3 });
        const lastError = retryableError("third failure");
        const operation = vi
            .fn<() => Promise<never>>()
            .mockRejectedValueOnce(retryableError("first failure"))
            .mockRejectedValueOnce(retryableError("second failure"))
            .mockRejectedValueOnce(lastError);

        const execution = retry.execute(operation, {
            cancelSignal: new AbortController().signal,
        });
        const rejection = execution.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10);

        const error = await rejection;
        expect(error).toMatchObject({
            message: "third failure",
            isRetryable: true,
            isCircuitBreakerFailure: true,
        });
        expect(error).toHaveProperty("cause", lastError);
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it("retries local attempt timeouts as retryable ResilienceErrors", async () => {
        const retry = createRetry({ timeout: 10 });
        const operation = vi.fn(
            ({ signal }: { signal: AbortSignal }) =>
                new Promise<never>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(signal.reason),
                        { once: true },
                    );
                }),
        );

        const execution = retry.execute(operation, {
            cancelSignal: new AbortController().signal,
        });
        const rejection = execution.catch((error: unknown) => error);

        const error = await rejection;
        expect(error).toBeInstanceOf(ResilienceError);
        expect(error).toMatchObject({
            code: "ERR_ATTEMPT_TIMEOUT",
            isRetryable: true,
            isCircuitBreakerFailure: true,
        });
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it("does not start another attempt when cancellation occurs during backoff", async () => {
        vi.useFakeTimers();
        const retry = createRetry({ initialDelay: 50 });
        const cancelController = new AbortController();
        const operation = vi
            .fn<() => Promise<never>>()
            .mockRejectedValue(retryableError("temporary failure"));

        const execution = retry.execute(operation, {
            cancelSignal: cancelController.signal,
        });
        await Promise.resolve();
        await Promise.resolve();
        cancelController.abort();

        await expect(execution).rejects.toMatchObject({ name: "AbortError" });
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("aborts an in-flight request at the global deadline and prevents late effects", async () => {
        vi.useFakeTimers();
        const retry = createRetry({ timeout: 1_000 });
        const cancelController = new AbortController();
        const deadlineError = new Error("global deadline exceeded");
        const lateCompletion = deferred<string>();
        const effects: string[] = [];
        let requestSignal: AbortSignal | undefined;
        let abortEvents = 0;
        const operation = vi.fn(({ signal }: { signal: AbortSignal }) => {
            requestSignal = signal;
            return new Promise<string>((resolve, reject) => {
                signal.addEventListener(
                    "abort",
                    () => {
                        abortEvents += 1;
                        reject(signal.reason);
                    },
                    { once: true },
                );
                void lateCompletion.promise.then(value => {
                    if (!signal.aborted) effects.push(value);
                    resolve(value);
                });
            });
        });
        const execution = retry.execute(operation, {
            cancelSignal: cancelController.signal,
        });
        const rejection = execution.catch((error: unknown) => error);
        setTimeout(() => cancelController.abort(deadlineError), 25);

        await vi.advanceTimersByTimeAsync(25);
        const error = await rejection;

        expect(requestSignal?.aborted).toBe(true);
        expect(requestSignal?.reason).toBe(deadlineError);
        expect(abortEvents).toBe(1);
        expect(error).toBeInstanceOf(ResilienceError);
        expect(error).toMatchObject({
            message: "global deadline exceeded",
            code: "ERR_UNEXPECTED_ERROR",
            isRetryable: false,
            isCircuitBreakerFailure: false,
        });
        expect(error).toHaveProperty("cause", deadlineError);
        expect(operation).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        lateCompletion.resolve("late response");
        await vi.advanceTimersByTimeAsync(0);
        expect(effects).toEqual([]);
        expect(operation).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cleans up the attempt timeout while waiting for backoff and after success", async () => {
        vi.useFakeTimers();
        const retry = createRetry({ initialDelay: 20, timeout: 100 });
        const operation = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(retryableError("temporary failure"))
            .mockResolvedValueOnce("ok");
        const execution = retry.execute(operation, {
            cancelSignal: new AbortController().signal,
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(operation).toHaveBeenCalledTimes(1);
        // Only the retry backoff remains; the first attempt's timeout was cleared.
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(20);
        await expect(execution).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("uses a Retry-After delay in seconds instead of the configured backoff", async () => {
        vi.useFakeTimers();
        const retry = createRetry({
            initialDelay: 10,
            maxDelay: 5_000,
            jitter: JitterStatuses.NONE,
        });
        const operation = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(retryAfterError("2"))
            .mockResolvedValueOnce("ok");

        const execution = retry.execute(operation, {
            cancelSignal: new AbortController().signal,
        });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(operation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);

        await expect(execution).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("parses an HTTP-date Retry-After header", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-22T00:00:00.000Z"));
        const retry = createRetry({
            initialDelay: 10,
            maxDelay: 5_000,
            jitter: JitterStatuses.NONE,
        });
        const retryAt = new Date(Date.now() + 2_000).toUTCString();
        const operation = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(retryAfterError(retryAt))
            .mockResolvedValueOnce("ok");

        const execution = retry.execute(operation, {
            cancelSignal: new AbortController().signal,
        });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(operation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);

        await expect(execution).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("does not retry when Retry-After exceeds maxDelay", async () => {
        vi.useFakeTimers();
        const retry = createRetry({ maxDelay: 500 });
        const error = retryAfterError("1");
        const operation = vi
            .fn<() => Promise<string>>()
            .mockRejectedValue(error);

        await expect(
            retry.execute(operation, {
                cancelSignal: new AbortController().signal,
            }),
        ).rejects.toBe(error);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("uses configured backoff when Retry-After is not in the error cause", async () => {
        vi.useFakeTimers();
        const retry = createRetry({
            initialDelay: 20,
            maxDelay: 500,
            jitter: JitterStatuses.NONE,
        });
        const error = Object.assign(retryableError("service unavailable"), {
            response: {
                status: 503,
                headers: new Headers({ "retry-after": "1" }),
            },
        });
        const operation = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce("ok");

        const execution = retry.execute(operation, {
            cancelSignal: new AbortController().signal,
        });
        await vi.advanceTimersByTimeAsync(19);
        expect(operation).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);

        await expect(execution).resolves.toBe("ok");
        expect(operation).toHaveBeenCalledTimes(2);
    });
});
