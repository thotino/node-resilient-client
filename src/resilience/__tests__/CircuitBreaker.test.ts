import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../CircuitBreaker";
import { CircuitBreakerHalfOpenError } from "../errors/CircuitBreakerHalfOpenError";
import { CircuitBreakerOpenError } from "../errors/CircuitBreakerOpenError";
import { ResilienceError } from "../errors/ResilienceError";
import type { CircuitBreakerOptions } from "../types";

const defaultOptions: CircuitBreakerOptions = {
    failureThreshold: 1,
    resetTimeout: 1_000,
    halfOpenRequests: 1,
};

function createCircuitBreaker(options: Partial<CircuitBreakerOptions> = {}) {
    return new CircuitBreaker({ ...defaultOptions, ...options });
}

function serviceFailure(message: string) {
    return new Error(message, { cause: new Response(null, { status: 503 }) });
}

describe("CircuitBreaker", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("opens after a closed-state failure and closes after a successful half-open probe", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const circuitBreaker = createCircuitBreaker();
        const failure = serviceFailure("service unavailable");

        await expect(
            circuitBreaker.execute(async () => {
                throw failure;
            }),
        ).rejects.toMatchObject({
            message: failure.message,
            isRetryable: true,
            isCircuitBreakerFailure: true,
            cause: failure,
        });
        expect(circuitBreaker.getState()).toEqual({
            state: "open",
            failures: 1,
            lastFailure: 1_000,
        });

        const whileOpen = vi.fn(async () => "must not run");
        await expect(circuitBreaker.execute(whileOpen)).rejects.toBeInstanceOf(
            CircuitBreakerOpenError,
        );
        expect(whileOpen).not.toHaveBeenCalled();

        vi.setSystemTime(2_000);
        const atResetTimeout = vi.fn(async () => "must not run");
        await expect(
            circuitBreaker.execute(atResetTimeout),
        ).rejects.toBeInstanceOf(CircuitBreakerOpenError);
        expect(atResetTimeout).not.toHaveBeenCalled();
        expect(circuitBreaker.getState()).toEqual({
            state: "open",
            failures: 1,
            lastFailure: 1_000,
        });

        vi.setSystemTime(2_001);
        const probe = vi.fn(async () => "recovered");
        await expect(circuitBreaker.execute(probe)).resolves.toBe("recovered");
        expect(probe).toHaveBeenCalledTimes(1);
        expect(circuitBreaker.getState()).toEqual({
            state: "closed",
            failures: 0,
            lastFailure: 1_000,
        });
    });

    it("opens only after reaching the configured failure threshold", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const circuitBreaker = createCircuitBreaker({
            failureThreshold: 2,
        });
        const firstFailure = serviceFailure("first failure");

        await expect(
            circuitBreaker.execute(async () => {
                throw firstFailure;
            }),
        ).rejects.toMatchObject({
            message: firstFailure.message,
            isRetryable: true,
            isCircuitBreakerFailure: true,
            cause: firstFailure,
        });
        expect(circuitBreaker.getState()).toEqual({
            state: "closed",
            failures: 1,
            lastFailure: 10_000,
        });

        vi.setSystemTime(10_001);
        const secondFailure = serviceFailure("second failure");
        await expect(
            circuitBreaker.execute(async () => {
                throw secondFailure;
            }),
        ).rejects.toMatchObject({
            message: secondFailure.message,
            isRetryable: true,
            isCircuitBreakerFailure: true,
            cause: secondFailure,
        });
        expect(circuitBreaker.getState()).toEqual({
            state: "open",
            failures: 2,
            lastFailure: 10_001,
        });
    });

    it("classifies an ordinary error without a cause without opening the circuit", async () => {
        const circuitBreaker = createCircuitBreaker();
        const failure = new Error("invalid request");

        const rejection = await circuitBreaker
            .execute(async () => {
                throw failure;
            })
            .catch((error: unknown) => error);

        expect(rejection).toBeInstanceOf(ResilienceError);
        expect(rejection).not.toBeInstanceOf(TypeError);
        expect(rejection).toMatchObject({
            message: "invalid request",
            isRetryable: false,
            isCircuitBreakerFailure: false,
        });
        expect(rejection).toHaveProperty("cause", failure);
        expect(circuitBreaker.getState()).toEqual({
            state: "closed",
            failures: 0,
            lastFailure: null,
        });
    });

    it("allows the configured number of concurrent half-open probes and closes after they succeed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(20_000);
        const circuitBreaker = createCircuitBreaker({
            halfOpenRequests: 2,
        });
        const initialFailure = serviceFailure("initial failure");
        await expect(
            circuitBreaker.execute(async () => {
                throw initialFailure;
            }),
        ).rejects.toMatchObject({
            message: initialFailure.message,
            isRetryable: true,
            isCircuitBreakerFailure: true,
            cause: initialFailure,
        });

        vi.setSystemTime(21_001);
        let resolveFirstProbe!: (value: string) => void;
        const firstProbeResult = new Promise<string>(resolve => {
            resolveFirstProbe = resolve;
        });
        let resolveSecondProbe!: (value: string) => void;
        const secondProbeResult = new Promise<string>(resolve => {
            resolveSecondProbe = resolve;
        });
        const firstProbe = vi.fn(() => firstProbeResult);
        const secondProbe = vi.fn(() => secondProbeResult);

        const firstExecution = circuitBreaker.execute(firstProbe);
        const secondExecution = circuitBreaker.execute(secondProbe);
        expect(firstProbe).toHaveBeenCalledTimes(1);
        expect(secondProbe).toHaveBeenCalledTimes(1);
        expect(circuitBreaker.getState()).toEqual({
            state: "half-open",
            failures: 1,
            lastFailure: 20_000,
        });

        const extraProbe = vi.fn(async () => "must not run");
        await expect(circuitBreaker.execute(extraProbe)).rejects.toBeInstanceOf(
            CircuitBreakerHalfOpenError,
        );
        expect(extraProbe).not.toHaveBeenCalled();

        resolveFirstProbe("first probe recovered");
        await expect(firstExecution).resolves.toBe("first probe recovered");
        expect(circuitBreaker.getState()).toEqual({
            state: "half-open",
            failures: 1,
            lastFailure: 20_000,
        });

        resolveSecondProbe("second probe recovered");
        await expect(secondExecution).resolves.toBe("second probe recovered");
        expect(circuitBreaker.getState()).toEqual({
            state: "closed",
            failures: 0,
            lastFailure: 20_000,
        });
    });

    it("rejects concurrent requests during a half-open probe and reopens after that probe fails", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(5_000);
        const circuitBreaker = createCircuitBreaker();
        const initialFailure = serviceFailure("initial failure");
        await expect(
            circuitBreaker.execute(async () => {
                throw initialFailure;
            }),
        ).rejects.toMatchObject({
            message: initialFailure.message,
            isRetryable: true,
            isCircuitBreakerFailure: true,
            cause: initialFailure,
        });

        vi.setSystemTime(6_001);
        let rejectProbe!: (error: Error) => void;
        const probeResult = new Promise<string>((_resolve, reject) => {
            rejectProbe = reject;
        });
        const probe = vi.fn(() => probeResult);

        const probeExecution = circuitBreaker.execute(probe);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(circuitBreaker.getState()).toEqual({
            state: "half-open",
            failures: 1,
            lastFailure: 5_000,
        });

        const concurrentRequest = vi.fn(async () => "must not run");
        await expect(
            circuitBreaker.execute(concurrentRequest),
        ).rejects.toBeInstanceOf(CircuitBreakerHalfOpenError);
        expect(concurrentRequest).not.toHaveBeenCalled();

        vi.setSystemTime(7_000);
        const probeFailure = serviceFailure("probe failed");
        rejectProbe(probeFailure);
        await expect(probeExecution).rejects.toMatchObject({
            message: probeFailure.message,
            isRetryable: true,
            isCircuitBreakerFailure: true,
            cause: probeFailure,
        });

        expect(circuitBreaker.getState()).toEqual({
            state: "open",
            failures: 2,
            lastFailure: 7_000,
        });

        const afterFailure = vi.fn(async () => "must not run");
        await expect(
            circuitBreaker.execute(afterFailure),
        ).rejects.toBeInstanceOf(CircuitBreakerOpenError);
        expect(afterFailure).not.toHaveBeenCalled();
    });
});
