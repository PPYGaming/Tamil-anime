"use strict";

// The YouTube client against a mocked fetch: quota, auth, retries with backoff and Retry-After, per-run unit budget,
// batching, timeouts and key redaction. No network and no real key.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createYouTubeClient, YouTubeApiError, classifyHttpError, parseDuration, normalizeVideo, playableIn, MAX_IDS_PER_CALL } = require("../scripts/discovery/youtube");
const { TEST_KEY, vid, video } = require("./helpers/discovery-harness");

const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body))
});

const apiError = (status, reason, message = "") => reply(status, { error: { code: status, message, errors: [{ reason }] } });

// Builds a client over a scripted sequence of replies. A function entry is called, a thrown Error is a network failure.
function scripted(replies, options = {}) {
  const calls = [];
  const sleeps = [];
  let index = 0;

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = replies[Math.min(index++, replies.length - 1)];
    const value = typeof next === "function" ? next(String(url)) : next;
    if (value instanceof Error) throw value;
    return value;
  };

  const client = createYouTubeClient({ apiKey: TEST_KEY, fetchImpl, sleep: async (ms) => sleeps.push(ms), random: () => 0, retries: 3, backoffBaseMs: 100, backoffMaxMs: 1000, ...options });
  return { client, calls, sleeps };
}

const rejectsWith = async (promise, kind) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof YouTubeApiError, `expected YouTubeApiError, got ${error && error.name}: ${error && error.message}`);
    assert.equal(error.kind, kind);
    return true;
  });
};

test("channels.list: returns the channel id, title and uploads playlist", async () => {
  const { client, calls } = scripted([reply(200, { items: [{ id: "UCchan", snippet: { title: "Muse India" }, contentDetails: { relatedPlaylists: { uploads: "UUuploads" } } }] })]);
  const channel = await client.getChannel("UCchan");

  assert.deepEqual(channel, { id: "UCchan", title: "Muse India", uploadsPlaylistId: "UUuploads" });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/youtube/v3/channels");
  assert.equal(url.searchParams.get("part"), "snippet,contentDetails");
  assert.equal(url.searchParams.get("id"), "UCchan");
  assert.equal(url.searchParams.get("key"), TEST_KEY);
});

test("channels.list: an unknown channel is null, not an error", async () => {
  const { client } = scripted([reply(200, { items: [] })]);
  assert.equal(await client.getChannel("UCnone"), null);
});

test("playlistItems.list: reads video ids, publish dates and the next page token", async () => {
  const { client, calls } = scripted([
    reply(200, {
      items: [
        { snippet: { title: "A", publishedAt: "2026-09-02T00:00:00Z", resourceId: { videoId: vid(2) } }, contentDetails: { videoId: vid(2), videoPublishedAt: "2026-09-01T00:00:00Z" } },
        { snippet: { title: "Bad id", resourceId: { videoId: "short" } }, contentDetails: { videoId: "short" } },
        { snippet: { title: "Private video" }, contentDetails: {} }
      ],
      nextPageToken: "NEXT"
    })
  ]);

  const page = await client.listUploads("UUuploads", "TOKEN");
  assert.deepEqual(page.items.map((item) => item.videoId), [vid(2)]);
  assert.equal(page.items[0].publishedAt, "2026-09-01T00:00:00Z");
  assert.equal(page.nextPageToken, "NEXT");

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/youtube/v3/playlistItems");
  assert.equal(url.searchParams.get("playlistId"), "UUuploads");
  assert.equal(url.searchParams.get("pageToken"), "TOKEN");
  assert.equal(url.searchParams.get("maxResults"), "50");
});

test("playlistItems.list: no next page token means the end", async () => {
  const { client } = scripted([reply(200, { items: [] })]);
  assert.equal((await client.listUploads("UUuploads")).nextPageToken, null);
});

test("videos.list: batches 50 ids per call, de-duplicates and ignores malformed ids", async () => {
  const ids = Array.from({ length: 120 }, (_, i) => vid(i + 1));
  const { client, calls } = scripted([(url) => reply(200, { items: new URL(url).searchParams.get("id").split(",").map((id) => video(id, `Tamil Dub | X Episode 1`)) })]);

  const found = await client.getVideos([...ids, ...ids, "bad", "x".repeat(40)]);

  assert.equal(found.size, 120);
  assert.equal(calls.length, Math.ceil(120 / MAX_IDS_PER_CALL));
  assert.ok(calls.every((call) => new URL(call.url).searchParams.get("id").split(",").length <= MAX_IDS_PER_CALL));
  assert.equal(new URL(calls[0].url).searchParams.get("part"), "snippet,contentDetails,status");
});

test("videos.list: ids the API does not return are simply absent from the result", async () => {
  const { client } = scripted([reply(200, { items: [video(vid(1), "Tamil Dub | X Episode 1")] })]);
  const found = await client.getVideos([vid(1), vid(2)]);

  assert.deepEqual([...found.keys()], [vid(1)]);
});

test("videos.list: the response is reduced to bounded fields, never stored raw", async () => {
  const raw = video(vid(1), `Tamil Dub | ${"X".repeat(1000)}`, { description: "D".repeat(5000), duration: "PT1H2M3S" });
  raw.extra = { secret: "should not survive" };
  const { client } = scripted([reply(200, { items: [raw] })]);
  const found = (await client.getVideos([vid(1)])).get(vid(1));

  assert.ok(found.title.length <= 300);
  assert.ok(found.description.length <= 600);
  assert.equal(found.durationSeconds, 3723);
  assert.equal(found.extra, undefined);
});

test("API key: sent as a query parameter, never in headers, and absent from every error message", async () => {
  const { client, calls } = scripted([apiError(403, "keyInvalid", `API key not valid: ${TEST_KEY}`)]);

  await assert.rejects(client.getChannel("UCchan"), (error) => {
    assert.equal(error.kind, "auth");
    assert.ok(!error.message.includes(TEST_KEY));
    assert.ok(!JSON.stringify(client.usage).includes(TEST_KEY));
    return true;
  });

  assert.ok(!JSON.stringify(calls[0].init.headers).includes(TEST_KEY));
});

test("API key: redacted from network error messages that echo the request URL", async () => {
  const { client } = scripted([new Error(`connect failed for https://www.googleapis.com/youtube/v3/channels?key=${TEST_KEY}`)], { retries: 0 });

  await assert.rejects(client.getChannel("UCchan"), (error) => {
    assert.equal(error.kind, "network");
    assert.ok(!error.message.includes(TEST_KEY));
    return true;
  });
});

test("quota exhaustion: classified as quota, not retried, counted once", async () => {
  const { client, calls, sleeps } = scripted([apiError(403, "quotaExceeded", "The request cannot be completed because you have exceeded your quota.")]);

  await rejectsWith(client.getChannel("UCchan"), "quota");
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
  assert.equal(client.usage.units, 1);
});

test("invalid key and API-not-enabled: auth, never retried", async () => {
  for (const [status, reason] of [[400, "keyInvalid"], [403, "accessNotConfigured"], [403, "forbidden"], [401, ""]]) {
    const { client, calls } = scripted([apiError(status, reason, reason === "keyInvalid" ? "API key not valid" : "")]);
    await rejectsWith(client.getChannel("UCchan"), "auth");
    assert.equal(calls.length, 1, `${status} ${reason}`);
  }
});

test("5xx and rate limits are retried with exponential backoff and jitter, then succeed", async () => {
  const ok = reply(200, { items: [] });
  const { client, calls, sleeps } = scripted([reply(503, {}), apiError(403, "rateLimitExceeded"), reply(500, {}), ok], { random: () => 0.5 });

  assert.equal(await client.getChannel("UCchan"), null);
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [100 * 1 + 50, 100 * 2 + 50, 100 * 4 + 50]);
  assert.equal(client.usage.units, 4); // every attempt costs quota
});

test("backoff is capped by backoffMaxMs", async () => {
  const { client, sleeps } = scripted([reply(503, {}), reply(503, {}), reply(503, {}), reply(200, { items: [] })], { backoffBaseMs: 400, backoffMaxMs: 500, random: () => 0 });
  await client.getChannel("UCchan");
  assert.deepEqual(sleeps, [400, 500, 500]);
});

test("Retry-After is honoured (bounded by the maximum backoff)", async () => {
  const { client, sleeps } = scripted([reply(429, {}, { "retry-after": "2" }), reply(429, {}, { "retry-after": "999" }), reply(200, { items: [] })], { backoffMaxMs: 5000 });
  await client.getChannel("UCchan");

  assert.deepEqual(sleeps, [2000, 5000]);
});

test("retries are bounded: a persistent 5xx ends in a server error after retries+1 attempts", async () => {
  const { client, calls } = scripted([reply(503, {})], { retries: 2 });

  await rejectsWith(client.getChannel("UCchan"), "server");
  assert.equal(calls.length, 3);
  assert.equal(client.usage.failures.length, 1);
  assert.equal(client.usage.failures[0].kind, "server");
});

test("network failures and timeouts are retried then reported with their own kind", async () => {
  const net = scripted([new Error("socket hang up")], { retries: 1 });
  await rejectsWith(net.client.getChannel("UCchan"), "network");
  assert.equal(net.calls.length, 2);

  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const slow = scripted([timeout], { retries: 0 });
  await rejectsWith(slow.client.getChannel("UCchan"), "timeout");
});

test("every request is sent with an abort signal so a hung socket cannot stall the run", async () => {
  const { client, calls } = scripted([reply(200, { items: [] })], { timeoutMs: 1234 });
  await client.getChannel("UCchan");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("an unreadable 200 body is treated as a retriable server fault, not as an empty result", async () => {
  const { client, calls } = scripted([reply(200, "<html>captive portal</html>")], { retries: 1 });

  await rejectsWith(client.getChannel("UCchan"), "server");
  assert.equal(calls.length, 2);
});

test("an invalid page token is reported as bad-page-token so the caller can reset its cursor", async () => {
  const { client } = scripted([apiError(400, "invalidPageToken", "Invalid value for pageToken")]);
  await rejectsWith(client.listUploads("UUuploads", "STALE"), "bad-page-token");
});

test("a missing playlist is not-found and is not retried", async () => {
  const { client, calls } = scripted([apiError(404, "playlistNotFound")]);
  await rejectsWith(client.listUploads("UUgone", null), "not-found");
  assert.equal(calls.length, 1);
});

test("the unit budget stops the run before the request that would exceed it", async () => {
  const { client, calls } = scripted([reply(200, { items: [] })], { unitBudget: 2 });

  await client.getChannel("UCchan");
  await client.getChannel("UCchan");
  await rejectsWith(client.getChannel("UCchan"), "budget");
  assert.equal(calls.length, 2);
  assert.equal(client.usage.units, 2);
});

test("the unit budget also bounds retries", async () => {
  const { client, calls } = scripted([reply(503, {})], { unitBudget: 3, retries: 8 });
  await rejectsWith(client.getChannel("UCchan"), "budget");
  assert.equal(calls.length, 3);
});

test("classifyHttpError maps the documented error shapes", () => {
  const body = (reason, message = "") => ({ error: { message, errors: [{ reason }] } });

  assert.equal(classifyHttpError(403, body("quotaExceeded")).kind, "quota");
  assert.equal(classifyHttpError(403, body("dailyLimitExceeded")).kind, "quota");
  assert.equal(classifyHttpError(403, body("rateLimitExceeded")).kind, "rate-limit");
  assert.equal(classifyHttpError(429, null).kind, "rate-limit");
  assert.equal(classifyHttpError(400, body("keyInvalid", "API key not valid")).kind, "auth");
  assert.equal(classifyHttpError(400, body("invalidPageToken", "pageToken")).kind, "bad-page-token");
  assert.equal(classifyHttpError(400, body("badRequest")).kind, "bad-request");
  assert.equal(classifyHttpError(404, null).kind, "not-found");
  assert.equal(classifyHttpError(502, null).kind, "server");
  assert.equal(classifyHttpError(418, null).kind, "http");
  assert.equal(classifyHttpError(500, "not an object").kind, "server");
});

test("parseDuration reads ISO-8601 durations", () => {
  assert.equal(parseDuration("PT24M10S"), 1450);
  assert.equal(parseDuration("PT1H"), 3600);
  assert.equal(parseDuration("P0D"), 0);
  assert.equal(parseDuration("P1DT1S"), 86401);
  assert.equal(parseDuration("garbage"), null);
  assert.equal(parseDuration(undefined), null);
});

test("normalizeVideo rejects malformed items and keeps region restrictions bounded", () => {
  assert.equal(normalizeVideo(null), null);
  assert.equal(normalizeVideo({ id: "short" }), null);
  assert.equal(normalizeVideo({ id: 12345678901 }), null);

  const restricted = normalizeVideo(video(vid(1), "Tamil Dub | X Episode 1", { regionRestriction: { blocked: ["IN", "xx", "US"] } }));
  assert.deepEqual(restricted.regionRestriction, { blocked: ["IN", "US"] });
});

test("playableIn: honours allowed and blocked lists, and does not invent a block when there is no metadata", () => {
  assert.equal(playableIn({ regionRestriction: null }, "IN"), true);
  assert.equal(playableIn({ regionRestriction: { blocked: ["IN"] } }, "IN"), false);
  assert.equal(playableIn({ regionRestriction: { blocked: ["US"] } }, "IN"), true);
  assert.equal(playableIn({ regionRestriction: { allowed: ["US"] } }, "IN"), false);
  assert.equal(playableIn({ regionRestriction: { allowed: ["IN", "US"] } }, "IN"), true);
});
