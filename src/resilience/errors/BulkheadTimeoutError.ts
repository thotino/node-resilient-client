import { ResilienceError } from "./ResilienceError";

export class BulkheadTimeoutError extends ResilienceError {
    value: { name: string; timeout: number };
    constructor(name: string, timeout: number) {
        const isRetryable: boolean = false;
        const isCircuitBreakerFailure: boolean = false;
        const code: string = "ERR_BULKHEAD_TIMED_OUT";
        const message = "Bulkhead timed out";
        super(message, code, isRetryable, isCircuitBreakerFailure, null);
        this.value = { name, timeout };
    }
}
