/**
 * @see https://redis.io/tutorials/howtos/ratelimiting/
 * @see https://oneuptime.com/blog/post/2026-01-06-nodejs-rate-limiting-no-external-services/view
 */

import { InvalidRateLimiterOptionError } from "./errors/InvalidRateLimiterOptionError";

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfter?: number;
    resetAt?: number;
    currentCount?: number;
}

interface RateLimiterInterface {
    get maxRequests(): number;
    attempt: (id: string, tokens?: number) => RateLimitResult;
    connect: () => void;
    close: () => void;
}
export enum RateLimiterAlgorithms {
    FIXED_WINDOW = "fixed-window",
    SLIDING_WINDOW = "sliding-window",
    SLIDING_WINDOW_COUNTER = "sliding-window-counter",
    TOKEN_BUCKET = "token-bucket",
}
interface WindowRateLimiterOptions {
    readonly windowMS: number;
    readonly maxRequests: number;
}
class FixedWindowRateLimiter implements RateLimiterInterface {
    #windowMS: number = 60_000;
    #maxRequests: number = 100;
    #windows: Map<string, number> = new Map();
    #cleanupInterval: NodeJS.Timeout | null = null;
    constructor(options: WindowRateLimiterOptions) {
        if (options.windowMS <= 0 || options.maxRequests < 1) {
            throw new InvalidRateLimiterOptionError();
        }
        this.#windowMS = options.windowMS;
        this.#maxRequests = options.maxRequests;
    }
    async connect() {
        if (this.#cleanupInterval == null) {
            this.#cleanupInterval = setInterval(
                () => this.#cleanup(),
                this.#windowMS,
            );
        }
    }
    async close() {
        if (this.#cleanupInterval != null) {
            clearInterval(this.#cleanupInterval);
            this.#cleanupInterval = null;
        }
    }
    #getWindowKey(identifier: string) {
        const windowStart = Math.floor(Date.now() / this.#windowMS);
        return `${identifier}:${windowStart}`;
    }
    get maxRequests() {
        return this.#maxRequests;
    }
    attempt(id: string) {
        const key = this.#getWindowKey(id);
        const current = this.#windows.get(key) ?? 0;
        if (current >= this.#maxRequests) {
            return { allowed: false, remaining: 0 };
        }
        this.#windows.set(key, current + 1);
        return { allowed: true, remaining: this.#maxRequests - current - 1 };
    }
    #cleanup() {
        const now = Date.now();
        const currentWindow = Math.floor(now / this.#windowMS);
        for (const [key] of this.#windows) {
            const windowNum = key.slice(key.lastIndexOf(":") + 1);
            if (Number.parseInt(windowNum) < currentWindow - 1) {
                this.#windows.delete(key);
            }
        }
    }
}

class SlidingWindowLogLimiter implements RateLimiterInterface {
    #windowMS: number = 60_000;
    #maxRequests: number = 100;
    #requestLogs: Map<string, number[]> = new Map();
    #cleanupInterval: NodeJS.Timeout | null = null;
    constructor(options: WindowRateLimiterOptions) {
        if (options.windowMS <= 0 || options.maxRequests < 1) {
            throw new InvalidRateLimiterOptionError();
        }
        this.#windowMS = options.windowMS;
        this.#maxRequests = options.maxRequests;
    }
    connect() {
        if (this.#cleanupInterval == null) {
            this.#cleanupInterval = setInterval(
                () => this.#cleanup(),
                this.#windowMS,
            );
        }
    }
    close() {
        if (this.#cleanupInterval != null) {
            clearInterval(this.#cleanupInterval);
            this.#cleanupInterval = null;
        }
    }
    attempt(id: string) {
        const now = Date.now();
        const windowStart = now - this.#windowMS;
        let requests = this.#requestLogs.get(id) ?? [];
        requests = requests.filter(timestamp => timestamp > windowStart);
        if (requests.length >= this.#maxRequests) {
            this.#requestLogs.set(id, requests);
            return {
                allowed: false,
                remaining: 0,
                resetAt: requests[0] + this.#windowMS,
            };
        }
        requests.push(now);
        this.#requestLogs.set(id, requests);
        return {
            allowed: true,
            remaining: this.#maxRequests - requests.length,
        };
    }
    get maxRequests() {
        return this.#maxRequests;
    }
    #cleanup() {
        const now = Date.now();
        const windowStart = now - this.#windowMS;
        for (const [identifier, requests] of this.#requestLogs) {
            const valid = requests.filter(ts => ts > windowStart);
            if (valid.length === 0) {
                this.#requestLogs.delete(identifier);
            } else {
                this.#requestLogs.set(identifier, valid);
            }
        }
    }
}

class SlidingWindowCounterLimiter implements RateLimiterInterface {
    #windowMS: number = 60_000;
    #maxRequests: number = 100;
    #windows: Map<string, number> = new Map();
    #cleanupInterval: NodeJS.Timeout | null = null;
    constructor(options: WindowRateLimiterOptions) {
        if (options.windowMS <= 0 || options.maxRequests < 1) {
            throw new InvalidRateLimiterOptionError();
        }
        this.#windowMS = options.windowMS;
        this.#maxRequests = options.maxRequests;
    }
    connect() {
        if (this.#cleanupInterval == null) {
            this.#cleanupInterval = setInterval(() => {
                const cleanupWindowStart =
                    Math.floor(Date.now() / this.#windowMS) * this.#windowMS;
                this.#cleanup(cleanupWindowStart);
            }, this.#windowMS);
        }
    }
    close() {
        if (this.#cleanupInterval != null) {
            clearInterval(this.#cleanupInterval);
            this.#cleanupInterval = null;
        }
    }
    get maxRequests() {
        return this.#maxRequests;
    }
    attempt(id: string) {
        const now = Date.now();
        const currentWindowStart =
            Math.floor(now / this.#windowMS) * this.#windowMS;
        const previousWindowStart = currentWindowStart - this.#windowMS;

        const currentKey = `${id}:${currentWindowStart}`;
        const previousKey = `${id}:${previousWindowStart}`;

        const currentCount = this.#windows.get(currentKey) ?? 0;
        const previousCount = this.#windows.get(previousKey) ?? 0;

        const elapsedInCurrentWindow = now - currentWindowStart;
        const previousWindowWeight =
            1 - elapsedInCurrentWindow / this.#windowMS;
        const weightedCount =
            currentCount + previousCount * previousWindowWeight;
        if (weightedCount >= this.#maxRequests) {
            return {
                allowed: false,
                remaining: 0,
                currentCount: Math.ceil(weightedCount),
            };
        }
        this.#windows.set(currentKey, currentCount + 1);
        return {
            allowed: true,
            remaining: Math.floor(this.#maxRequests - weightedCount - 1),
        };
    }
    #cleanup(currentWindowStart: number) {
        const oldestValidWindow = currentWindowStart - this.#windowMS;
        for (const [key] of this.#windows) {
            const windowStart = key.slice(key.lastIndexOf(":") + 1);
            if (Number.parseInt(windowStart) < oldestValidWindow) {
                this.#windows.delete(key);
            }
        }
    }
}
type Bucket = { tokens: number; lastRefill: number };
interface TokenBucketLimiterOptions {
    readonly bucketSize: number;
    readonly refillRate: number;
}
class TokenBucketLimiter implements RateLimiterInterface {
    #bucketSize = 10;
    #refillRate = 1;
    #buckets: Map<string, Bucket> = new Map();
    #cleanupInterval: NodeJS.Timeout | null = null;
    constructor(options: TokenBucketLimiterOptions) {
        if (options.bucketSize < 1 || options.refillRate <= 0) {
            throw new InvalidRateLimiterOptionError();
        }
        this.#bucketSize = options.bucketSize;
        this.#refillRate = options.refillRate;
    }
    connect() {
        if (this.#cleanupInterval == null) {
            this.#cleanupInterval = setInterval(() => this.#cleanup(), 30_000);
        }
    }
    close() {
        if (this.#cleanupInterval != null) {
            clearInterval(this.#cleanupInterval);
            this.#cleanupInterval = null;
        }
    }
    get maxRequests() {
        return this.#bucketSize;
    }
    #getBucket(id: string) {
        if (!this.#buckets.has(id)) {
            this.#buckets.set(id, {
                lastRefill: Date.now(),
                tokens: this.#bucketSize,
            });
        }
        return this.#buckets.get(id)!;
    }

    #refillBucket(bucket: Bucket) {
        const now = Date.now();
        const timePassed = (now - bucket.lastRefill) / 1000;
        const tokensToAdd = timePassed * this.#refillRate;

        return {
            tokens: Math.min(this.#bucketSize, bucket.tokens + tokensToAdd),
            lastRefill: now,
        };
    }
    attempt(identifier: string, tokens: number = 1) {
        if (
            !Number.isInteger(tokens) ||
            tokens <= 0 ||
            tokens > this.#bucketSize
        ) {
            throw new Error("ERR_INVALID_TOKENS_NUMBER");
        }
        let bucket = this.#getBucket(identifier);
        bucket = this.#refillBucket(bucket);
        this.#buckets.set(identifier, bucket);
        if (bucket.tokens >= tokens) {
            bucket.tokens -= tokens;
            return {
                allowed: true,
                remaining: Math.floor(bucket.tokens),
                retryAfter: 0,
            };
        }
        const tokensNeeded = tokens - bucket.tokens;
        const waitTime = tokensNeeded / this.#refillRate;
        return {
            allowed: false,
            remaining: 0,
            retryAfter: Math.ceil(waitTime),
        };
    }
    #cleanup(maxIdleMs = 3_600_000) {
        const now = Date.now();
        for (const [identifier, bucket] of this.#buckets) {
            if (now - bucket.lastRefill > maxIdleMs) {
                this.#buckets.delete(identifier);
            }
        }
    }
}
const DEFAULT_WINDOW_RATE_LIMITER_OPTIONS: WindowRateLimiterOptions = {
    maxRequests: 100,
    windowMS: 60_000,
};
const DEFAULT_TOKEN_BUCKET_RATE_LIMITER_OPTIONS: TokenBucketLimiterOptions = {
    refillRate: 1,
    bucketSize: 10,
};
export class RateLimiter {
    #limiters: Record<RateLimiterAlgorithms, RateLimiterInterface> = {
        [RateLimiterAlgorithms.FIXED_WINDOW]: new FixedWindowRateLimiter(
            DEFAULT_WINDOW_RATE_LIMITER_OPTIONS,
        ),
        [RateLimiterAlgorithms.SLIDING_WINDOW]: new SlidingWindowLogLimiter(
            DEFAULT_WINDOW_RATE_LIMITER_OPTIONS,
        ),
        [RateLimiterAlgorithms.SLIDING_WINDOW_COUNTER]:
            new SlidingWindowCounterLimiter(
                DEFAULT_WINDOW_RATE_LIMITER_OPTIONS,
            ),
        [RateLimiterAlgorithms.TOKEN_BUCKET]: new TokenBucketLimiter(
            DEFAULT_TOKEN_BUCKET_RATE_LIMITER_OPTIONS,
        ),
    };
    constructor(readonly algorithm: RateLimiterAlgorithms) {}
    get maxRequests() {
        return this.#limiters[this.algorithm].maxRequests;
    }
    connect() {
        this.#limiters[this.algorithm].connect();
    }
    close() {
        this.#limiters[this.algorithm].close();
    }
    attempt(identifier: string) {
        return this.#limiters[this.algorithm].attempt(identifier);
    }
}
