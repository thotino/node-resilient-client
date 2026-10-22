import { ResilienceError } from "./ResilienceError";

export class CustomTimeoutError extends ResilienceError {
    constructor() {
        const message: string = "Attempt timedout";
        const code: string = "ERR_ATTEMPT_TIMEOUT";
        const isRetryable: boolean = true;
        const isCircuitBreakerFailure: boolean = true;
        super(message, code, isRetryable, isCircuitBreakerFailure, null);
    }
}
