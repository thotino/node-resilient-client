import type { ErrorClassification, ResilienceErrorInterface } from "../types";
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

export class ResilienceError extends Error implements ResilienceErrorInterface {
    isCircuitBreakerFailure: boolean;
    isRetryable: boolean;
    code: string;
    message: string;
    constructor(
        message: string,
        code: string,
        isRetryable: boolean,
        isCircuitBreakerFailure: boolean,
        cause: unknown,
    ) {
        super(message, { cause });
        this.message = message;
        this.code = code;
        this.isRetryable = isRetryable;
        this.isCircuitBreakerFailure = isCircuitBreakerFailure;
    }

    static from(error: Error, options: ErrorClassification) {
        if (error instanceof ResilienceError) return error;
        const code =
            error.cause instanceof Response
                ? error.cause.statusText
                : "ERR_UNEXPECTED_ERROR";
        return new ResilienceError(
            error.message,
            code,
            options.isRetryable,
            options.isCircuitBreakerFailure,
            error,
        );
    }
    static ensureError(value: unknown) {
        if (value instanceof Error) return value;
        let stringifiedValue = "";
        try {
            stringifiedValue = JSON.stringify(value);
        } catch (_) {}
        const error = new Error(stringifiedValue);
        return error;
    }
    static classifyError(
        value: unknown,
        options?: {
            retryableErrors?: Set<string>;
            retryableStatusCodes?: Set<number>;
        },
    ) {
        if (value instanceof ResilienceError) {
            return {
                isRetryable: value.isRetryable,
                isCircuitBreakerFailure: value.isCircuitBreakerFailure,
            };
        }
        const cause = value instanceof Error ? value.cause : null;
        const causeStatus = cause instanceof Response ? cause.status : null;
        const causeCode =
            typeof cause == "object" &&
            cause != null &&
            Object.hasOwn(cause, "code") &&
            "code" in cause &&
            typeof cause.code === "string"
                ? cause.code
                : null;
        const resolvedRetryableErrors = new Set([
            ...RETRYABLE_ERRORS,
            ...(options?.retryableErrors ?? []),
        ]);
        const resolvedRetryableStatusCodes = new Set([
            ...RETRYABLE_STATUS_CODES,
            ...(options?.retryableStatusCodes ?? []),
        ]);
        if (
            (causeStatus != null &&
                resolvedRetryableStatusCodes.has(causeStatus)) ||
            (causeCode != null && resolvedRetryableErrors.has(causeCode))
        ) {
            return {
                isRetryable: true,
                isCircuitBreakerFailure: true,
            };
        }
        return { isRetryable: false, isCircuitBreakerFailure: false };
    }
}
