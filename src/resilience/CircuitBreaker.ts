/**
 * @see https://oneuptime.com/blog/post/2026-01-06-nodejs-retry-exponential-backoff/view#circuit-breaker-pattern
 */

import { CircuitBreakerHalfOpenError } from "./errors/CircuitBreakerHalfOpenError";
import { CircuitBreakerOpenError } from "./errors/CircuitBreakerOpenError";
import { InvalidCircuitBreakerOptionError } from "./errors/InvalidCircuitBreakerOptionError";
import { ResilienceError } from "./errors/ResilienceError";
import { logger } from "./logger";
import type { CircuitBreakerOptions, ResilienceErrorInterface } from "./types";

enum CircuitBreakerStates {
    CLOSED = "closed",
    OPEN = "open",
    HALF_OPEN = "half-open",
}
const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
    failureThreshold: 1,
    resetTimeout: 30_000,
    halfOpenRequests: 1,
};

export class CircuitBreaker {
    #failureThreshold: number;
    #resetTimeout: number;
    #halfOpenRequests: number;
    #state = CircuitBreakerStates.CLOSED;
    #failures: number = 0;
    #successes: number = 0;
    #lastFailure: number | null = null;
    #halfOpenAttemps = 0;
    #stateInterval: NodeJS.Timeout | null = null;
    constructor(options: Partial<CircuitBreakerOptions>) {
        const resolvedOptions = {
            ...DEFAULT_CIRCUIT_BREAKER_OPTIONS,
            ...options,
        };
        if (
            resolvedOptions.failureThreshold < 1 ||
            resolvedOptions.halfOpenRequests < 1 ||
            resolvedOptions.resetTimeout <= 0
        ) {
            throw new InvalidCircuitBreakerOptionError();
        }
        this.#failureThreshold = resolvedOptions.failureThreshold;
        this.#resetTimeout = resolvedOptions.resetTimeout;
        this.#halfOpenRequests = resolvedOptions.halfOpenRequests;
    }
    async connect() {
        if (this.#stateInterval == null) {
            this.#stateInterval = setInterval(() => {
                logger.debug("[CircuitBreaker]:: Metrics", this.getState());
            }, 10_000);
        }
    }
    async close() {
        if (this.#stateInterval != null) {
            clearInterval(this.#stateInterval);
            this.#stateInterval = null;
        }
    }

    async execute<T>(fn: () => Promise<T>) {
        if (this.#state === CircuitBreakerStates.OPEN) {
            if (
                this.#lastFailure !== null &&
                Date.now() - this.#lastFailure > this.#resetTimeout
            ) {
                this.#state = CircuitBreakerStates.HALF_OPEN;
                logger.debug("[CircuitBreaker]: OPEN -> HALF_OPEN");
                this.#halfOpenAttemps = 0;
            } else {
                throw new CircuitBreakerOpenError();
            }
        }
        if (
            this.#state === CircuitBreakerStates.HALF_OPEN &&
            this.#halfOpenAttemps >= this.#halfOpenRequests
        ) {
            throw new CircuitBreakerHalfOpenError();
        }
        try {
            if (this.#state === CircuitBreakerStates.HALF_OPEN) {
                this.#halfOpenAttemps++;
            }
            const result = await fn();
            this.#onSuccess();
            return result;
        } catch (err) {
            const error = ResilienceError.ensureError(err);
            logger.error("[CircuitBreaker]", { error });
            const normalizedError = ResilienceError.from(
                error,
                ResilienceError.classifyError(error),
            );
            if (CircuitBreaker.#isFailure(normalizedError)) {
                this.#onFailure();
            }
            throw normalizedError;
        }
    }

    #onSuccess() {
        if (this.#state === CircuitBreakerStates.HALF_OPEN) {
            this.#successes++;
            if (this.#successes >= this.#halfOpenRequests) {
                this.#state = CircuitBreakerStates.CLOSED;
                logger.debug("[CircuitBreaker]: HALF_OPEN -> CLOSED");
                this.#failures = 0;
                this.#successes = 0;
            }
        } else {
            this.#failures = 0;
        }
    }
    static #isFailure(error: ResilienceErrorInterface) {
        return error.isCircuitBreakerFailure;
    }

    #onFailure() {
        this.#failures++;
        this.#lastFailure = Date.now();
        if (this.#state === CircuitBreakerStates.HALF_OPEN) {
            this.#state = CircuitBreakerStates.OPEN;
            logger.debug("[CircuitBreaker]: HALF OPEN -> OPEN");
            this.#successes = 0;
        } else if (this.#failures >= this.#failureThreshold) {
            this.#state = CircuitBreakerStates.OPEN;
            logger.debug("[CircuitBreaker]: CLOSED -> OPEN");
        }
    }

    getState() {
        return {
            state: this.#state,
            failures: this.#failures,
            lastFailure: this.#lastFailure,
        };
    }
}
