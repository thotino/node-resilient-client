import { ResilienceError } from "./ResilienceError";

export class BulkheadRejectedError extends ResilienceError {
    value: { name: string; maxConcurrent: number; waitLength: number };
    constructor(name: string, maxConcurrent: number, waitLength: number) {
        const isCircuitBreakerFailure: boolean = false;
        const isRetryable: boolean = false;
        const code = "ERR_BULKHEAD_REJECTED";
        const message = "Bulkhead is full";
        super(message, code, isRetryable, isCircuitBreakerFailure, null);
        this.value = { name, maxConcurrent, waitLength };
    }
}
