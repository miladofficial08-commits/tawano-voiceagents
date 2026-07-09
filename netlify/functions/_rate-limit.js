const buckets = new Map();

function getIp(event) {
  const headerValue = event && event.headers
    ? (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'] || '')
    : '';
  return String(headerValue).split(',')[0].trim() || 'unknown';
}

function checkRateLimit(event, key, options) {
  const windowMs = Number((options && options.windowMs) || 60 * 1000);
  const maxRequests = Number((options && options.maxRequests) || 30);
  const now = Date.now();
  const ip = getIp(event);
  const bucketKey = ip + ':' + key;

  let bucket = buckets.get(bucketKey);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
  }

  bucket.count += 1;
  buckets.set(bucketKey, bucket);

  const remaining = Math.max(0, maxRequests - bucket.count);
  const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

  return {
    allowed: bucket.count <= maxRequests,
    remaining,
    retryAfterSec,
  };
}

module.exports = {
  checkRateLimit,
};