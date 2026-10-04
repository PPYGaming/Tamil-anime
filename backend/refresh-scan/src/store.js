"use strict";

/*
 * Tiny key/value store with TTLs, used for rate-limit counters and the "last dispatch" marker.
 *
 * The in-memory store below is per process. That is enough for a single long-running instance. On a platform that runs
 * several instances (or starts a fresh one per request) pass your own store with the same four methods backed by a
 * shared KV/Redis. Even with a per-process store the system stays safe, because the real arbiter is GitHub: the handler
 * asks GitHub which runs exist before it dispatches, and the workflow's `concurrency` group allows only one run at a
 * time with at most one waiting behind it.
 */

function createMemoryStore({ now = () => Date.now(), maxEntries = 10000 } = {}) {
  const map = new Map(); // key -> { value, expiresAt }

  const live = (key) => {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  };

  const prune = () => {
    if (map.size <= maxEntries) return;
    for (const [key, entry] of map) if (entry.expiresAt <= now()) map.delete(key);
    while (map.size > maxEntries) map.delete(map.keys().next().value); // oldest first: bounded memory, whatever the traffic
  };

  return {
    async get(key) {
      const entry = live(key);
      return entry ? entry.value : null;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      prune();
    },
    /* Adds 1 to a counter; the TTL starts when the counter is created (fixed window). Returns the new count. */
    async incr(key, ttlSeconds) {
      const entry = live(key);
      if (entry) {
        entry.value = Number(entry.value) + 1;
        return entry.value;
      }
      map.set(key, { value: 1, expiresAt: now() + ttlSeconds * 1000 });
      prune();
      return 1;
    },
    async ttl(key) {
      const entry = live(key);
      return entry ? Math.max(0, Math.ceil((entry.expiresAt - now()) / 1000)) : 0;
    },
    size: () => map.size
  };
}

module.exports = { createMemoryStore };
