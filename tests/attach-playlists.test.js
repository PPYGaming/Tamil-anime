"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { seriesName, acceptPlaylist, matches, attach, fetchChannelPlaylists } = require("../scripts/attach-playlists");

const CH = "UCYYhAzgWuxPauRXdPpLAX3Q";

test("series name comes only from a Tamil Dub playlist title", () => {
  assert.equal(seriesName("[Tamil Dub] Mob Psycho 100 | Muse IN"), "Mob Psycho 100");
  assert.equal(seriesName("[Tamil Dub] Campfire Cooking in Another World"), "Campfire Cooking in Another World");
  assert.equal(seriesName("Complete Series [EN Sub] | Muse IN"), null);
  assert.equal(seriesName("[Hindi Dub] Mob Psycho 100 | Muse IN"), null);
  assert.equal(seriesName("Mob Psycho 100 [Tamil Dub]"), null);
});

test("only official-channel playlists with a valid id are accepted", () => {
  const good = { id: "PLNTwZt1fyw5E", title: "[Tamil Dub] Skeleton Knight in Another World | Muse IN", channelId: CH };
  assert.ok(acceptPlaylist(good));
  assert.equal(acceptPlaylist({ ...good, channelId: "UCsomeoneelse" }), null);
  assert.equal(acceptPlaylist({ ...good, id: "bad id" }), null);
  assert.equal(acceptPlaylist({ ...good, title: "Skeleton Knight in Another World" }), null);
});

test("a playlist attaches to every season of its series and to nothing else", () => {
  assert.ok(matches("Classroom of the Elite Season 2", "Classroom of the Elite"));
  assert.ok(matches("Classroom of the Elite", "Classroom of the Elite"));
  assert.equal(matches("Classroom of the Elite Plus", "Classroom of the Elite Plus Two"), false);
  assert.equal(matches("Attack on Titanic", "Attack on Titan"), false);
  const anime = [{ title: "Mob Psycho 100 Season 2" }, { title: "Other Show" }];
  const list = [acceptPlaylist({ id: "PLF4OL6MRpW_U", title: "[Tamil Dub] Mob Psycho 100 | Muse IN", channelId: CH })];
  assert.equal(attach(anime, list), 1);
  assert.equal(anime[0].youtubePlaylists[0].url, "https://www.youtube.com/playlist?list=PLF4OL6MRpW_U");
  assert.equal(anime[1].youtubePlaylists, undefined);
  assert.equal(attach(anime, list), 0);
});

test("channel playlists are paged and read through the API", async () => {
  const pages = [
    { items: [{ id: "PLaaaaaaaa", snippet: { title: "[Tamil Dub] A Show | Muse IN", channelId: CH } }], nextPageToken: "n" },
    { items: [{ id: "PLbbbbbbbb", snippet: { title: "Promotion Video", channelId: CH } }] }
  ];
  let i = 0;
  const fake = async () => ({ ok: true, json: async () => pages[i++] });
  const out = await fetchChannelPlaylists("key", CH, fake);
  assert.equal(out.length, 2);
  assert.equal(out.filter((p) => acceptPlaylist(p)).length, 1);
});
