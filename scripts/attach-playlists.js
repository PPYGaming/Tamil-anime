"use strict";

/*
 * Attaches the official Muse India Tamil-dub YouTube playlists to catalog records.
 *
 * A playlist counts only when (1) it belongs to an allow-listed official channel and (2) its title starts with
 * "Tamil Dub" (a leading bracket is allowed, as in "[Tamil Dub] Series | Muse IN"). It is attached to a record
 * only when the playlist's series name equals the record title or the record title starts with that name
 * followed by a word boundary (so "Series Season 2" gets the "Series" playlist). Nothing is guessed.
 *
 * Sources: data/youtube-playlists.json (checked-in list, kept up to date by this script) and, when
 * YOUTUBE_API_KEY is set, the channel's public playlists from the YouTube Data API (1 quota unit per page).
 */

const fs = require("fs");
const path = require("path");
const { matchTamilDubPrefix } = require("./discovery/title");

const OFFICIAL_CHANNELS = ["UCYYhAzgWuxPauRXdPpLAX3Q"];
const PLAYLIST_ID = /^PL[A-Za-z0-9_-]{6,}$/;
const NOISE = /\s*\|?\s*muse\s+(?:india|in)\s*$/i;

const norm = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function seriesName(playlistTitle) {
  const prefix = matchTamilDubPrefix(playlistTitle);
  if (!prefix || !prefix.matches) return null;
  const name = prefix.remainder.replace(NOISE, "").trim();
  return norm(name).length >= 4 ? name : null;
}

function acceptPlaylist(item) {
  if (!item || !PLAYLIST_ID.test(String(item.id || ""))) return null;
  if (!OFFICIAL_CHANNELS.includes(item.channelId)) return null;
  const name = seriesName(item.title);
  return name ? { id: item.id, title: String(item.title), channelId: item.channelId, series: name } : null;
}

function matches(recordTitle, series) {
  const a = norm(recordTitle);
  const b = norm(series);
  return Boolean(b) && (a === b || a.startsWith(`${b} `));
}

function attach(anime, playlists) {
  let changed = 0;
  for (const record of anime) {
    const found = playlists
      .filter((p) => matches(record.title, p.series))
      .map((p) => ({ title: p.title, url: `https://www.youtube.com/playlist?list=${p.id}` }));
    const before = JSON.stringify(record.youtubePlaylists || []);
    if (found.length) record.youtubePlaylists = found;
    else delete record.youtubePlaylists;
    if (JSON.stringify(record.youtubePlaylists || []) !== before) changed += 1;
  }
  return changed;
}

async function fetchChannelPlaylists(key, channelId, fetchImpl = fetch) {
  const out = [];
  let token = "";
  for (let page = 0; page < 20; page += 1) {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("channelId", channelId);
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", key);
    if (token) url.searchParams.set("pageToken", token);
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`playlists.list failed: HTTP ${response.status}`);
    const body = await response.json();
    for (const item of body.items || []) {
      out.push({ id: item.id, title: item.snippet && item.snippet.title, channelId: item.snippet && item.snippet.channelId });
    }
    token = body.nextPageToken || "";
    if (!token) break;
  }
  return out;
}

async function main(env = process.env, root = path.join(__dirname, "..")) {
  const catalogPath = path.join(root, "data", "anime.json");
  const listPath = path.join(root, "data", "youtube-playlists.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const saved = fs.existsSync(listPath) ? JSON.parse(fs.readFileSync(listPath, "utf8")) : { playlists: [] };
  const known = new Map((saved.playlists || []).map((p) => [p.id, p]));

  if (env.YOUTUBE_API_KEY) {
    try {
      for (const channelId of OFFICIAL_CHANNELS) {
        for (const item of await fetchChannelPlaylists(env.YOUTUBE_API_KEY, channelId)) {
          const ok = acceptPlaylist(item);
          if (ok) known.set(ok.id, { id: ok.id, title: ok.title, channelId: ok.channelId });
        }
      }
    } catch (error) {
      console.log(`Playlist discovery skipped: ${error.message}`);
    }
  } else console.log("Playlist discovery skipped: no YOUTUBE_API_KEY (using the saved list).");

  const playlists = [...known.values()].map(acceptPlaylist).filter(Boolean);
  const list = { updatedFrom: "Muse India public playlists", playlists: playlists.map(({ id, title, channelId }) => ({ id, title, channelId })) };
  const listText = `${JSON.stringify(list, null, 2)}\n`;
  if (!fs.existsSync(listPath) || fs.readFileSync(listPath, "utf8") !== listText) fs.writeFileSync(listPath, listText);

  const changed = attach(catalog.anime, playlists);
  if (changed) fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Playlists: ${playlists.length} known, ${changed} catalog records updated.`);
  return { playlists: playlists.length, changed };
}

if (require.main === module) main().catch((error) => { console.log(`Playlist step failed: ${error.message}`); });

module.exports = { seriesName, acceptPlaylist, matches, attach, fetchChannelPlaylists, main };
