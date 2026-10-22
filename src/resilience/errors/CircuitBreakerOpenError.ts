import { ResilienceError } from "./ResilienceError";

export class CircuitBreakerOpenError extends ResilienceError {
    constructor() {
        const isRetryable: boolean = false;
        const isCircuitBreakerFailure: boolean = false;
        const code: string = "ERR_CIRCUIT_BREAKER_OPEN";
        const message: string = "Circuit breaker is open";
        super(message, code, isRetryable, isCircuitBreakerFailure, null);
    }
}
