export class InvalidBulkheadOptionError extends Error {
    readonly code: string = "INVALID_BULKHEAD_OPTION";
    /**
     *
     */
    constructor() {
        const message: string = "One or several options are invalid";
        super(message);
    }
}
