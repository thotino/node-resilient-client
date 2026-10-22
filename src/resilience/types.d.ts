import { JitterStatuses } from "./constants";
export interface ResilienceErrorInterface {
    readonly isRetryable: boolean;
    readonly isCircuitBreakerFailure: boolean;
    readonly code: string;
    readonly message: string;
}
export type ErrorClassification = Pick<
    ResilienceErrorInterface,
    "isRetryable" | "isCircuitBreakerFailure"
>;

export interface RetryOptions {
    readonly maxAttempts: number;
    readonly initialDelay: number;
    readonly maxDelay: number;
    readonly factor: number;
    readonly jitter: JitterStatuses;
    readonly timeout: number;
    readonly retryableErrors: Array<string>;
    readonly retryableStatusCodes: Array<number>;
}
export interface BulkheadOptions {
    readonly name: string;
    readonly maxConcurrent: number;
    readonly maxWaiting: number;
    readonly timeoutMS: number;
}
export interface CircuitBreakerOptions {
    readonly failureThreshold: number;
    readonly resetTimeout: number;
    readonly halfOpenRequests: number;
}
export interface ResilienceClientConfig {
    readonly retryOptions: Partial<RetryOptions>;
    readonly circuitBreakerOptions: Partial<CircuitBreakerOptions>;
    readonly bulkheadOptions: Partial<BulkheadOptions>;
}
