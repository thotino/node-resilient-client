import { describe, expect, it, vi } from "vitest";
import { LogicalOperationResilientClient } from "../ResilientClient";
import { RequestCoalescer } from "../RequestCoalescer";
import { JitterStatuses } from "../constants";
import { ResilienceError } from "../errors/ResilienceError";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function createClient() {
    return new LogicalOperationResilientClient({
        retryOptions: {
            maxAttempts: 1,
            initialDelay: 1,
            maxDelay: 1,
            factor: 2,
            jitter: JitterStatuses.NONE,
            timeout: 10_000,
            retryableErrors: [],
            retryableStatusCodes: [],
        },
        circuitBreakerOptions: {
            failureThreshold: 3,
            resetTimeout: 1_000,
            halfOpenRequests: 1,
        },
        bulkheadOptions: {
            name: "request-coalescer-test",
            maxConcurrent: 2,
            maxWaiting: 2,
            timeoutMS: 1_000,
        },
    });
}

describe("RequestCoalescer", () => {
    it("runs one operation for concurrent requests with the same key and shares its result", async () => {
        const coalescer = new RequestCoalescer();
        const gate = deferred<{ rate: number }>();
        const operation = vi.fn(() => gate.promise);

        const first = coalescer.get("same-key", operation);
        const second = coalescer.get("same-key", operation);

        expect(operation).toHaveBeenCalledTimes(1);

        const result = { rate: 1.25 };
        gate.resolve(result);
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toBe(result);
        expect(secondResult).toBe(result);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it("keeps cancellation signals independent for separate client operations", async () => {
        const client = createClient();
        const firstGate = deferred<{ rate: number }>();
        const laterGate = deferred<{ rate: number }>();
        const firstController = new AbortController();
        const laterController = new AbortController();
        const firstOperationStarted = deferred<void>();
        const laterOperationStarted = deferred<void>();
        let firstOperationSignal!: AbortSignal;
        let laterOperationSignal!: AbortSignal;
        const firstOperation = vi.fn(({ signal }: { signal: AbortSignal }) => {
            firstOperationSignal = signal;
            firstOperationStarted.resolve(undefined);
            return firstGate.promise;
        });
        const laterOperation = vi.fn(({ signal }: { signal: AbortSignal }) => {
            laterOperationSignal = signal;
            laterOperationStarted.resolve(undefined);
            return laterGate.promise;
        });

        const first = client.execute(firstOperation, {
            cancelSignal: firstController.signal,
        });
        const later = client.execute(laterOperation, {
            cancelSignal: laterController.signal,
        });
        await Promise.all([
            firstOperationStarted.promise,
            laterOperationStarted.promise,
        ]);
        laterController.abort();

        expect(firstOperation).toHaveBeenCalledTimes(1);
        expect(laterOperation).toHaveBeenCalledTimes(1);
        expect(firstOperationSignal.aborted).toBe(false);
        expect(laterOperationSignal.aborted).toBe(true);

        const firstValue = { rate: 1.25 };
        const laterValue = { rate: 2.5 };
        firstGate.resolve(firstValue);
        laterGate.resolve(laterValue);
        const [firstResult, laterResult] = await Promise.all([first, later]);

        expect(firstResult).toBe(firstValue);
        expect(laterResult).toBe(laterValue);
    });

    it("propagates cancellation and permits a later operation", async () => {
        const client = createClient();
        const initiatingController = new AbortController();
        const operationStarted = deferred<void>();
        const abortedOperation = vi.fn(
            ({ signal }: { signal: AbortSignal }) =>
                new Promise<never>((_resolve, reject) => {
                    operationStarted.resolve(undefined);
                    const rejectForAbort = () =>
                        reject(
                            new Error("underlying operation aborted", {
                                cause: { code: "ABORTED" },
                            }),
                        );
                    signal.addEventListener("abort", rejectForAbort, {
                        once: true,
                    });
                    if (signal.aborted) rejectForAbort();
                }),
        );

        const initiatingRequest = client.execute(abortedOperation, {
            cancelSignal: initiatingController.signal,
        });

        await operationStarted.promise;
        initiatingController.abort();
        const initiatingError = await initiatingRequest.catch(
            (error: unknown) => error,
        );

        expect(initiatingError).toBeInstanceOf(ResilienceError);
        expect(abortedOperation).toHaveBeenCalledTimes(1);

        const nextOperation = vi.fn(async () => "next result");
        await expect(
            client.execute(nextOperation, {
                cancelSignal: new AbortController().signal,
            }),
        ).resolves.toBe("next result");
        expect(nextOperation).toHaveBeenCalledTimes(1);
    });
});
