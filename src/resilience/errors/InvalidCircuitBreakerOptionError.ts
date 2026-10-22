export class InvalidCircuitBreakerOptionError extends Error {
    readonly code: string = "INVALID_CIRCUIT_BREAKER_OPTION";
    constructor() {
        const message: string = "One or several options are invalid";
        super(message);
    }
}
