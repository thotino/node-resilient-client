export class InvalidRateLimiterOptionError extends Error {
    readonly code: string = "INVALID_RATE_LIMITER_OPTION";
    constructor() {
        const message: string = "One or several options are invalid";
        super(message);
    }
}
