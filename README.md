# Tamil Dub Anime - GitHub Pages

Static anime catalog with a Refresh button and a GitHub Actions updater.

## Architecture

Visitor -> GitHub Pages -> `data/anime.json`

Automatic updater:

GitHub Actions -> TMDB/YouTube -> `data/anime.json` -> commit -> GitHub Pages

The browser never receives API keys.

## Setup

1. Create a GitHub repository.
2. Upload all project files.
3. Enable GitHub Pages from the repository settings.
4. Add repository Secrets:
   - `TMDB_API_KEY`
   - `YOUTUBE_API_KEY`
5. Run the workflow manually once from Actions.
6. The workflow then runs every 6 hours.

## Refresh

The Refresh button requests:

`data/anime.json?t=<timestamp>`

It does not call TMDB or YouTube directly and cannot modify the repository. GitHub Actions is responsible for generating the updated JSON.

## Environment

```env
TMDB_API_KEY=
YOUTUBE_API_KEY=
CONTENT_REGION=IN
UPDATE_CRON=0 */6 * * *
UPDATE_ON_START=true
YOUTUBE_MAX_RESULTS=10
```

For GitHub Pages, put secrets in GitHub repository Secrets rather than committing `.env`.

## Important accuracy rule

Streaming-provider availability does not prove that Tamil audio is available. Keep `tamilDubVerified` separate and only set it when there is a reliable verification source.

Do not use private APIs, DRM bypasses, authentication bypasses, pirated links, or unauthorized streaming sources.
