"use strict";

/*
 * Strict "Tamil Dub" title filter and conservative title parser.
 *
 * OWNER RULE: a video is only processed when its title STARTS with "Tamil Dub" (leading whitespace ignored,
 * case-insensitive, followed by a word boundary). One opening bracket directly before it is allowed, because real
 * Muse India titles are written "[Tamil Dub] ...". "Tamil Dub" later in the title, a description that mentions
 * Tamil, Tamil subtitles, other languages, or abbreviations never qualify. Nothing here is ever "fuzzy".
 *
 * Titles are external text: they are only ever matched against fixed patterns and copied as data. They are never
 * evaluated, interpolated into commands, or used to build URLs.
 */

// Leading whitespace plus zero-width characters (ZWSP/ZWNJ/ZWJ/word joiner/BOM), which YouTube allows in titles.
const LEADING_NOISE = /^[\s​-‍⁠﻿]+/u;

// "Tamil", whitespace, "Dub", then NOT a letter/digit/underscore: "Tamil Dubbed", "Tamil Dubstep" do not match.
// An opening bracket directly before it is allowed: Muse India titles read "[Tamil Dub] Name - Episode 20 (S2E08) | Muse IN".
const PREFIX = /^(?:[[(【]\s*)?(tamil\s+dub)(?![\p{L}\p{N}_])/iu;

const KINDS = Object.freeze({
  EPISODE: "episode",
  PROMO: "promo", // trailer, teaser, clip, preview, review...: never an episode link
  ANNOUNCEMENT: "announcement", // dub announced / release date: evidence of an announcement only
  UNKNOWN: "unknown",
  AMBIGUOUS: "ambiguous"
});

const OTHER_LANGUAGES = [
  "hindi", "telugu", "malayalam", "kannada", "bengali", "bangla", "marathi", "punjabi", "gujarati", "urdu",
  "english", "japanese", "korean", "chinese", "mandarin", "spanish", "french", "portuguese", "indonesian",
  "thai", "arabic", "russian", "german", "italian", "turkish", "vietnamese"
];
const LANGUAGE_RE = new RegExp(`\\b(?:${OTHER_LANGUAGES.join("|")})\\b`, "iu");

const SUBTITLE_RE = /\b(?:subs?|subbed|subtitles?|esubs?|eng\s*subs?|hardsub|softsub|cc)\b/iu;

const ANNOUNCEMENT_RE = new RegExp(
  "\\b(?:announce(?:ment|d|s)?|announcing|coming\\s+soon|release\\s+date|premiere\\s+date|launch(?:ing|ed)?|" +
    "now\\s+streaming|streaming\\s+soon|starts?\\s+(?:on|from)|date\\s+reveal)\\b",
  "iu"
);

const PROMO_RE = new RegExp(
  "\\b(?:trailers?|teasers?|promos?|pv|previews?|first\\s+look|sneak\\s+peek|openings?|endings?|creditless|" +
    "clips?|scenes?|highlights?|recaps?|reviews?|reactions?|breakdown|explained|behind\\s+the\\s+scenes|making\\s+of|" +
    "interviews?|cast|voice\\s+cast|song|music\\s+video|amv|shorts?|memes?|status|best\\s+moments?|top\\s+moments?|" +
    "fight\\s+scene|theme)\\b",
  "iu"
);

const MOVIE_RE = /\b(?:movie|film|ova|oad|special|specials)\b/iu;

const FULL_EPISODE_RE = /\bfull\s+episode\b/iu;

const NUMBER_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function stripLeadingNoise(title) {
  return String(title === undefined || title === null ? "" : title).replace(LEADING_NOISE, "");
}

/* Returns { matches, remainder }. remainder is the text after the prefix with leading separators removed. */
function matchTamilDubPrefix(title) {
  const text = stripLeadingNoise(title);
  const match = PREFIX.exec(text);

  if (!match) return { matches: false, remainder: "" };

  return {
    matches: true,
    matchedText: match[1],
    remainder: text.slice(match[0].length).replace(/^[\s|:\-–—•·,.!\])】]+/u, "").trim()
  };
}

const startsWithTamilDub = (title) => matchTamilDubPrefix(title).matches;

/* ------------------------------------------------------------------ */
/* Season / episode extraction                                         */
/* ------------------------------------------------------------------ */

const SEASON_EPISODE_COMBO = /\bS(\d{1,2})\s*[-_. ]?\s*E(?:P)?\s*(\d{1,4})\b/giu;
const EPISODE_WORD = /\b(?:episodes?|eps?)\.?\s*#?\s*(\d{1,4})(?![\d.])/giu;
const EPISODE_RANGE = /\b(?:episodes?|eps?)\.?\s*#?\s*\d{1,4}\s*(?:-|–|—|&|,|\+|and|to)\s*\d{1,4}\b/iu;
const EPISODE_DECIMAL = /\b(?:episodes?|eps?)\.?\s*#?\s*\d{1,4}\.\d/iu;
const SEASON_WORD = /\bseason\s*#?\s*(\d{1,2})\b/giu;
const SEASON_SHORT = /\bS(\d{1,2})\b(?!\s*[-_. ]?\s*E)/gu; // case-sensitive "S2": avoids "s" in ordinary words
const SEASON_ORDINAL_DIGIT = /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/giu;
const SEASON_ORDINAL_WORD = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b/giu;
const PART_MARKER = /\b(?:part|cour|pt\.?)\s*#?\s*\d{1,2}\b/giu;
const YEAR_HINT = /[([]\s*((?:19|20)\d{2})\s*[)\]]/u;

function collect(text, regex, pick) {
  const found = [];
  regex.lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    found.push({ value: pick(match), index: match.index, length: match[0].length });
    if (match[0].length === 0) regex.lastIndex++;
  }

  return found;
}

function extractNumbers(remainder) {
  const reasons = [];
  const spans = [];

  const combos = collect(remainder, SEASON_EPISODE_COMBO, (m) => ({ season: Number(m[1]), episode: Number(m[2]) }));
  const episodeWords = collect(remainder, EPISODE_WORD, (m) => Number(m[1]));
  const seasons = [
    ...collect(remainder, SEASON_WORD, (m) => Number(m[1])),
    ...collect(remainder, SEASON_SHORT, (m) => Number(m[1])),
    ...collect(remainder, SEASON_ORDINAL_DIGIT, (m) => Number(m[1])),
    ...collect(remainder, SEASON_ORDINAL_WORD, (m) => NUMBER_WORDS[m[1].toLowerCase()])
  ];

  for (const item of [...combos, ...episodeWords, ...seasons]) spans.push([item.index, item.index + item.length]);

  const seasonValues = [...new Set([...seasons.map((item) => item.value), ...combos.map((item) => item.value.season)])];
  const episodeValues = [...new Set([...episodeWords.map((item) => item.value), ...combos.map((item) => item.value.episode)])];

  let season = null;
  let episode = null;

  if (seasonValues.length > 1) reasons.push("conflicting-season");
  else if (seasonValues.length === 1) season = seasonValues[0];

  let absoluteEpisode = null;
  const comboKeys = [...new Set(combos.map((item) => `${item.value.season}-${item.value.episode}`))];
  const wordValues = [...new Set(episodeWords.map((item) => item.value))];

  // "Episode 20 (S2E08)": a running episode number plus a season-episode code is consistent when the running number
  // is not smaller than the in-season number and, in season 1, equal to it. Two different codes, or two different
  // plain numbers, are still a conflict.
  if (comboKeys.length === 1 && wordValues.length === 1 && wordValues[0] !== combos[0].value.episode) {
    const code = combos[0].value;

    if (wordValues[0] > code.episode && code.season > 1) {
      episode = code.episode;
      absoluteEpisode = wordValues[0];
    } else reasons.push("conflicting-episode");
  } else if (episodeValues.length > 1) reasons.push("conflicting-episode");
  else if (episodeValues.length === 1) episode = episodeValues[0];

  if (EPISODE_RANGE.test(remainder)) reasons.push("episode-range");
  if (EPISODE_DECIMAL.test(remainder)) reasons.push("episode-decimal");
  if (season !== null && (season < 1 || season > 99)) reasons.push("season-out-of-range");
  if (episode !== null && episode < 1) reasons.push("episode-out-of-range");

  const parts = collect(remainder, PART_MARKER, () => true);
  if (parts.length) reasons.push("part-marker"); // "Part 2" is not necessarily a TMDB season

  for (const item of parts) spans.push([item.index, item.index + item.length]);

  return { season, episode, absoluteEpisode, reasons, spans };
}

function blankSpans(text, spans) {
  const chars = [...text];
  for (const [start, end] of spans) for (let i = start; i < end && i < chars.length; i++) chars[i] = " ";
  return chars.join("");
}

/* ------------------------------------------------------------------ */
/* Series-name candidates                                              */
/* ------------------------------------------------------------------ */

const TRAILING_NOISE = [
  /\s*[([]\s*(?:official|hd|fhd|4k|full\s+episode|new|latest)\s*[)\]]\s*$/iu,
  /\s+(?:full(?:\s+episode)?|official|in\s+tamil|tamil|muse\s+india|muse\s+in|hd|fhd|4k|1080p|720p)\s*$/iu,
  /\s*[-–—|:•·,]+\s*$/u
];
const LEADING_NOISE_WORDS = [/^\s*(?:official|full\s+episode|new|latest)\s+/iu, /^\s*[-–—|:•·,]+\s*/u];

// A whole segment that is only channel/boilerplate words is never a series name.
const SEGMENT_NOISE = /^(?:muse\s+(?:india|in)|official|tamil|dub|dubbed|anime|in\s+tamil|full\s+episode|hd|new|latest|trailers?|teasers?|promos?|previews?|announcement)$/iu;

function cleanCandidate(segment) {
  let text = segment.replace(/\s+/g, " ").trim();
  let previous;

  do {
    previous = text;
    for (const pattern of TRAILING_NOISE) text = text.replace(pattern, "").trim();
    for (const pattern of LEADING_NOISE_WORDS) text = text.replace(pattern, "").trim();
  } while (text !== previous);

  return text;
}

function nameCandidates(remainder, spans) {
  const blanked = blankSpans(remainder, spans).replace(YEAR_HINT, " ");

  const segments = blanked
    .split(/\s*[|•·]\s*|\s+[-–—]\s+/u)
    .map(cleanCandidate)
    .filter((segment) => /[\p{L}\p{N}]/u.test(segment) && segment.length >= 2 && segment.length <= 120)
    .filter((segment) => !SEGMENT_NOISE.test(segment)); // channel name, "Official", a bare "Trailer"...

  const seen = new Set();
  const unique = [];

  for (const segment of segments) {
    const key = segment.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(segment);
    }
  }

  return unique.slice(0, 4);
}

/* ------------------------------------------------------------------ */
/* Public parser                                                       */
/* ------------------------------------------------------------------ */

const REASON_TEXT = {
  "conflicting-season": "title names more than one season",
  "conflicting-episode": "title names more than one episode number",
  "episode-range": "title names an episode range, not one episode",
  "episode-decimal": "title has a fractional episode number",
  "season-out-of-range": "season number is out of range",
  "episode-out-of-range": "episode number is out of range",
  "part-marker": 'title has a "Part"/"Cour" marker, which is not a reliable TMDB season',
  "mixed-language": "title also names another language",
  subtitle: "title mentions subtitles",
  movie: "title looks like a movie, OVA or special (not auto-added)",
  "no-episode-marker": "title has no explicit episode number",
  "no-series-name": "no series name could be read from the title",
  "promo-and-full-episode": 'title mixes "full episode" with trailer/promo wording'
};

const reasonText = (code) => REASON_TEXT[code] || code;

/*
 * parseTamilDubTitle(title) -> {
 *   matches,                       // prefix rule
 *   kind,                          // episode | promo | announcement | unknown | ambiguous (only when matches)
 *   season, episode,               // explicit numbers or null; a missing season is NEVER defaulted to 1
 *   nameCandidates: string[],      // possible series names, in title order
 *   yearHint, reasons: string[],   // reason codes that stop automatic acceptance
 *   languageProof                  // the matched prefix text, kept as provenance
 * }
 */
function parseTamilDubTitle(title) {
  const prefix = matchTamilDubPrefix(title);

  if (!prefix.matches) return { matches: false, kind: null, season: null, episode: null, absoluteEpisode: null, nameCandidates: [], yearHint: null, reasons: [], languageProof: null };

  const { remainder } = prefix;
  const numbers = extractNumbers(remainder);
  const reasons = [...numbers.reasons];

  const promo = PROMO_RE.test(remainder);
  const announcement = ANNOUNCEMENT_RE.test(remainder);
  const fullEpisode = FULL_EPISODE_RE.test(remainder);

  if (LANGUAGE_RE.test(remainder)) reasons.push("mixed-language");
  if (SUBTITLE_RE.test(remainder)) reasons.push("subtitle");
  if (MOVIE_RE.test(remainder)) reasons.push("movie");

  let kind;

  if (announcement && !fullEpisode) kind = KINDS.ANNOUNCEMENT;
  else if (promo && !fullEpisode) kind = KINDS.PROMO;
  else if ((promo || announcement) && fullEpisode) {
    kind = KINDS.AMBIGUOUS;
    reasons.push("promo-and-full-episode");
  } else if (numbers.episode !== null) kind = KINDS.EPISODE;
  else {
    kind = KINDS.UNKNOWN;
    reasons.push("no-episode-marker");
  }

  const candidates = nameCandidates(remainder, numbers.spans);
  if (!candidates.length && kind === KINDS.EPISODE) reasons.push("no-series-name");

  const yearMatch = YEAR_HINT.exec(remainder);

  return {
    matches: true,
    kind,
    season: numbers.season,
    episode: numbers.episode,
    absoluteEpisode: numbers.absoluteEpisode,
    nameCandidates: candidates,
    yearHint: yearMatch ? Number(yearMatch[1]) : null,
    reasons: [...new Set(reasons)],
    languageProof: prefix.matchedText.trim()
  };
}

module.exports = { KINDS, matchTamilDubPrefix, startsWithTamilDub, parseTamilDubTitle, reasonText };
