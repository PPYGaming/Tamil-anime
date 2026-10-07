"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../app.js");

const core = () => [
  { name: "Crunchyroll", available: false, officialUrl: null, tamilDubVerified: false },
  { name: "Netflix", available: false, officialUrl: null, tamilDubVerified: false },
  { name: "Amazon Prime Video", available: false, officialUrl: null, tamilDubVerified: false }
];
const HS = "https://www.hotstar.com/in/shows/demon-slayer/1271234567";

test("JioHotstar and Sony LIV rows always appear", () => {
  const plain = app.platformRows({ platforms: core() });
  assert.match(plain, /JioHotstar/); assert.match(plain,/Sony LIV/);
  const html = app.platformRows({ platforms: [...core(), { name: "JioHotstar", available: true, officialUrl: HS, tamilDubVerified: false, tamilDubReported: true, tamilDubReportUrl: "https://example.org/r", tamilDubReportSource: "Report" }] });
  assert.match(html, /JioHotstar/);
  assert.match(html, /Open on JioHotstar/);
  assert.match(html,/Sony LIV/);
});

test("a proof link off the row's own platform domain is not shown", () => {
  const rows = core();
  rows[0] = { name: "Crunchyroll", available: true, officialUrl: "https://www.crunchyroll.com/series/G79H23Z8P/x", tamilDubVerified: true, tamilDubVerificationUrl: "https://evil.example.com/proof" };
  const html = app.platformRows({ platforms: rows });
  assert.ok(!html.includes("evil.example.com"));
});
