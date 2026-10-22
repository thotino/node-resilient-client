export class RequestCoalescer {
    #inFlight: Map<string, Promise<unknown>> = new Map();
    async get<T>(key: string, fn: () => Promise<T>) {
        if (this.#inFlight.has(key)) {
            return this.#inFlight.get(key) as Promise<T>;
        }
        const promise = fn();
        this.#inFlight.set(key, promise);
        try {
            return await promise;
        } finally {
            this.#inFlight.delete(key);
        }
    }
}
