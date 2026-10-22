/**
 * @see https://oneuptime.com/blog/post/2026-01-24-bulkhead-pattern-nodejs/view
 */

import { BulkheadAcquisitionAbortedError } from "./errors/BulkheadAcquisitionAbortedError";
import { BulkheadRejectedError } from "./errors/BulkheadRejectedError";
import { BulkheadTimeoutError } from "./errors/BulkheadTimeoutError";
import { InvalidBulkheadOptionError } from "./errors/InvalidBulkheadOptionError";
import { ResilienceError } from "./errors/ResilienceError";
import { logger } from "./logger";
import type { BulkheadOptions } from "./types";

interface BulkheadMetrics {
    acquired: number;
    rejected: number;
    timedOut: number;
    completed: number;
    failed: number;
}

type Waiter = {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    cancelSignal: AbortSignal;
    onAbort: () => void;
};
const DEFAULT_BULKHEAD_OPTIONS: BulkheadOptions = {
    name: "defaultBulkhead",
    maxConcurrent: 10,
    maxWaiting: 20,
    timeoutMS: 10_000,
};
export class Bulkhead {
    #name: string;
    #maxConcurrent: number = 10;
    #permits: number = 1;
    #maxWaiting: number = 20;
    #waitTimeoutMS: number = 10_000;
    #waitQueue: Waiter[] = [];
    #metrics: BulkheadMetrics = {
        acquired: 0,
        rejected: 0,
        timedOut: 0,
        completed: 0,
        failed: 0,
    };
    #metricsInterval: NodeJS.Timeout | null = null;
    constructor(config: Partial<BulkheadOptions>) {
        const resolvedOptions = { ...DEFAULT_BULKHEAD_OPTIONS, config };
        this.#name = resolvedOptions.name;
        if (
            !Number.isInteger(resolvedOptions.maxConcurrent) ||
            resolvedOptions.maxConcurrent <= 0 ||
            !Number.isInteger(resolvedOptions.maxWaiting) ||
            resolvedOptions.maxWaiting < 0 ||
            !Number.isFinite(resolvedOptions.timeoutMS) ||
            resolvedOptions.timeoutMS <= 0
        ) {
            throw new InvalidBulkheadOptionError();
        }
        this.#maxConcurrent = resolvedOptions.maxConcurrent;
        this.#permits = resolvedOptions.maxConcurrent;
        this.#maxWaiting = resolvedOptions.maxWaiting;
        this.#waitTimeoutMS = resolvedOptions.timeoutMS;
    }

    async #acquire({ signal }: { signal: AbortSignal }) {
        if (signal.aborted) {
            if (signal.reason instanceof ResilienceError) {
                throw signal.reason;
            }
            throw new BulkheadAcquisitionAbortedError(signal.reason);
        }
        if (this.#permits > 0) {
            this.#permits--;
            this.#metrics.acquired++;
            return;
        }
        if (this.#waitQueue.length >= this.#maxWaiting) {
            this.#metrics.rejected++;
            throw new BulkheadRejectedError(
                this.#name,
                this.#maxConcurrent,
                this.#waitQueue.length,
            );
        }
        return new Promise<void>((resolve, reject) => {
            let waiter: Waiter;
            const onAbort = () => {
                if (!this.#removeWaiter(waiter)) return;
                this.#cleanupWaiter(waiter);
                const reason = signal.reason;
                const abortError = ResilienceError.from(
                    new Error("Bulkhead acquisition aborted", {
                        cause: reason,
                    }),
                    ResilienceError.classifyError(reason),
                );
                reject(abortError);
            };
            const timer = setTimeout(() => {
                if (!this.#removeWaiter(waiter)) return;
                this.#cleanupWaiter(waiter);
                this.#metrics.timedOut++;
                reject(
                    new BulkheadTimeoutError(this.#name, this.#waitTimeoutMS),
                );
            }, this.#waitTimeoutMS);
            waiter = { resolve, reject, timer, cancelSignal: signal, onAbort };
            this.#waitQueue.push(waiter);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
                onAbort();
            }
        });
    }
    #removeWaiter(waiter: Waiter) {
        const index = this.#waitQueue.indexOf(waiter);
        if (index === -1) return false;
        this.#waitQueue.splice(index, 1);
        return true;
    }
    #cleanupWaiter(waiter: Waiter) {
        clearTimeout(waiter.timer);
        waiter.cancelSignal.removeEventListener("abort", waiter.onAbort);
    }
    #release(success: boolean = true) {
        if (success) {
            this.#metrics.completed++;
        } else {
            this.#metrics.failed++;
        }
        if (this.#waitQueue.length > 0) {
            const next = this.#waitQueue.shift()!;
            this.#cleanupWaiter(next);
            this.#metrics.acquired++;
            next.resolve();
        } else {
            this.#permits++;
        }
    }
    async connect() {
        if (this.#metricsInterval == null) {
            this.#metricsInterval = setInterval(() => {
                logger.debug("[BulkHead]:: Metrics", this.getMetrics());
            }, 10_000);
        }
    }
    async close() {
        if (this.#metricsInterval != null) {
            clearInterval(this.#metricsInterval);
            this.#metricsInterval = null;
        }
    }
    async execute<T>(
        fn: (options: { signal: AbortSignal }) => Promise<T>,
        options: { signal: AbortSignal },
    ) {
        if (options.signal.aborted) {
            throw ResilienceError.from(
                new Error("", { cause: options.signal.reason }),
                ResilienceError.classifyError(options.signal.reason),
            );
        }
        await this.#acquire({ signal: options.signal });
        let success = true;
        try {
            if (options.signal.aborted) {
                throw ResilienceError.from(
                    new Error("", { cause: options.signal.reason }),
                    ResilienceError.classifyError(options.signal.reason),
                );
            }
            return await fn({ signal: options.signal });
        } catch (error) {
            success = false;
            throw error;
        } finally {
            this.#release(success);
        }
    }
    getMetrics() {
        return {
            name: this.#name,
            availablePermits: this.#permits,
            waitingCount: this.#waitQueue.length,
            ...this.#metrics,
        };
    }
}

export class BulkheadRegistry {
    #bulheads: Map<string, Bulkhead> = new Map();
    async register(config: BulkheadOptions) {
        if (this.#bulheads.has(config.name)) {
            throw new Error("ERR_BULKHEAD_ALREADY_REGISTERED");
        }
        const bulkhead = new Bulkhead(config);
        await bulkhead.connect();
        this.#bulheads.set(config.name, bulkhead);
        return bulkhead;
    }
    get(name: string) {
        if (!this.#bulheads.has(name)) {
            throw new Error("ERR_BULKHEAD_NOT_REGISTERED");
        }
        return this.#bulheads.get(name);
    }
    getAllMetrics() {
        const metrics: Record<string, object> = {};
        for (const [name, bulkhead] of this.#bulheads) {
            metrics[name] = bulkhead.getMetrics();
        }
        return metrics;
    }
    async reset() {
        for (const [, bulkhead] of this.#bulheads) {
            await bulkhead.close();
        }
        this.#bulheads.clear();
    }
}
