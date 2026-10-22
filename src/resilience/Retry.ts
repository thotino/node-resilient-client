/**
 * @see https://oneuptime.com/blog/post/2026-01-06-nodejs-retry-exponential-backoff/view
 */

import { CustomTimeoutError } from "./errors/CustomTimeoutError";
import { GlobalTimeoutError } from "./errors/GlobalTimeoutError";
import { InvalidRetryOptionError } from "./errors/InvalidRetryOptionError";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import type { ResilienceErrorInterface, RetryOptions } from "./types";
import { ResilienceError } from "./errors/ResilienceError";
import { JitterStatuses } from "./constants";
const RETRYABLE_ERRORS = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ENOTFOUND",
    "ENETUNREACH",
    "EAI_AGAIN",
]);
const RETRYABLE_STATUS_CODES = new Set<number>([408, 429, 500, 502, 503, 504]);

const DEFAULT_OPTIONS: RetryOptions = {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 30_000,
    factor: 2,
    jitter: JitterStatuses.FULL,
    timeout: 3_000,
    retryableErrors: [],
    retryableStatusCodes: [],
};
export class Retry {
    #maxAttempts: number = 5;
    #initialDelay: number = 1000;
    #maxDelay: number = 30000;
    #factor: number = 2;
    #jitter: JitterStatuses = JitterStatuses.FULL;
    #timeout: number = 30000;
    #retryableErrors: Set<string>;
    #retryableStatusCodes: Set<number>;
    #metrics: {
        totalAttempts: number;
        totalAttemptsDurationMs: number;
    } = { totalAttempts: 0, totalAttemptsDurationMs: 0 };
    constructor(options: Partial<RetryOptions>) {
        const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
        if (
            !Number.isInteger(resolvedOptions.maxAttempts) ||
            resolvedOptions.maxAttempts < 1 ||
            !Number.isFinite(resolvedOptions.factor) ||
            resolvedOptions.factor <= 0 ||
            !Number.isFinite(resolvedOptions.timeout) ||
            resolvedOptions.timeout <= 0 ||
            !Number.isFinite(resolvedOptions.initialDelay) ||
            resolvedOptions.initialDelay <= 0 ||
            !Number.isFinite(resolvedOptions.maxDelay) ||
            resolvedOptions.maxDelay <= 0 ||
            resolvedOptions.maxDelay < resolvedOptions.initialDelay
        ) {
            throw new InvalidRetryOptionError();
        }
        this.#maxAttempts = resolvedOptions.maxAttempts;
        this.#initialDelay = resolvedOptions.initialDelay;
        this.#maxDelay = resolvedOptions.maxDelay;
        this.#factor = resolvedOptions.factor;
        this.#jitter = resolvedOptions.jitter;
        this.#timeout = resolvedOptions.timeout;
        this.#retryableErrors = new Set([
            ...RETRYABLE_ERRORS,
            ...(options.retryableErrors ?? []),
        ]);
        this.#retryableStatusCodes = new Set([
            ...RETRYABLE_STATUS_CODES,
            ...(options.retryableStatusCodes ?? []),
        ]);
    }
    #getHeader(headers: Headers, name: string) {
        if (headers == null) return null;
        return headers.get(name) ?? null;
    }
    #getRetryAfter(error: ResilienceError) {
        const headers =
            error.cause instanceof Response ? error.cause.headers : null;
        if (headers == null) {
            return null;
        }
        const retryAfter = this.#getHeader(headers, "retry-after");
        if (retryAfter == null) return null;
        const seconds = Number(retryAfter);
        if (Number.isInteger(seconds) && seconds >= 0) {
            return seconds * 1000;
        }

        const date = new Date(retryAfter);
        if (!Number.isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
        return null;
    }
    #calculateDelayWithJitter(
        baseDelay: number,
        prevDelay: number,
        attempt: number,
    ) {
        const delay = Math.min(
            baseDelay * Math.pow(this.#factor, attempt - 1),
            this.#maxDelay,
        );
        switch (this.#jitter) {
            case JitterStatuses.NONE:
                return delay;
            case JitterStatuses.FULL:
                return Math.random() * delay;
            case JitterStatuses.EQUAL:
                return delay / 2 + (Math.random() * delay) / 2;
            case JitterStatuses.DECORRELATE:
                const upperBound = Math.max(baseDelay, prevDelay * 3);
                return Math.min(
                    this.#maxDelay,
                    baseDelay + Math.random() * (upperBound - baseDelay),
                );
            default:
                return delay;
        }
    }
    #calculateDelay(
        initialDelay: number,
        prevDelay: number,
        attempt: number,
        error: ResilienceError,
    ) {
        const retryAfter = this.#getRetryAfter(error);
        if (retryAfter != null) {
            if (retryAfter > this.#maxDelay) {
                return null;
            }
            return retryAfter;
        }
        return this.#calculateDelayWithJitter(initialDelay, prevDelay, attempt);
    }
    #isRetryable(error: ResilienceErrorInterface) {
        return error.isRetryable;
    }
    async execute<T>(
        fn: (options: { signal: AbortSignal }) => Promise<T>,
        options: { cancelSignal: AbortSignal },
    ) {
        let lastError;
        let prevDelay = this.#initialDelay;
        for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
            if (options.cancelSignal.aborted) {
                throw new GlobalTimeoutError();
            }
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(new CustomTimeoutError()),
                this.#timeout,
            );
            try {
                this.#metrics.totalAttempts++;
                const t0 = performance.now();
                try {
                    return await fn({
                        signal: AbortSignal.any([
                            controller.signal,
                            options.cancelSignal,
                        ]),
                    });
                } finally {
                    clearTimeout(timer);
                    this.#metrics.totalAttemptsDurationMs +=
                        performance.now() - t0;
                }
            } catch (err) {
                const error = ResilienceError.ensureError(err);
                const resilientError = ResilienceError.from(
                    error,
                    ResilienceError.classifyError(error, {
                        retryableErrors: this.#retryableErrors,
                        retryableStatusCodes: this.#retryableStatusCodes,
                    }),
                );
                lastError = resilientError;
                if (
                    attempt === this.#maxAttempts ||
                    !this.#isRetryable(resilientError)
                ) {
                    throw resilientError;
                }
                const delay = this.#calculateDelay(
                    this.#initialDelay,
                    prevDelay,
                    attempt,
                    resilientError,
                );
                if (delay == null) {
                    throw resilientError;
                }
                prevDelay = delay;
                await setTimeoutPromise(delay, null, {
                    signal: options.cancelSignal,
                });
            }
        }
        throw lastError;
    }
    getMetrics() {
        return {
            attempts: this.#metrics.totalAttempts,
            attemptsDurationMS: this.#metrics.totalAttemptsDurationMs,
        };
    }
}
