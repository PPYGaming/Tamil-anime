"use strict";

/*
 * Session tokens and OAuth state, signed with HMAC-SHA256 (node:crypto only, no dependencies).
 *
 * A session token proves "GitHub said this person is on the owner list, recently". It carries no GitHub token and no
 * secret, expires in minutes, and is useless to anyone who does not also reach this service. It is kept in page memory
 * by the frontend, never in localStorage, never in HTML.
 */

const crypto = require("node:crypto");

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
const fromB64 = (text) => Buffer.from(String(text), "base64url");

const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest();

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/* kind separates token types so an OAuth state can never be replayed as a session ("aud" is part of what is signed). */
function sign(payload, secret, kind) {
  const body = b64(JSON.stringify({ ...payload, aud: kind }));
  return `${body}.${b64(hmac(secret, `${kind}.${body}`))}`;
}

function verify(token, secret, kind, nowSeconds) {
  if (typeof token !== "string" || token.length > 2048) return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };

  const expected = b64(hmac(secret, `${kind}.${parts[0]}`));
  if (!safeEqual(parts[1], expected)) return { ok: false, reason: "bad-signature" };

  let payload;

  try {
    payload = JSON.parse(fromB64(parts[0]).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!payload || typeof payload !== "object" || payload.aud !== kind) return { ok: false, reason: "wrong-kind" };
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

const SESSION = "refresh-scan-session";
const STATE = "refresh-scan-oauth-state";

const issueSession = ({ login, userId }, { secret, nowSeconds, ttlSeconds }) =>
  sign({ sub: login, uid: userId, iat: nowSeconds, exp: nowSeconds + ttlSeconds }, secret, SESSION);

const verifySession = (token, { secret, nowSeconds }) => verify(token, secret, SESSION, nowSeconds);

const issueState = ({ nonce, returnTo }, { secret, nowSeconds, ttlSeconds = 600 }) =>
  sign({ n: nonce, ret: returnTo, exp: nowSeconds + ttlSeconds }, secret, STATE);

const verifyState = (token, { secret, nowSeconds }) => verify(token, secret, STATE, nowSeconds);

function bearerToken(headers) {
  const header = headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_\-.]{10,2048})$/.exec(header);
  return match ? match[1] : null;
}

function readCookie(headers, name) {
  for (const part of String(headers.get("cookie") || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

module.exports = { issueSession, verifySession, issueState, verifyState, bearerToken, readCookie, safeEqual };
