"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const mod = require("../app.js");
const { pageWindow, pagerHtml } = mod.api || mod;

const pageNumbers = (html) =>
  [...html.matchAll(/class="pager-btn pager-num[^"]*" data-page="(\d+)"/g)].map((m) => Number(m[1]));
const gapCount = (html) => (html.match(/class="pager-gap"/g) || []).length;
const tag = (html, cls) => html.match(new RegExp(`<button[^>]*${cls}[^>]*>`))[0];

test("pageWindow: zero results", () => {
  assert.deepEqual(pageWindow(0, 1, 20), { page: 1, pages: 1, start: 0, end: 0 });
});

test("pageWindow: a single page", () => {
  assert.deepEqual(pageWindow(15, 1, 20), { page: 1, pages: 1, start: 0, end: 15 });
  assert.deepEqual(pageWindow(20, 1, 20), { page: 1, pages: 1, start: 0, end: 20 });
});

test("pageWindow: 150 items, size 20 gives 8 pages", () => {
  assert.deepEqual(pageWindow(150, 1, 20), { page: 1, pages: 8, start: 0, end: 20 });
  assert.deepEqual(pageWindow(150, 2, 20), { page: 2, pages: 8, start: 20, end: 40 });
});

test("pageWindow: last page is partial", () => {
  assert.deepEqual(pageWindow(150, 8, 20), { page: 8, pages: 8, start: 140, end: 150 });
  assert.deepEqual(pageWindow(141, 8, 20), { page: 8, pages: 8, start: 140, end: 141 });
});

test("pageWindow: clamps out-of-range and invalid pages", () => {
  assert.equal(pageWindow(150, 99, 20).page, 8);
  assert.deepEqual(pageWindow(150, 99, 20), pageWindow(150, 8, 20));
  assert.equal(pageWindow(150, 0, 20).page, 1);
  assert.equal(pageWindow(150, -4, 20).page, 1);
  assert.equal(pageWindow(150, NaN, 20).page, 1);
  assert.equal(pageWindow(150, undefined, 20).page, 1);
  assert.equal(pageWindow(0, 5, 20).page, 1);
});

test("pagerHtml: empty for a single page", () => {
  assert.equal(pagerHtml(1, 1), "");
  assert.equal(pagerHtml(1, 0), "");
});

test("pagerHtml: first page of 8 shows 1, 2, ellipsis, 8", () => {
  const html = pagerHtml(1, 8);
  assert.deepEqual(pageNumbers(html), [1, 2, 8]);
  assert.equal(gapCount(html), 1);
});

test("pagerHtml: middle page shows first, last, current +-1 and two ellipses", () => {
  const html = pagerHtml(5, 8);
  assert.deepEqual(pageNumbers(html), [1, 4, 5, 6, 8]);
  assert.equal(gapCount(html), 2);
});

test("pagerHtml: last page of 8 shows 1, ellipsis, 7, 8", () => {
  const html = pagerHtml(8, 8);
  assert.deepEqual(pageNumbers(html), [1, 7, 8]);
  assert.equal(gapCount(html), 1);
});

test("pagerHtml: few pages have no ellipsis", () => {
  const html = pagerHtml(2, 3);
  assert.deepEqual(pageNumbers(html), [1, 2, 3]);
  assert.equal(gapCount(html), 0);
});

test("pagerHtml: Previous is disabled on page 1, Next is not", () => {
  const html = pagerHtml(1, 8);
  assert.match(tag(html, "pager-prev"), /\sdisabled/);
  assert.doesNotMatch(tag(html, "pager-next"), /\sdisabled/);
});

test("pagerHtml: Next is disabled on the last page, Previous is not", () => {
  const html = pagerHtml(8, 8);
  assert.match(tag(html, "pager-next"), /\sdisabled/);
  assert.doesNotMatch(tag(html, "pager-prev"), /\sdisabled/);
});

test("pagerHtml: neither is disabled in the middle, and they target adjacent pages", () => {
  const html = pagerHtml(5, 8);
  assert.doesNotMatch(tag(html, "pager-prev"), /\sdisabled/);
  assert.doesNotMatch(tag(html, "pager-next"), /\sdisabled/);
  assert.match(tag(html, "pager-prev"), /data-page="4"/);
  assert.match(tag(html, "pager-next"), /data-page="6"/);
});

test("pagerHtml: exactly one aria-current=page, on the current page", () => {
  const html = pagerHtml(5, 8);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html.match(/<button[^>]*aria-current="page"[^>]*>/)[0], /data-page="5"/);
});

test("pagerHtml: an out-of-range page is clamped", () => {
  const html = pagerHtml(99, 8);
  assert.match(html.match(/<button[^>]*aria-current="page"[^>]*>/)[0], /data-page="8"/);
  assert.match(tag(html, "pager-next"), /\sdisabled/);
});
