"use strict";

/*
 * Optional adapter: runs the handler as a plain Node HTTP server (Node 18+, no dependencies). It exists so the handler
 * can be exercised anywhere Node runs. It is NOT a deployment: no host is chosen, nothing is started by any workflow,
 * and the repository does not contain a deploy configuration for any platform.
 *
 *   node backend/refresh-scan/adapters/node-server.js
 *
 * Put it behind TLS (a reverse proxy or the platform's edge). If that proxy sets X-Forwarded-For, set TRUST_PROXY=true.
 */

const http = require("node:http");
const { loadConfig } = require("../src/config");
const { createRefreshHandler } = require("../src/handler");

const MAX_BODY_BYTES = 16 * 1024;

function toRequest(req, base) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (name.toLowerCase() === "x-socket-ip") continue; // a client can never set this one
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }

  headers.set("x-socket-ip", req.socket.remoteAddress || "unknown");

  return new Request(new URL(req.url, base), { method: req.method, headers }); // the service has no request bodies
}

function createServer({ env = process.env, logger = console } = {}) {
  const loaded = loadConfig(env);

  if (!loaded.ok) {
    // Names and rules only, never values.
    logger.warn(`refresh-scan: not configured. Missing: ${loaded.missing.join(", ") || "none"}. Problems: ${loaded.problems.join("; ") || "none"}.`);
  }

  const handle = createRefreshHandler({ config: loaded, logger: { info: (entry) => logger.log(JSON.stringify(entry)), warn: (entry) => logger.warn(JSON.stringify(entry)) } });

  return http.createServer(async (req, res) => {
    try {
      if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        return;
      }

      const response = await handle(toRequest(req, "http://localhost"));
      const headers = {};

      response.headers.forEach((value, name) => {
        if (name.toLowerCase() !== "set-cookie") headers[name] = value;
      });

      const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      if (cookies.length) headers["set-cookie"] = cookies;

      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      logger.error(JSON.stringify({ event: "unhandled", name: error && error.name })); // no message: it could echo input
      res.writeHead(500, { "Content-Type": "application/json" }).end('{"error":"internal","message":"Internal error."}');
    }
  });
}

module.exports = { createServer, toRequest };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  createServer().listen(port, () => console.log(`refresh-scan listening on :${port}`));
}
