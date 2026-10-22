import { ResilienceError } from "./ResilienceError";

export class BulkheadAcquisitionAbortedError extends ResilienceError {
    constructor(cause: unknown) {
        const code: string = "ERR_BULKHEAD_ACQUISITION_ABORTED";
        const isRetryable: boolean = false;
        const isCircuitBreakerFailure: boolean = false;
        const message: string = "Bulkhead acquisition aborted";
        super(message, code, isRetryable, isCircuitBreakerFailure, { cause });
    }
}
