import { afterEach, describe, expect, it, vi } from "vitest";
import { Bulkhead } from "../Bulkhead";
import { CircuitBreaker } from "../CircuitBreaker";
import { BulkheadRejectedError } from "../errors/BulkheadRejectedError";
import { BulkheadTimeoutError } from "../errors/BulkheadTimeoutError";
import { ResilienceError } from "../errors/ResilienceError";

function createBulkhead() {
    return new Bulkhead({});
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe("Bulkhead", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("never runs more operations concurrently than maxConcurrent", async () => {
        const bulkhead = createBulkhead();
        let releaseOperations!: () => void;
        const operationGate = new Promise<void>(resolve => {
            releaseOperations = resolve;
        });
        let activeOperations = 0;
        let peakActiveOperations = 0;
        const executions = Array.from({ length: 12 }, () =>
            bulkhead.execute(
                async () => {
                    activeOperations++;
                    peakActiveOperations = Math.max(
                        peakActiveOperations,
                        activeOperations,
                    );
                    await operationGate;
                    activeOperations--;
                },
                { signal: new AbortController().signal },
            ),
        );

        await Promise.resolve();
        expect(bulkhead.getMetrics().waitingCount).toBe(2);
        expect(peakActiveOperations).toBe(10);

        releaseOperations();
        await Promise.all(executions);

        expect(peakActiveOperations).toBeLessThanOrEqual(10);
        expect(activeOperations).toBe(0);
        expect(bulkhead.getMetrics().availablePermits).toBe(10);
    });

    it("rejects work when maxWaiting is reached", async () => {
        const bulkhead = createBulkhead();
        let releaseRunningOperation!: () => void;
        const runningOperation = new Promise<void>(resolve => {
            releaseRunningOperation = resolve;
        });
        const running = Array.from({ length: 10 }, () =>
            bulkhead.execute(() => runningOperation, {
                signal: new AbortController().signal,
            }),
        );
        const waiting = Array.from({ length: 20 }, () =>
            bulkhead.execute(async () => undefined, {
                signal: new AbortController().signal,
            }),
        );

        const rejectedOperation = vi.fn(async () => "should not run");
        await expect(
            bulkhead.execute(rejectedOperation, {
                signal: new AbortController().signal,
            }),
        ).rejects.toBeInstanceOf(BulkheadRejectedError);
        expect(bulkhead.getMetrics().waitingCount).toBe(20);
        expect(bulkhead.getMetrics().rejected).toBe(1);
        expect(bulkhead.getMetrics().availablePermits).toBe(0);
        expect(rejectedOperation).not.toHaveBeenCalled();

        releaseRunningOperation();
        await Promise.all([...running, ...waiting]);
        expect(bulkhead.getMetrics().waitingCount).toBe(0);
    });

    it("releases a permit after both successful and failed operations", async () => {
        const bulkhead = createBulkhead();
        const cancelSignal = new AbortController().signal;

        await expect(
            bulkhead.execute(async () => "ok", { signal: cancelSignal }),
        ).resolves.toBe("ok");
        expect(bulkhead.getMetrics().availablePermits).toBe(10);

        const failure = new Error("operation failed");
        await expect(
            bulkhead.execute(
                async () => {
                    throw failure;
                },
                { signal: cancelSignal },
            ),
        ).rejects.toBe(failure);
        expect(bulkhead.getMetrics().availablePermits).toBe(10);
        expect(bulkhead.getMetrics()).toMatchObject({
            completed: 1,
            failed: 1,
        });
    });

    it("classifies an already-aborted signal with an ordinary Error reason", async () => {
        const bulkhead = createBulkhead();
        const controller = new AbortController();
        const reason = new Error("caller cancelled");
        controller.abort(reason);
        const operation = vi.fn(async () => "must not run");

        const rejection = await bulkhead
            .execute(operation, { signal: controller.signal })
            .catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(ResilienceError);
        expect(rejection).not.toBeInstanceOf(TypeError);
        expect(rejection).toMatchObject({
            isRetryable: false,
            isCircuitBreakerFailure: false,
        });
        expect(rejection).toHaveProperty("cause.cause", reason);
        expect(operation).not.toHaveBeenCalled();
        expect(bulkhead.getMetrics()).toMatchObject({
            availablePermits: 10,
            acquired: 0,
            completed: 0,
            failed: 0,
        });
    });

    it("never runs an operation whose queue wait timed out", async () => {
        vi.useFakeTimers();
        const bulkhead = createBulkhead();
        let releaseRunningOperation!: () => void;
        const runningOperation = new Promise<void>(resolve => {
            releaseRunningOperation = resolve;
        });
        const running = Array.from({ length: 10 }, () =>
            bulkhead.execute(() => runningOperation, {
                signal: new AbortController().signal,
            }),
        );
        const queuedOperation = vi.fn(async () => "should not run");
        const waiting = bulkhead.execute(queuedOperation, {
            signal: new AbortController().signal,
        });

        const rejection =
            expect(waiting).rejects.toBeInstanceOf(BulkheadTimeoutError);
        await vi.advanceTimersByTimeAsync(10_000);
        await rejection;
        expect(bulkhead.getMetrics().waitingCount).toBe(0);

        const replacementOperation = vi.fn(async () => "replacement");
        const replacement = bulkhead.execute(replacementOperation, {
            signal: new AbortController().signal,
        });
        expect(bulkhead.getMetrics().waitingCount).toBe(1);
        releaseRunningOperation();
        await Promise.all([...running, replacement]);

        expect(queuedOperation).not.toHaveBeenCalled();
        expect(replacementOperation).toHaveBeenCalledOnce();
        expect(bulkhead.getMetrics().waitingCount).toBe(0);
        expect(bulkhead.getMetrics().timedOut).toBe(1);
    });

    it("removes an aborted waiter and lets another operation use its queue slot", async () => {
        const bulkhead = createBulkhead();
        const runningWork = deferred<void>();
        const running = Array.from({ length: 10 }, () =>
            bulkhead.execute(() => runningWork.promise, {
                signal: new AbortController().signal,
            }),
        );
        const controller = new AbortController();
        const abortedOperation = vi.fn(async () => "should not run");
        const waiting = bulkhead.execute(abortedOperation, {
            signal: controller.signal,
        });

        expect(bulkhead.getMetrics().waitingCount).toBe(1);
        controller.abort(new Error("caller cancelled"));
        await expect(waiting).rejects.toBeInstanceOf(Error);

        expect(bulkhead.getMetrics().waitingCount).toBe(0);
        expect(bulkhead.getMetrics().availablePermits).toBe(0);
        expect(abortedOperation).not.toHaveBeenCalled();

        const replacementOperation = vi.fn(async () => "replacement");
        const replacement = bulkhead.execute(replacementOperation, {
            signal: new AbortController().signal,
        });
        expect(bulkhead.getMetrics().waitingCount).toBe(1);

        runningWork.resolve();
        await Promise.all([...running, replacement]);

        expect(replacementOperation).toHaveBeenCalledOnce();
        expect(bulkhead.getMetrics()).toMatchObject({
            availablePermits: 10,
            waitingCount: 0,
        });
    });

    it("does not count bulkhead rejection as a circuit breaker failure", async () => {
        const bulkhead = createBulkhead();
        const circuitBreaker = new CircuitBreaker({
            failureThreshold: 1,
            resetTimeout: 100,
            halfOpenRequests: 1,
        });
        let releaseRunningOperation!: () => void;
        const runningOperation = new Promise<void>(resolve => {
            releaseRunningOperation = resolve;
        });
        const execute = () =>
            circuitBreaker.execute(() =>
                bulkhead.execute(() => runningOperation, {
                    signal: new AbortController().signal,
                }),
            );
        const executions = Array.from({ length: 30 }, execute);

        await expect(execute()).rejects.toBeInstanceOf(BulkheadRejectedError);
        expect(circuitBreaker.getState()).toMatchObject({
            state: "closed",
            failures: 0,
        });

        releaseRunningOperation();
        await Promise.all(executions);
    });

    it("keeps the permit while an aborted operation is still running", async () => {
        const bulkhead = createBulkhead();
        const controller = new AbortController();
        let finishBackgroundWork!: () => void;
        const backgroundWork = new Promise<void>(resolve => {
            finishBackgroundWork = resolve;
        });
        let markOperationStarted!: () => void;
        const operationStarted = new Promise<void>(resolve => {
            markOperationStarted = resolve;
        });
        const operation = bulkhead.execute(
            async ({ signal }) => {
                markOperationStarted();
                await backgroundWork;
                return signal.aborted;
            },
            { signal: controller.signal },
        );

        await operationStarted;
        controller.abort(new Error("operation timed out"));
        await Promise.resolve();

        expect(bulkhead.getMetrics().availablePermits).toBe(9);

        finishBackgroundWork();
        await expect(operation).resolves.toBe(true);
        expect(bulkhead.getMetrics().availablePermits).toBe(10);
    });
});
