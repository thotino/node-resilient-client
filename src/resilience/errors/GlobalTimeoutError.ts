import { ResilienceError } from "./ResilienceError";

export class GlobalTimeoutError extends ResilienceError {
    constructor() {
        const message: string = "Timeout";
        const code: string = "ERR_OPERATION_TIMEOUT";
        const isRetryable: boolean = false;
        const isCircuitBreakerFailure: boolean = false;
        super(message, code, isRetryable, isCircuitBreakerFailure, null);
    }
}
