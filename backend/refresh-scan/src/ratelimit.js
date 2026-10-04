"use strict";

/* Fixed-window rate limiter over the store. hit() both counts and decides. */
function createRateLimiter(store) {
  return {
    async hit(key, { limit, windowSeconds }) {
      const count = await store.incr(`rl:${key}`, windowSeconds);

      if (count > limit) {
        const retryAfterSeconds = Math.max(1, await store.ttl(`rl:${key}`));
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }

      return { allowed: true, remaining: limit - count, retryAfterSeconds: 0 };
    }
  };
}

module.exports = { createRateLimiter };
