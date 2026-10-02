"use strict";

// Run: node --test tests/*.test.js
// Honest labeling in the detail view: an announcement is Tamil PROOF, never an "Open on <platform>" watch page.
// Complements tests/detail-view_test.js (which stays unchanged); needs no index.html.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = require("../app.js");

const FIXTURE_CATALOG = path.join(__dirname, "fixtures", "anime.25-records.json");
const CR_NEWS = "https://www.crunchyroll.com/news/announcements/2024/5/16/dr-stone-tamil-dub";
const CR_NEWS_LOCALE = "https://www.crunchyroll.com/th/news/announcements/2024/1/30/spy-x-family-tamil-dub";
const CR_HELP = "https://www.crunchyroll.com/hc/en-us/articles/123-languages";
const CR_SERIES = "https://www.crunchyroll.com/series/GABC123/demo-quest";
const NF_TUDUM = "https://www.netflix.com/tudum/articles/demo-tamil-dub";
const NF_TITLE = "https://www.netflix.com/title/81234567";

const item = (extra) => ({
  id: "demo",
  title: "Demo",
  tamilDubVerified: true,
  platforms: [],
  episodes: [],
  youtube: [],
  ...extra
});

// The rendered <li> of one platform: its text and the hrefs/labels of its links.
function platformItem(html, name) {
  const chunk = html.split('<li class="platform-item').slice(1).map((part) => part.split("</li>")[0]).find((part) => part.includes(`>${name}<`));
  assert.ok(chunk, `${name} item rendered`);

  const links = [...chunk.matchAll(/<a class="action[^"]*" href="([^"]+)"[^>]*>([^<]*)/g)].map((match) => ({ href: match[1], label: match[2].trim() }));
  const text = chunk.replace(/<span class="sr-only">[^<]*<\/span>/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return { links, text };
}

const crunchyroll = (row) => platformItem(app.detailHtml(item({ platforms: [{ name: "Crunchyroll", ...row }] })), "Crunchyroll");

test("isAnnouncementUrl recognises news/help articles and nothing that is a title or watch page", () => {
  for (const url of [CR_NEWS, CR_NEWS_LOCALE, CR_HELP, NF_TUDUM, "https://about.netflix.com/en/news/something"]) {
    assert.equal(app.isAnnouncementUrl(url), true, url);
  }

  for (const url of [CR_SERIES, "https://www.crunchyroll.com/watch/GEP1/the-start", NF_TITLE, "https://www.netflix.com/watch/81000002", "https://www.primevideo.com/detail/0ABCDEF123", "https://evil.example/news/announcements/x", "nope", "", null, undefined, "javascript:alert(1)"]) {
    assert.equal(app.isAnnouncementUrl(url), false, String(url));
  }
});

test("announcement-only verified platform: no 'Open on' button, the announcement is labelled as Tamil proof", () => {
  const { links, text } = crunchyroll({ available: true, officialUrl: CR_NEWS, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS });

  assert.deepEqual(links.map((link) => link.href), [CR_NEWS], "one link, the exact announcement url");
  assert.equal(links[0].label, "View Tamil dub verification");
  assert.doesNotMatch(text, /Open on Crunchyroll/);
  assert.match(text, /Tamil dub verified/);
  assert.match(text, /Announcement only: no official title or watch page linked/);
});

test("a real title page keeps the 'Open on' button and the proof link beside it (unchanged behaviour)", () => {
  const { links, text } = crunchyroll({ available: true, officialUrl: CR_SERIES, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS });

  assert.deepEqual(links.map((link) => [link.href, link.label]), [[CR_SERIES, "Open on Crunchyroll"], [CR_NEWS, "View Tamil dub verification"]]);
  assert.doesNotMatch(text, /Announcement only/);
});

test("announcement as the official url with a different proof url shows both, still without 'Open on'", () => {
  const { links, text } = crunchyroll({ available: true, officialUrl: CR_NEWS, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS_LOCALE });

  assert.deepEqual(links.map((link) => [link.href, link.label]), [[CR_NEWS_LOCALE, "View Tamil dub verification"], [CR_NEWS, "Read official announcement"]]);
  assert.doesNotMatch(text, /Open on Crunchyroll/);
});

test("an announcement on a platform without confirmed Tamil audio is not a watch page and does not imply Tamil audio", () => {
  const { links, text } = crunchyroll({ available: true, officialUrl: CR_NEWS, tamilDubVerified: false });

  assert.deepEqual(links.map((link) => [link.href, link.label]), [[CR_NEWS, "Read official announcement"]]);
  assert.doesNotMatch(text, /Open on Crunchyroll|Tamil dub verified/);
  assert.match(text, /Available, no confirmed Tamil audio/);
});

test("Netflix newsroom/Tudum articles are announcements too", () => {
  const html = app.detailHtml(item({ platforms: [{ name: "Netflix", available: true, officialUrl: NF_TUDUM, tamilDubVerified: false }] }));
  const { links, text } = platformItem(html, "Netflix");

  assert.doesNotMatch(text, /Open on Netflix/);
  assert.equal(links[0].href, NF_TUDUM);
  assert.equal(links[0].label, "Read official announcement");
});

test("a missing official link still says it is not configured (not 'announcement only')", () => {
  const { text } = crunchyroll({ available: true, officialUrl: null, tamilDubVerified: true, tamilDubVerificationUrl: CR_NEWS });

  assert.match(text, /Official link not configured/);
  assert.doesNotMatch(text, /Announcement only/);
});

test("REAL catalog: every published record renders its Crunchyroll announcement as proof, never as a watch page", () => {
  if (!fs.existsSync(FIXTURE_CATALOG)) assert.fail("fixture missing: tests/fixtures/anime.25-records.json");
  const catalog = JSON.parse(fs.readFileSync(FIXTURE_CATALOG, "utf8"));
  assert.equal(catalog.anime.length, 25);

  for (const record of catalog.anime) {
    const crunchy = platformItem(app.detailHtml(record), "Crunchyroll");

    assert.doesNotMatch(crunchy.text, /Open on Crunchyroll/, `${record.id}: announcement presented as a watch page`);
    assert.deepEqual(crunchy.links.map((link) => link.href), [record.tamilDubVerificationUrl], `${record.id}: exactly one link, the exact proof url`);
    assert.equal(crunchy.links[0].label, "View Tamil dub verification");

    // Honest about episodes too: the real catalog has no linked episode, so none is presented as watchable.
    const html = app.detailHtml(record);
    assert.doesNotMatch(html, /Watch episode|Open episode/i, `${record.id}: no invented episode link`);
  }
});
