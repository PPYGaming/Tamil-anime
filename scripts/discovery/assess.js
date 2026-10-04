"use strict";

/*
 * Decides what a single, already channel-verified video is, from its own metadata and title. Pure and synchronous.
 *
 * Outcomes
 *   excluded      title does not start with "Tamil Dub" (counted, nothing else)
 *   unavailable   not public / still processing: no evidence, no link (retried while recent)
 *   deferred      live or upcoming premiere: not watchable yet, retried
 *   region-blocked  the returned restriction metadata says it is not watchable in the configured region
 *   announcement  an announcement of a dub: reported as evidence of an announcement only, never an episode link
 *   promo         trailer, teaser, clip, review...: reported, never an episode link
 *   review        cannot be decided safely: reported and kept in the queue
 *   candidate     an episode with an explicit episode number, ready for series resolution
 */

const { parseTamilDubTitle, reasonText, KINDS } = require("./title");
const { playableIn } = require("./youtube");

const TAMIL_LANGUAGE = /^ta(?:$|-)/i;

function assessVideo(video, { region = "IN", minEpisodeSeconds = 600 } = {}) {
  const parsed = parseTamilDubTitle(video.title);

  if (!parsed.matches) return { outcome: "excluded", parsed };

  if (video.privacyStatus && video.privacyStatus !== "public") {
    return { outcome: "unavailable", parsed, reason: `video privacy is "${video.privacyStatus}", not public` };
  }

  if (video.uploadStatus && video.uploadStatus !== "processed") {
    return { outcome: "deferred", parsed, reason: `video upload status is "${video.uploadStatus}"` };
  }

  if (video.liveBroadcastContent && video.liveBroadcastContent !== "none") {
    return { outcome: "deferred", parsed, reason: `video is "${video.liveBroadcastContent}" (live or upcoming premiere), not a finished upload` };
  }

  if (!playableIn(video, region)) {
    return { outcome: "region-blocked", parsed, reason: `restriction metadata says the video is not watchable in ${region}` };
  }

  if (parsed.kind === KINDS.ANNOUNCEMENT) return { outcome: "announcement", parsed, reason: "announcement of a Tamil dub, not an episode" };
  if (parsed.kind === KINDS.PROMO) return { outcome: "promo", parsed, reason: "trailer, teaser, clip or similar, not a full episode" };

  const problems = parsed.reasons.map(reasonText);

  if (video.defaultAudioLanguage && !TAMIL_LANGUAGE.test(video.defaultAudioLanguage)) {
    problems.push(`video metadata lists its audio language as "${video.defaultAudioLanguage}"`);
  }

  if (parsed.kind !== KINDS.EPISODE || problems.length) {
    return {
      outcome: "review",
      parsed,
      reason: problems.length ? problems.join("; ") : "cannot tell what kind of video this is"
    };
  }

  if (video.durationSeconds === null || video.durationSeconds === undefined) {
    return { outcome: "review", parsed, reason: "video duration is unknown, so a full episode cannot be told from a clip" };
  }

  if (minEpisodeSeconds > 0 && video.durationSeconds < minEpisodeSeconds) {
    return {
      outcome: "review",
      parsed,
      reason: `video is ${Math.round(video.durationSeconds / 60)} min, shorter than the ${Math.round(minEpisodeSeconds / 60)}-min full-episode threshold; it may be a clip`
    };
  }

  return { outcome: "candidate", parsed };
}

module.exports = { assessVideo };
