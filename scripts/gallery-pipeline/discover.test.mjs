import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { discoverFeeds } from "./discover/feeds.mjs";
import { discoverGitHub } from "./discover/github.mjs";
import { discoverLearn } from "./discover/learn.mjs";
import { discoverYouTube, isYouTubeDiscoveryEnabled } from "./discover/youtube.mjs";

async function loadFixture(name) {
  return JSON.parse(
    await readFile(new URL(`./fixtures/discovery/${name}.json`, import.meta.url), "utf8"),
  );
}

test("GitHub fixture accepts strong SDK, infrastructure, and code signals", async () => {
  const candidates = discoverGitHub({ fixture: await loadFixture("github"), offline: true });
  assert.equal(candidates.length, 4);
  assert.deepEqual(
    candidates.flatMap((candidate) => candidate.metadata.strongSignalKinds).sort(),
    ["code", "infrastructure", "sdk"],
  );
  assert.equal(candidates.some((candidate) => candidate.sourceId === "1005"), false);
  assert.deepEqual(
    candidates.find((candidate) => candidate.sourceId === "1004").metadata.strongSignalKinds,
    [],
  );
});

test("Learn fixture emits only canonical documents under the configured root", async () => {
  const [candidate] = discoverLearn({ fixture: await loadFixture("learn"), offline: true });
  assert.equal(candidate.canonicalUrl, "https://learn.microsoft.com/azure/cosmos-db/nosql/vector-search");
  assert.equal(candidate.identityKey, "learn-document:cosmos-db-nosql-vector-search");
});

test("feed fixture accepts already parsed entries with stable GUIDs", async () => {
  const candidates = discoverFeeds({ fixture: await loadFixture("feeds"), offline: true });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceType, "blog-post");
  assert.equal(candidates[0].metadata.feedEntryId, "https://devblogs.microsoft.com/cosmosdb/?p=12345");
  assert.equal(candidates[0].canonicalUrl.includes("utm_"), false);
});

test("YouTube fixture requires configured source IDs and immutable video IDs", async () => {
  const fixture = await loadFixture("youtube");
  assert.equal(isYouTubeDiscoveryEnabled(fixture.source), true);
  const candidates = discoverYouTube({ fixture, offline: true });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].identityKey, "video:6IIUtEFKJec");
  assert.equal(candidates[0].canonicalUrl, "https://www.youtube.com/watch?v=6IIUtEFKJec");

  assert.equal(
    discoverYouTube({ fixture: { ...fixture, source: { enabled: true } }, offline: true }).length,
    0,
  );
});

test("all adapters remain offline and emit the common candidate schema", async () => {
  const batches = [
    discoverGitHub({ fixture: await loadFixture("github"), offline: true }),
    discoverLearn({ fixture: await loadFixture("learn"), offline: true }),
    discoverFeeds({ fixture: await loadFixture("feeds"), offline: true }),
    discoverYouTube({ fixture: await loadFixture("youtube"), offline: true }),
  ];

  for (const candidate of batches.flat()) {
    assert.equal(candidate.schemaVersion, "1.0.0");
    assert.match(candidate.identityKey, /^[a-z-]+:.+/);
    assert.match(candidate.canonicalUrl, /^https:\/\//);
    assert.equal(candidate.discoveredAt, "2026-08-27T12:00:00.000Z");
    assert.ok(Array.isArray(candidate.evidence));
  }
  assert.deepEqual(discoverGitHub({ offline: true }), []);
  assert.deepEqual(discoverLearn({ offline: true }), []);
  assert.deepEqual(discoverFeeds({ offline: true }), []);
  assert.deepEqual(discoverYouTube({ offline: true }), []);
});