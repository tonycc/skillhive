export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

type Bucket = { count: number; resetAt: number };

/** 有界的进程内限流器；调用方决定使用 IP、员工或令牌作为隔离键。 */
export function createKeyedRateLimiter(windowMs: number, max: number, maxBuckets = 10_000) {
  const buckets = new Map<string, Bucket>();

  function compact(now: number): void {
    if (buckets.size < maxBuckets) return;
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }

  function current(key: string, now: number): Bucket | undefined {
    const bucket = buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  return {
    consume(key: string, now = Date.now()): RateLimitResult {
      compact(now);
      let boundedKey = key;
      if (buckets.size >= maxBuckets && !buckets.has(key)) boundedKey = "__overflow__";
      const existing = current(boundedKey, now);
      const bucket = existing ?? { count: 0, resetAt: now + windowMs };
      bucket.count += 1;
      buckets.set(boundedKey, bucket);
      return {
        allowed: bucket.count <= max,
        limit: max,
        remaining: Math.max(0, max - bucket.count),
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
      };
    },
  };
}
