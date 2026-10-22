import { Bulkhead } from "./Bulkhead";
import { CircuitBreaker } from "./CircuitBreaker";
import { logger } from "./logger";
import { Retry } from "./Retry";
import type { ResilienceClientConfig } from "./types";

export abstract class ResilientClient {
    readonly retry: Retry;
    readonly bulkhead: Bulkhead;
    readonly circuitBreaker: CircuitBreaker;
    #metricsInterval: NodeJS.Timeout | null = null;
    constructor(options: ResilienceClientConfig) {
        this.retry = new Retry(options.retryOptions);
        this.bulkhead = new Bulkhead(options.bulkheadOptions);
        this.circuitBreaker = new CircuitBreaker(options.circuitBreakerOptions);
    }

    async connect() {
        if (this.#metricsInterval == null) {
            this.#metricsInterval = setInterval(() => {
                const metrics = {
                    bulkhead: this.bulkhead.getMetrics(),
                    retry: this.retry.getMetrics(),
                    circuitBreaker: this.circuitBreaker.getState(),
                };
                logger.debug("[Client]:: Metrics", metrics);
            }, 10_000);
        }
    }
    async close() {
        if (this.#metricsInterval != null) {
            clearInterval(this.#metricsInterval);
            this.#metricsInterval = null;
        }
    }
    abstract execute<T>(
        fn: (options: { signal: AbortSignal }) => Promise<T>,
        options: { cancelSignal: AbortSignal },
    ): Promise<T>;
}

export class LogicalOperationResilientClient extends ResilientClient {
    execute<T>(
        fn: (options: { signal: AbortSignal }) => Promise<T>,
        options: { cancelSignal: AbortSignal },
    ) {
        return this.circuitBreaker.execute(() =>
            this.retry.execute(
                ({ signal }) => {
                    return this.bulkhead.execute(fn, {
                        signal: signal,
                    });
                },
                { cancelSignal: options.cancelSignal },
            ),
        );
    }
}
export class PerAttemptResilientClient extends ResilientClient {
    execute<T>(
        fn: (options: { signal: AbortSignal }) => Promise<T>,
        options: { cancelSignal: AbortSignal },
    ) {
        return this.retry.execute(
            ({ signal }) => {
                return this.circuitBreaker.execute(() =>
                    this.bulkhead.execute(fn, {
                        signal: signal,
                    }),
                );
            },
            { cancelSignal: options.cancelSignal },
        );
    }
}
