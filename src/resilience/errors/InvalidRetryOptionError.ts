export class InvalidRetryOptionError extends Error {
    readonly code: string = "INVALID_RETRY_OPTION";
    constructor() {
        const message: string = "One or several options are invalid";
        super(message);
    }
}
