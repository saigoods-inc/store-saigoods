const buckets = new Map();

function clientKey(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req?.socket?.remoteAddress || "unknown");
}

export function assertPublicApiRequestAllowed(req, { name, limit, windowMs, maxBodyBytes = 128_000 }) {
  const contentLength = Number(req?.headers?.["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    const error = new Error("Request body too large.");
    error.statusCode = 413;
    throw error;
  }

  const now = Date.now();
  const key = `${name}:${clientKey(req)}`;
  const existing = buckets.get(key);
  const bucket = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : existing;
  bucket.count += 1;
  buckets.set(key, bucket);

  if (bucket.count > limit) {
    const error = new Error("Too many requests. Please wait and try again.");
    error.statusCode = 429;
    throw error;
  }

  if (buckets.size > 2000) {
    for (const [bucketKey, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(bucketKey);
    }
  }
}

export function __resetPublicApiGuardForTests() {
  buckets.clear();
}
