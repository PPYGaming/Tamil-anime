# Tamil Dub Anime - GitHub Pages

Static anime catalog on GitHub Pages, kept up to date by a GitHub Actions updater. The updater now **discovers new Tamil-dub anime on an allow-listed official YouTube channel on its own**; nobody has to add a manifest entry per title.

> **Status of this change: code for owner review. Nothing is deployed, committed, dispatched or verified live.** See [What is not done or not verified](#what-is-not-done-or-not-verified) before merging.

## Architecture

```
                         every 6 h (cron) / manual run / (optional) owner "Scan now"
                                          |
                                          v
 GitHub Actions: scripts/update-anime.js  (keys come from Actions secrets, never the browser)
    |-- official-source manifest  ->  validated, add-only merge          (Crunchyroll / Netflix / Prime proof, hand curated)
    |-- discovery (scripts/discovery/)                                    (YouTube, allow-listed channel only)
    |       YouTube Data API:  channels.list -> uploads playlist -> playlistItems.list (paged)
    |                          -> videos.list (snippet, contentDetails, status)
    |       keep only: channelId on the allow-list  AND  title STARTS WITH "Tamil Dub"
    |       classify: episode | trailer/clip | announcement | ambiguous -> review
    |       TMDB (metadata + series/season naming only, never Tamil proof)
    |       group by series + season -> the SAME validate/merge path as manifest entries
    v
 data/anime.json            catalog (+ updateInfo.lastScan: compact public report)
 data/discovery-state.json  resumable checkpoint (page cursors, high-water mark, review queue; no keys)
    |  commit + push by the workflow
    v
 GitHub Pages  ->  visitors (Refresh re-reads data/anime.json; it searches nothing)
```

The browser never receives an API key or a GitHub token.

### What "discovered" means here

A video is added only when **all** of these hold:

1. It was returned by `videos.list` and its `snippet.channelId` is on the allow-list (a title that merely says "Muse India" proves nothing). The allow-list is `officialYouTubeChannels` in `data/official-tamil-dub-manifest.json` (and/or `OFFICIAL_YOUTUBE_CHANNEL_IDS`). It currently holds **Muse India, `UCYYhAzgWuxPauRXdPpLAX3Q`** (owner-confirmed).
2. Its **title starts with "Tamil Dub"** (case-insensitive, leading spaces ignored). "Tamil Dub" later in the title, in the description, "Tamil Dubbed", "[Tamil Dub]", Tamil subtitles and other languages do not qualify.
3. It is a full episode with an explicit episode number. Trailers, teasers, clips and announcements never become a watch link (announcements are listed in the scan report only).
4. It is public, finished (not a live/upcoming premiere), not marked blocked in India, and not shorter than 10 minutes (shorter ones go to review as possible clips).
5. Its series is identified exactly: a name the catalog already knows, or the single exact-title Japanese-animation match on TMDB. A fuzzy TMDB match is **a review item, never an addition**.
6. Its season is explicit in the title ("Season 2", "S2E5", "2nd Season"), or TMDB says the series has exactly one regular season. A missing season is never assumed to be season 1.

Everything else is reported (with the reason) in `data/anime.json -> updateInfo.lastScan.discovery.review` and kept in the checkpoint queue, where it is re-assessed on every run until it resolves.

### What discovery never does

- It never removes or rewrites a record, an episode link or a verification. A video that is later deleted, made private, retitled or blocked in India is recorded on its `discoveryProvenance` row (`availability`) and nothing else changes.
- It never overwrites curated data. Merging is add-only: empty fields are filled, unknown episodes appended, evidence appended by URL. An existing episode link is never replaced.
- It never treats a failed or partial scan as a successful empty one. A quota stop, API error or exhausted page budget leaves the checkpoint where it was and says so.
- It never uses TMDB, a streaming-provider listing or a title match as proof of Tamil audio. The proof is the official video.
- It never lets a discovered entry block a manifest entry: a discovered episode of a season the manifest owns reuses the manifest's id.

### Season identity (unchanged)

Records are identified by series + season. A legacy record with no `tmdbSeason` is season 1 **in memory only** when a manifest entry with its exact id says so; the file is never stamped. Discovery uses the same rule, so it reuses `verified-spy-x-family-season-1` instead of creating a second season-1 record.

## Coverage, completeness and limits

- **Sources:** only allow-listed official YouTube channels. Crunchyroll, Netflix and Prime Video have no public catalog that states Tamil audio, so those titles still come from the hand-curated manifest.
- **Only `Tamil Dub`-prefixed titles.** If the channel uploads a Tamil dub under another title style, it is not discovered (by design, per the owner's rule). The scan report's `excludedNotTamilDub` count shows how many other videos were seen.
- **History is covered by a resumable bootstrap.** The first runs walk the whole uploads playlist, `DISCOVERY_BOOTSTRAP_PAGES` pages (50 videos each) per run, saving the cursor after every successful page. Every run also re-reads the newest pages back to `DISCOVERY_OVERLAP_HOURS` (72 h) before the last seen upload, to catch late additions. `lastScan.discovery.completeness` says whether the scan was complete (`complete`, `bootstrapComplete`, `hasMoreHistory`, `stopReason`).
- **Quota:** each `channels.list`, `playlistItems.list` and `videos.list` call costs 1 unit; every attempt counts, including retries. A full page costs 2 units (playlist page + videos). Each run is capped at `DISCOVERY_UNIT_BUDGET` (default 2,000) against the default project quota of 10,000 units/day (resets at midnight Pacific Time). `search.list` is not used.
- **Region:** "not blocked in India" is read from `contentDetails.regionRestriction`. No restriction metadata is not a playback guarantee.
- **Ambiguity** (episode ranges, "Part"/"Cour" markers, movies/OVAs, mixed languages, subtitles, absolute episode numbering, several seasons with no season in the title, unknown series) goes to review. There is no approval screen: resolve a review item by adding the series to the manifest or catalog, or by fixing the title on the channel. The queued video is re-assessed on every run against the catalog as it stands at the start of that run, so after you add the series it resolves on the run after the one that adds it.
- **Latency:** up to 6 hours from upload to catalog, plus GitHub Pages' own publish delay after the commit.

### Reading a zero-add result

When a scan adds nothing, `updateInfo.lastScan.zeroAddReason` ends with `Discovery: <reason>` and `lastScan.discovery.zeroAddReasonCode` is exactly one of:

| code | meaning |
| --- | --- |
| `all-known` | every discovered Tamil Dub episode already belongs to a catalog record |
| `no-tamil-evidence` | the scan **completed** and no video on the allow-listed channel starts with "Tamil Dub" |
| `no-episode-evidence` | only trailers/announcements/clips carry a "Tamil Dub" title |
| `needs-review` | Tamil Dub videos were found but none could be placed safely |
| `missing-youtube-key` | `YOUTUBE_API_KEY` is not set; only the manifest ran |
| `missing-channel-allowlist` | no official channel ID is configured; nothing unverified was scanned |
| `incomplete-scan` | page or unit budget reached before the end of history; resumes next run |
| `quota-exhausted` | YouTube reported the daily quota is used up; resumes next run |
| `auth-error` | the key was rejected (invalid, restricted, or the API is not enabled) |
| `api-error` | the API failed repeatedly; the scan is incomplete |

## Setup

1. Create a GitHub repository, upload the files, enable GitHub Pages.
2. Add repository secrets `TMDB_API_KEY` and `YOUTUBE_API_KEY` (YouTube Data API v3 enabled on the Google Cloud project). Optionally restrict the YouTube key to the YouTube Data API.
3. The workflow `.github/workflows/update-anime.yml` sets `DISCOVERY_ENABLED: 'true'`. Run it once from Actions, then it runs every 6 hours. The first runs fill the history; check `lastScan.discovery.completeness`.
4. To restart the history walk (recovery only), run the workflow manually with **full_rescan** ticked. Merges are idempotent, so a rescan never duplicates anything.

The workflow commits `data/anime.json` and `data/discovery-state.json` and nothing else. Runs are serialised by a `concurrency` group, so a manual run during a scheduled run waits instead of racing.

### Environment

See `.env.example`. Discovery tuning variables (all optional, shown with defaults there): `DISCOVERY_ENABLED` (off unless `true`), `DISCOVERY_BOOTSTRAP_PAGES`, `DISCOVERY_INCREMENTAL_PAGES`, `DISCOVERY_OVERLAP_HOURS`, `DISCOVERY_UNIT_BUDGET`, `DISCOVERY_MIN_EPISODE_SECONDS`, `DISCOVERY_RECHECK_LIMIT`, `DISCOVERY_FULL_RESCAN`, timeouts and retries. Unset or empty means "use the default"; out-of-range values also fall back to the default.

Keys are read from the environment only and redacted from every log line, report and state file.

## The Refresh button, and click-triggered scanning

**Refresh reloads `data/anime.json`. It does not search YouTube, TMDB or anything else, and it cannot change the repository.** A static page cannot start a search by itself; pretending a JSON reload does that would be wrong. The page now shows the result of the last completed scan under the status line, including why it added nothing.

A genuine "scan when someone clicks" needs something that can start the GitHub Actions workflow with a credential the browser must never hold. That is a small backend service. A reviewed, **undeployed** implementation is in [`backend/refresh-scan/`](backend/refresh-scan/README.md):

- owner-only (GitHub login on an explicit allow-list), no public dispatch endpoint, no token in HTML/JS/storage;
- joins a scan that is already queued instead of starting another; per-user and global rate limits;
- reports queued / running / completed / failed / timeout, and the page reloads the catalog **only after the run really completed and the published catalog contains its result**.

**This goal is not fulfilled by this change.** There is no host, no GitHub token, no OAuth app and no configured endpoint, and the frontend's endpoint (`<meta name="refresh-scan-endpoint" content="">`) is empty on purpose. Until the owner chooses a host and completes the setup in the backend README, new titles appear on the 6-hourly schedule (or a manual Actions run), not on click.

## Tests

```
npm test            # node --test : unit + mocked-API tests, no network, no keys
```

Every YouTube, TMDB and GitHub call in the tests is a local mock with visibly fake keys (`TEST-...`). **No live API call has been made.** Details and counts are in `test-output.txt`.

## What is not done or not verified

- Nothing was run against the real YouTube, TMDB or GitHub APIs. The channel ID is the owner's; it has not been checked against the live API here.
- It is unknown how many of the channel's Tamil dubs use the `Tamil Dub` title prefix; the first real scan's `excludedNotTamilDub` and review counts will show it.
- Whether GitHub Pages rebuilds after a push made with the workflow's default token is the existing behaviour of this repository's workflow; it was not changed or re-tested.
- The Refresh backend is code and mocked tests only (see above). The click-triggered scan is **not** working.
- The workflow files were not executed; the new `tests.yml` has never run on GitHub.
- The live `data/anime.json` has 26 records; the 25-record fixture used for the regression tests is the earlier state you supplied.

## Important accuracy rule

Streaming-provider availability does not prove that Tamil audio is available. `tamilDubVerified` is separate and is only set from a reliable verification source: an official manifest proof, or an official allow-listed channel video whose title starts with "Tamil Dub".

Do not use private APIs, DRM bypasses, authentication bypasses, pirated links, or unauthorized streaming sources.
