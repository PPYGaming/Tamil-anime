"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../app.js");
const f = api.freeSiteItems;

test("empty when no data", () => {
  for (const a of [null, {}, { freeSites: [] }, { freeSites: "x" }]) assert.equal(f(a), "");
});

test("site names with Available / Not available and no links or extra heading", () => {
  const html = f({ freeSites: [{ name: "Animesalt", available: true }, { name: "Toon Stream", available: false }] });
  assert.ok(html.includes('<h3 class="platform-name">Animesalt</h3>'));
  assert.ok(html.includes("Available</span>") && html.includes("Not available</span>"));
  assert.ok(!/href|http|<a |free sites/i.test(html));
});

test("detail page shows the rows in their own card after Where to watch, no heading", () => {
  const html = api.detailHtml({ title: "X", platforms: [], freeSites: [{ name: "Animesalt", available: true }] });
  assert.ok(html.indexOf("free-site-section") > html.indexOf("platformsHeading"));
  assert.ok(html.indexOf("Animesalt") > html.indexOf("free-site-section"));
  assert.ok(!/<h2[^>]*>[^<]*free/i.test(html));
  assert.equal(api.freeSiteSectionHtml({}), "");
});

test("escapes hostile site name", () => {
  const html = f({ freeSites: [{ name: "<img onerror=x>", available: true }] });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img onerror=x&gt;"));
});
