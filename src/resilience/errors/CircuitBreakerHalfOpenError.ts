import { ResilienceError } from "./ResilienceError";

export class CircuitBreakerHalfOpenError extends ResilienceError {
    constructor() {
        const code: string = "ERR_CIRCUIT_BREAKER_HALF_OPEN";
        const isRetryable: boolean = false;
        const isCircuitBreakerFailure: boolean = false;
        const message: string =
            "Circuit breaker is half open, waiting for test requests";
        super(message, code, isRetryable, isCircuitBreakerFailure, null);
    }
}
