import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { discoverFeeds } from "./discover/feeds.mjs";
import { discoverGitHub } from "./discover/github.mjs";
import { discoverLearn } from "./discover/learn.mjs";
import { discoverYouTube, isYouTubeDiscoveryEnabled } from "./discover/youtube.mjs";
import {
  CATALOG_PREVIEW_PLACEHOLDER,
  generateCandidateGalleryId,
} from "./enrich-candidate.mjs";

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
  const enriched = candidates.find((candidate) => candidate.sourceId === "1001");
  assert.equal(enriched.metadata.galleryId, generateCandidateGalleryId(enriched));
  assert.deepEqual(enriched.metadata.tags, ["example", "microsoft"]);
  assert.deepEqual(
    {
      launchUrl: enriched.metadata.launchUrl,
      website: enriched.metadata.website,
      author: enriched.metadata.author,
      sourceOwner: enriched.metadata.sourceOwner,
      publishedAt: enriched.metadata.publishedAt,
      preview: enriched.metadata.preview,
    },
    {
      launchUrl: "https://github.com/Azure-Samples/cosmos-javascript-sample",
      website: "https://github.com/Azure-Samples",
      author: "Azure-Samples",
      sourceOwner: "Azure-Samples",
      publishedAt: "2025-04-10T08:30:00.000Z",
      preview: "https://avatars.githubusercontent.com/u/1844662?v=4",
    },
  );
});

test("Learn fixture emits only canonical documents under the configured root", async () => {
  const [candidate] = discoverLearn({ fixture: await loadFixture("learn"), offline: true });
  assert.equal(candidate.canonicalUrl, "https://learn.microsoft.com/azure/cosmos-db/nosql/vector-search");
  assert.equal(candidate.identityKey, "learn-document:cosmos-db-nosql-vector-search");
  assert.equal(candidate.metadata.galleryId, generateCandidateGalleryId(candidate));
  assert.deepEqual(candidate.metadata.tags, ["documentation", "microsoft"]);
  assert.deepEqual(
    {
      launchUrl: candidate.metadata.launchUrl,
      website: candidate.metadata.website,
      author: candidate.metadata.author,
      sourceOwner: candidate.metadata.sourceOwner,
      publishedAt: candidate.metadata.publishedAt,
      preview: candidate.metadata.preview,
    },
    {
      launchUrl: "https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/vector-search/?utm_source=fixture",
      website: "https://learn.microsoft.com/azure/cosmos-db",
      author: "Microsoft Learn",
      sourceOwner: "Microsoft Learn",
      publishedAt: "2026-08-01T07:00:00.000Z",
      preview: "https://learn.microsoft.com/media/azure-cosmos-db/vector-search.png",
    },
  );
});

test("GitHub and Learn metadata requires source-specific URL and timestamp provenance", async () => {
  const githubFixture = await loadFixture("github");
  const repository = {
    ...githubFixture.repositories[0],
    html_url: "https://GitHub.com/Azure-Samples/Cosmos-JavaScript-Sample?tab=readme#Usage",
    homepage: "https://Docs.Example/Product?view=Full#Overview",
    owner: {
      ...githubFixture.repositories[0].owner,
      html_url: "https://github.com/not-the-owner",
      avatar_url: "https://127.0.0.1/avatar.png",
    },
    image_url: "https://attacker.example/forged-preview.png",
  };
  const [githubCandidate] = discoverGitHub({
    fixture: { ...githubFixture, repositories: [repository] },
    offline: true,
  });

  assert.equal(
    githubCandidate.metadata.launchUrl,
    "https://GitHub.com/Azure-Samples/Cosmos-JavaScript-Sample?tab=readme#Usage",
  );
  assert.equal(
    githubCandidate.canonicalUrl,
    "https://github.com/azure-samples/cosmos-javascript-sample?tab=readme",
  );
  assert.equal(githubCandidate.metadata.website, "https://docs.example/Product?view=Full");
  assert.equal(githubCandidate.metadata.preview, CATALOG_PREVIEW_PLACEHOLDER);

  const learnFixture = await loadFixture("learn");
  const document = {
    ...learnFixture.documents[0],
    canonicalUrl: "https://Learn.Microsoft.com/en-us/Azure/Cosmos-DB/NoSQL/Vector-Search?view=Full#Examples",
    publishedAt: null,
    imageUrl: "https://preview.attacker.example/vector-search.png",
  };
  const [learnCandidate] = discoverLearn({
    fixture: { ...learnFixture, documents: [document] },
    offline: true,
  });

  assert.equal(learnCandidate.metadata.launchUrl, document.canonicalUrl);
  assert.equal(
    learnCandidate.canonicalUrl,
    "https://learn.microsoft.com/Azure/Cosmos-DB/NoSQL/Vector-Search?view=Full",
  );
  assert.equal(learnCandidate.metadata.website, "https://learn.microsoft.com/azure/cosmos-db");
  assert.equal(learnCandidate.metadata.preview, CATALOG_PREVIEW_PLACEHOLDER);
  assert.equal(learnCandidate.publishedAt, null);
  assert.equal(learnCandidate.metadata.publishedAt, null);
  assert.equal(learnCandidate.modifiedAt, "2026-08-10T08:00:00.000Z");
});

test("feed fixture accepts already parsed entries with stable GUIDs", async () => {
  const candidates = discoverFeeds({ fixture: await loadFixture("feeds"), offline: true });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceType, "blog-post");
  assert.equal(candidates[0].metadata.feedEntryId, "https://devblogs.microsoft.com/cosmosdb/?p=12345");
  assert.equal(candidates[0].metadata.galleryId, generateCandidateGalleryId(candidates[0]));
  assert.deepEqual(candidates[0].metadata.tags, ["blog", "microsoft"]);
  assert.equal(candidates[0].canonicalUrl.includes("utm_"), false);
  assert.deepEqual(
    {
      launchUrl: candidates[0].metadata.launchUrl,
      website: candidates[0].metadata.website,
      author: candidates[0].metadata.author,
      sourceOwner: candidates[0].metadata.sourceOwner,
      publishedAt: candidates[0].metadata.publishedAt,
      preview: candidates[0].metadata.preview,
    },
    {
      launchUrl: "https://devblogs.microsoft.com/cosmosdb/vector-search-update/?utm_medium=rss&utm_source=fixture",
      website: "https://devblogs.microsoft.com/cosmosdb",
      author: "Azure Cosmos DB Blog",
      sourceOwner: "Azure Cosmos DB Blog",
      publishedAt: "2026-08-25T09:00:00.000Z",
      preview: "https://devblogs.microsoft.com/cosmosdb/wp-content/uploads/sites/52/2026/08/vector-search.png",
    },
  );
});

test("feed metadata requires entry or configured host evidence", async () => {
  const fixture = await loadFixture("feeds");
  const entry = {
    ...fixture.entries[0],
    link: "https://devblogs.microsoft.com/CosmosDB/Vector-Search?view=Full&utm_source=feed#Examples",
    feedSiteUrl: "https://localhost/private",
    siteUrl: "https://attacker.example/forged-site",
    imageUrl: "https://127.0.0.1/preview.png",
    thumbnailUrl: "https://attacker.example/preview.png",
    publishedAt: null,
    modifiedAt: "2026-08-26T10:00:00Z",
  };
  const [candidate] = discoverFeeds({
    fixture: {
      ...fixture,
      source: { ...fixture.source, website: "https://attacker.example/forged-site" },
      entries: [entry],
    },
    offline: true,
  });

  assert.equal(candidate.metadata.launchUrl, entry.link);
  assert.equal(
    candidate.canonicalUrl,
    "https://devblogs.microsoft.com/CosmosDB/Vector-Search?view=Full",
  );
  assert.equal(candidate.metadata.website, "https://devblogs.microsoft.com/");
  assert.equal(candidate.metadata.preview, CATALOG_PREVIEW_PLACEHOLDER);
  assert.equal(candidate.publishedAt, null);
  assert.equal(candidate.metadata.publishedAt, null);
  assert.equal(candidate.modifiedAt, "2026-08-26T10:00:00.000Z");
});

test("YouTube fixture requires configured source IDs and immutable video IDs", async () => {
  const fixture = await loadFixture("youtube");
  assert.equal(isYouTubeDiscoveryEnabled(fixture.source), true);
  const candidates = discoverYouTube({ fixture, offline: true });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].identityKey, "video:6IIUtEFKJec");
  assert.equal(candidates[0].metadata.galleryId, generateCandidateGalleryId(candidates[0]));
  assert.deepEqual(candidates[0].metadata.tags, ["video", "microsoft"]);
  assert.equal(candidates[0].canonicalUrl, "https://www.youtube.com/watch?v=6IIUtEFKJec");
  assert.deepEqual(
    {
      launchUrl: candidates[0].metadata.launchUrl,
      website: candidates[0].metadata.website,
      author: candidates[0].metadata.author,
      sourceOwner: candidates[0].metadata.sourceOwner,
      publishedAt: candidates[0].metadata.publishedAt,
      preview: candidates[0].metadata.preview,
    },
    {
      launchUrl: candidates[0].canonicalUrl,
      website: "https://www.youtube.com/channel/UC1234567890abcdefghijkl",
      author: "Microsoft Developer",
      sourceOwner: "Microsoft Developer",
      publishedAt: "2026-08-24T15:00:00.000Z",
      preview: "https://i.ytimg.com/vi/6IIUtEFKJec/hqdefault.jpg",
    },
  );
  assert.equal(candidates[0].metadata.youtubeSourceType, "youtube-playlist");
  assert.equal(candidates[0].metadata.youtubeSourceId, fixture.source.playlistId);
  assert.equal(candidates[0].metadata.captionsAvailable, true);
  assert.equal(candidates[0].evidence.some((item) => item.type === "youtube-transcript"), true);

  assert.equal(
    discoverYouTube({ fixture: { ...fixture, source: { enabled: true } }, offline: true }).length,
    0,
  );
});

test("YouTube metadata uses only official snippet channel, thumbnail, and timestamp fields", async () => {
  const fixture = await loadFixture("youtube");
  const configuredChannelId = fixture.videos[0].snippet.channelId;
  const channelSource = {
    ...fixture.source,
    type: "youtube-channel",
    channelId: configuredChannelId,
  };
  delete channelSource.playlistId;
  const video = {
    id: "6IIUtEFKJec",
    channelId: "UC9999999999abcdefghijkl",
    channelTitle: "Forged top-level channel",
    publishedAt: "2020-01-01T00:00:00Z",
    thumbnailUrl: "https://i.ytimg.com/vi/6IIUtEFKJec/forged.jpg",
    transcript: "Azure Cosmos DB walkthrough.",
    snippet: {
      title: "Build with Azure Cosmos DB",
      description: "Azure Cosmos DB for NoSQL.",
      channelId: configuredChannelId,
      channelTitle: "Official Channel",
      thumbnails: {
        high: { url: "https://preview.attacker.example/forged.jpg" },
      },
    },
  };
  const [candidate] = discoverYouTube({
    fixture: {
      ...fixture,
      source: channelSource,
      videos: [video],
    },
    offline: true,
  });

  assert.equal(candidate.metadata.website, `https://www.youtube.com/channel/${configuredChannelId}`);
  assert.equal(candidate.metadata.author, "Official Channel");
  assert.equal(candidate.metadata.preview, CATALOG_PREVIEW_PLACEHOLDER);
  assert.equal(candidate.publishedAt, null);
  assert.equal(candidate.metadata.publishedAt, null);

  const forgedChannelVideo = {
    ...video,
    channelId: configuredChannelId,
    snippet: {
      ...video.snippet,
      channelId: "UC9999999999abcdefghijkl",
    },
  };
  assert.deepEqual(
    discoverYouTube({
      fixture: {
        ...fixture,
        source: channelSource,
        videos: [forgedChannelVideo],
      },
      offline: true,
    }),
    [],
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
    assert.match(candidate.metadata.launchUrl, /^https:\/\//);
    assert.equal(candidate.metadata.publishedAt, candidate.publishedAt);
    assert.match(candidate.metadata.website, /^https:\/\//);
    assert.ok(candidate.metadata.author);
    assert.ok(candidate.metadata.preview);
    assert.match(candidate.metadata.galleryId, /^candidate-[a-f0-9]{64}$/);
    assert.ok(Array.isArray(candidate.metadata.tags));
  }
  assert.deepEqual(discoverGitHub({ offline: true }), []);
  assert.deepEqual(discoverLearn({ offline: true }), []);
  assert.deepEqual(discoverFeeds({ offline: true }), []);
  assert.deepEqual(discoverYouTube({ offline: true }), []);
});

test("untrusted sources do not receive the microsoft tag", async () => {
  const fixture = await loadFixture("feeds");
  const [candidate] = discoverFeeds({
    fixture: {
      ...fixture,
      source: { ...fixture.source, trustTier: "community" },
    },
    offline: true,
  });

  assert.deepEqual(candidate.metadata.tags, ["blog"]);
});

test("keywords do not create speculative language, service, or scenario tags", async () => {
  const fixture = await loadFixture("github");
  const repository = {
    ...fixture.repositories[0],
    name: "python-serverless-migration-cosmosdb-ai",
    description: "Python serverless migration analytics AI search scenario",
    readme: "Python TypeScript Java C# Cosmos DB serverless migration analytics search",
  };
  const [candidate] = discoverGitHub({
    fixture: { ...fixture, repositories: [repository] },
    offline: true,
  });

  assert.deepEqual(candidate.metadata.tags, ["example", "microsoft"]);
});