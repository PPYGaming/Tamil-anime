"use strict";

// Owner rule: only a title that STARTS with "Tamil Dub" can ever be processed. Pure unit tests, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { KINDS, matchTamilDubPrefix, startsWithTamilDub, parseTamilDubTitle, reasonText } = require("../scripts/discovery/title");

test("prefix rule: accepts only titles that start with Tamil Dub", () => {
  const accepted = [
    "Tamil Dub | Spy x Family Season 2 Episode 3 | Muse India",
    "Tamil Dub: Demo Show Episode 4",
    "tamil dub - Demo Show Episode 4",
    "TAMIL DUB Demo Show Episode 4",
    "  Tamil Dub | Demo Show Episode 4",
    "​Tamil Dub | Demo Show Episode 4", // zero-width space before the prefix
    "﻿Tamil Dub | Demo Show Episode 4", // BOM
    "Tamil   Dub | Demo Show Episode 4", // extra internal whitespace
    "Tamil\tDub | Demo Show Episode 4",
    "Tamil Dub",
    "[Tamil Dub] Campfire Cooking in Another World - Episode 20 (S2E08) | Muse IN",
    "(Tamil Dub) Demo Show Episode 4",
    "【Tamil Dub】Demo Show Episode 4"
  ];

  for (const title of accepted) assert.equal(startsWithTamilDub(title), true, `should accept: ${JSON.stringify(title)}`);
});

test("prefix rule: rejects everything that merely mentions Tamil or a dub", () => {
  const rejected = [
    "Naruto Episode 12 Tamil Dub", // prefix is later in the title
    "Demo Show Episode 4 | Tamil Dub",
    "[Hindi Dub] Demo Show Episode 4",
    "[Telugu Dub] Demo Show Episode 4",
    "Campfire Cooking in Another World - Episode 20 [Tamil Dub]", // tag at the end
    "[EN Sub] Campfire Cooking in Another World - Episode 20 (S2E08) | Muse IN",
    "[ [Tamil Dub] Demo Show",
    "Tamil Dubbed Demo Show Episode 4", // "Dubbed" is a different word
    "Tamil Dubstep Mix",
    "Tamil Sub Demo Show Episode 4",
    "Tamil Subtitles | Demo Show Episode 4",
    "Hindi Dub | Demo Show Episode 4",
    "Telugu Dub | Demo Show Episode 4",
    "Tamil | Demo Show Episode 4",
    "Tamil-Dub Demo Show", // hyphenated, not "Tamil Dub"
    "TamilDub Demo Show", // no space
    "Dub Tamil Demo Show",
    "In Tamil Dub | Demo Show",
    "Muse India | Tamil Dub | Demo Show Episode 4",
    "Demo Show Episode 4",
    "",
    "   ",
    null,
    undefined
  ];

  for (const title of rejected) assert.equal(startsWithTamilDub(title), false, `should reject: ${JSON.stringify(title)}`);
});

test("prefix rule: a description or any other text can never qualify a video, only the title", () => {
  const parsed = parseTamilDubTitle("Demo Show Episode 4");
  assert.equal(parsed.matches, false);
  assert.equal(parsed.kind, null);
  assert.deepEqual(parsed.nameCandidates, []);
  assert.equal(parsed.languageProof, null);
});

test("prefix match returns the remainder after separators", () => {
  const match = matchTamilDubPrefix("Tamil Dub | Demo Show Episode 4");
  assert.equal(match.matches, true);
  assert.equal(match.remainder, "Demo Show Episode 4");
  assert.equal(matchTamilDubPrefix("Nope").matches, false);
});

test("parser: explicit season and episode are read", () => {
  const cases = [
    ["Tamil Dub | Spy x Family Season 2 Episode 3 | Muse India", { season: 2, episode: 3, name: "Spy x Family" }],
    ["Tamil Dub | Demo Show S2E5", { season: 2, episode: 5, name: "Demo Show" }],
    ["Tamil Dub | Demo Show S02 E05", { season: 2, episode: 5, name: "Demo Show" }],
    ["Tamil Dub | Demo Show 2nd Season Episode 7", { season: 2, episode: 7, name: "Demo Show" }],
    ["Tamil Dub | Demo Show Second Season Ep 7", { season: 2, episode: 7, name: "Demo Show" }],
    ["Tamil Dub | Demo Show Episode 12", { season: null, episode: 12, name: "Demo Show" }],
    ["Tamil Dub | Demo Show Ep. 9 | Muse India", { season: null, episode: 9, name: "Demo Show" }],
    ["Tamil Dub - Demo Show - Episode 1", { season: null, episode: 1, name: "Demo Show" }]
  ];

  for (const [title, expected] of cases) {
    const parsed = parseTamilDubTitle(title);
    assert.equal(parsed.matches, true, title);
    assert.equal(parsed.kind, KINDS.EPISODE, title);
    assert.equal(parsed.season, expected.season, `${title} season`);
    assert.equal(parsed.episode, expected.episode, `${title} episode`);
    assert.equal(parsed.nameCandidates[0], expected.name, `${title} name`);
    assert.deepEqual(parsed.reasons, [], `${title} reasons`);
  }
});

test("parser: a missing season is never defaulted to season 1", () => {
  const parsed = parseTamilDubTitle("Tamil Dub | Demo Show Episode 3");
  assert.equal(parsed.season, null);
  assert.equal(parsed.episode, 3);
});

test("parser: the matched prefix is kept as language provenance", () => {
  assert.equal(parseTamilDubTitle("tamil dub | Demo Show Episode 3").languageProof, "tamil dub");
});

test("parser: trailers, teasers, clips and announcements are not episodes", () => {
  const promos = [
    "Tamil Dub | Demo Show Official Trailer",
    "Tamil Dub | Demo Show Teaser",
    "Tamil Dub | Demo Show Opening Song",
    "Tamil Dub | Demo Show Best Moments",
    "Tamil Dub | Demo Show Episode 3 Fight Scene",
    "Tamil Dub | Demo Show Episode 3 Review",
    "Tamil Dub | Demo Show Voice Cast Interview"
  ];

  for (const title of promos) assert.equal(parseTamilDubTitle(title).kind, KINDS.PROMO, title);

  const announcements = [
    "Tamil Dub | Demo Show Announcement",
    "Tamil Dub | Demo Show Coming Soon",
    "Tamil Dub | Demo Show Release Date Announced",
    "Tamil Dub | Demo Show Now Streaming"
  ];

  for (const title of announcements) assert.equal(parseTamilDubTitle(title).kind, KINDS.ANNOUNCEMENT, title);
});

test("parser: a trailer with an episode number is still a trailer; full episode plus promo wording is ambiguous", () => {
  assert.equal(parseTamilDubTitle("Tamil Dub | Demo Show Episode 1 Trailer").kind, KINDS.PROMO);

  const mixed = parseTamilDubTitle("Tamil Dub | Demo Show Full Episode 1 Trailer");
  assert.equal(mixed.kind, KINDS.AMBIGUOUS);
  assert.ok(mixed.reasons.includes("promo-and-full-episode"));
});

test("parser: no episode number means unknown, never an episode", () => {
  const parsed = parseTamilDubTitle("Tamil Dub | Demo Show");
  assert.equal(parsed.kind, KINDS.UNKNOWN);
  assert.ok(parsed.reasons.includes("no-episode-marker"));
});

test("parser: ambiguity is reported with a reason, not guessed", () => {
  const conflictingSeason = parseTamilDubTitle("Tamil Dub | Demo Show Season 1 Season 2 Episode 3");
  assert.ok(conflictingSeason.reasons.includes("conflicting-season"));
  assert.equal(conflictingSeason.season, null);

  const conflictingEpisode = parseTamilDubTitle("Tamil Dub | Demo Show Episode 3 Episode 4");
  assert.ok(conflictingEpisode.reasons.includes("conflicting-episode"));
  assert.equal(conflictingEpisode.episode, null);

  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show Episode 3-4").reasons.includes("episode-range"));
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show Episode 3 & 4").reasons.includes("episode-range"));
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show Episode 3.5").reasons.includes("episode-decimal"));
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show Part 2 Episode 3").reasons.includes("part-marker"));
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show Cour 2 Episode 3").reasons.includes("part-marker"));
});

test("parser: other languages, subtitles and movies are flagged, never accepted silently", () => {
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show Episode 3 Hindi").reasons.includes("mixed-language"));
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show Episode 3 English Subtitles").reasons.includes("subtitle"));
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show Episode 3 Eng Sub").reasons.includes("subtitle"));
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show The Movie").reasons.includes("movie"));
  assert.ok(parseTamilDubTitle("Tamil Dub | Demo Show OVA Episode 1").reasons.includes("movie"));
});

test("parser: channel boilerplate is never a series name", () => {
  const parsed = parseTamilDubTitle("Tamil Dub | Muse India | Official Trailer");
  assert.deepEqual(parsed.nameCandidates, []);

  const named = parseTamilDubTitle("Tamil Dub | Demo Show Episode 2 | Muse India");
  assert.deepEqual(named.nameCandidates, ["Demo Show"]);
});

test("parser: a year hint is read from brackets", () => {
  const parsed = parseTamilDubTitle("Tamil Dub | Demo Show (2019) Episode 2");
  assert.equal(parsed.yearHint, 2019);
  assert.equal(parsed.nameCandidates[0], "Demo Show");
});

test("parser: hostile titles are only ever data", () => {
  const title = "Tamil Dub | ${process.exit(1)} `rm -rf /` <script>alert(1)</script> Episode 2";
  const parsed = parseTamilDubTitle(title);
  assert.equal(parsed.matches, true);
  assert.equal(parsed.episode, 2);

  const long = `Tamil Dub | ${"A".repeat(5000)} Episode 2`;
  assert.doesNotThrow(() => parseTamilDubTitle(long));
});

test("reasonText gives readable text and passes unknown codes through", () => {
  assert.match(reasonText("episode-range"), /range/);
  assert.equal(reasonText("something-new"), "something-new");
});

test("real Muse India titles: bracket tag, Episode N (SxEy), and the Muse IN suffix", () => {
  const a = parseTamilDubTitle("[Tamil Dub] Campfire Cooking in Another World - Episode 20 (S2E08) | Muse IN");
  assert.equal(a.matches, true);
  assert.equal(a.season, 2);
  assert.equal(a.episode, 8);
  assert.equal(a.absoluteEpisode, 20);
  assert.ok(!a.reasons.includes("conflicting-episode"));
  assert.ok(a.nameCandidates.some((n) => /^campfire cooking in another world$/i.test(n)), JSON.stringify(a.nameCandidates));
  assert.ok(!a.nameCandidates.some((n) => /muse/i.test(n)));
  const b = parseTamilDubTitle("[Tamil Dub] Campfire Cooking in Another World - Episode 19 (S2E07) | Muse IN");
  assert.equal(b.season, 2);
  assert.equal(b.episode, 7);
});

test("a real contradiction still goes to review", () => {
  const c = parseTamilDubTitle("[Tamil Dub] Demo Show S2E08 Season 3 Episode 8");
  assert.ok(c.reasons.length > 0 || c.episode === null, JSON.stringify(c));
  const d = parseTamilDubTitle("Tamil Dub | Demo Show S2E08 S2E09");
  assert.ok(d.reasons.includes("conflicting-episode"), JSON.stringify(d));
});
