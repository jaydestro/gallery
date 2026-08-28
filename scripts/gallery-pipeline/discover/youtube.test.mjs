import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  discoverYouTube,
  isYouTubeDiscoveryEnabled,
  isYouTubeSourceConfigured,
} from "./youtube.mjs";

const API_ENDPOINT = "https://youtube.googleapis.com/youtube/v3";
const CHANNEL_ID = "UC1234567890123456789012";
const PLAYLIST_ID = "PL12345678901234567890123456789012";
const OFFICIAL_FEED_ENDPOINT = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

const registryDirectory = new URL("../../../.github/gallery-pipeline/", import.meta.url);
const [schema, checkedInRegistry] = await Promise.all([
  readFile(new URL("trusted-sources.schema.json", registryDirectory), "utf8").then(JSON.parse),
  readFile(new URL("trusted-sources.json", registryDirectory), "utf8").then(JSON.parse),
]);
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
const validateRegistry = ajv.compile(schema);

function source(type, overrides = {}) {
  return {
    id: type,
    type,
    endpoint: API_ENDPOINT,
    ...(type === "youtube-channel" ? { channelId: CHANNEL_ID } : { playlistId: PLAYLIST_ID }),
    trustTier: "first-party",
    enabled: false,
    cadence: "weekly",
    ownerLabel: "YouTube fixture",
    includeRules: ["require-cosmos-db-material-relevance"],
    excludeRules: ["videos-without-immutable-id"],
    ...overrides,
  };
}

function registry(sources) {
  return {
    $schema: "./trusted-sources.schema.json",
    version: "1.0.0",
    sources,
  };
}

function officialFeedSource(overrides = {}) {
  return source("youtube-channel", {
    id: "youtube-official-feed",
    endpoint: OFFICIAL_FEED_ENDPOINT,
    transport: "official-feed",
    trustTier: "curated",
    ...overrides,
  });
}

test("schema accepts disabled exact YouTube channel and playlist sources", () => {
  assert.equal(validateRegistry(registry([
    source("youtube-channel"),
    source("youtube-channel", { id: "youtube-api-transport", transport: "api" }),
    source("youtube-playlist"),
    source("youtube-playlist", { id: "youtube-legacy-playlist", playlistId: "PLBCF2DAC6FFB574DE" }),
  ])), true, JSON.stringify(validateRegistry.errors));
});

test("schema and adapter accept an exact channel-bound official feed", () => {
  const configured = officialFeedSource();

  assert.equal(validateRegistry(registry([configured])), true, JSON.stringify(validateRegistry.errors));
  assert.equal(isYouTubeSourceConfigured(configured), true);
  assert.equal(isYouTubeSourceConfigured(officialFeedSource({
    endpoint: "https://www.youtube.com/feeds/videos.xml?channel_id=UC9999999999999999999999",
  })), false);
  assert.equal(isYouTubeSourceConfigured(officialFeedSource({
    endpoint: `${OFFICIAL_FEED_ENDPOINT}&feature=rss`,
  })), false);
});

test("schema rejects mutable IDs, alternate endpoints, crossed IDs, transport misuse, and configured keys", () => {
  const feedWithoutTransport = officialFeedSource();
  delete feedWithoutTransport.transport;
  const invalidSources = [
    source("youtube-channel", { channelId: "@cosmosdb" }),
    source("youtube-channel", { channelId: `PL${CHANNEL_ID.slice(2)}` }),
    source("youtube-playlist", { playlistId: "PLtoo-short" }),
    source("youtube-playlist", { endpoint: `${API_ENDPOINT}/` }),
    { ...source("youtube-channel"), playlistId: PLAYLIST_ID },
    { ...source("youtube-playlist"), channelId: CHANNEL_ID },
    { ...source("youtube-playlist"), apiKey: "must-not-be-configured" },
    feedWithoutTransport,
    officialFeedSource({ endpoint: `http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}` }),
    officialFeedSource({ endpoint: `${OFFICIAL_FEED_ENDPOINT}&feature=rss` }),
    officialFeedSource({ trustTier: "community" }),
    source("youtube-channel", { transport: "official-feed" }),
    source("youtube-playlist", { transport: "official-feed" }),
  ];

  for (const invalidSource of invalidSources) {
    assert.equal(validateRegistry(registry([invalidSource])), false);
  }
});

test("adapter needs no transcript and only exposes explicitly reported caption availability", () => {
  const enabledSource = source("youtube-playlist", { enabled: true });
  const baseVideo = {
    id: "6IIUtEFKJec",
    snippet: {
      title: "Build with Azure Cosmos DB",
      description: "Use Azure Cosmos DB for NoSQL.",
      publishedAt: "2026-08-26T10:00:00Z",
      channelId: CHANNEL_ID,
      channelTitle: "Microsoft Developer",
    },
    playlistIds: [PLAYLIST_ID],
  };
  const [captioned] = discoverYouTube({
    source: enabledSource,
    videos: [{ ...baseVideo, contentDetails: { caption: "true" } }],
    discoveredAt: "2026-08-27T12:00:00Z",
  });
  const [notCaptioned] = discoverYouTube({
    source: enabledSource,
    videos: [{
      ...baseVideo,
      contentDetails: { caption: "false" },
      transcript: "This unverified transcript must be ignored.",
    }],
    discoveredAt: "2026-08-27T12:00:00Z",
  });

  assert.equal(isYouTubeDiscoveryEnabled(source("youtube-playlist")), false);
  assert.equal(captioned.metadata.captionsAvailable, true);
  assert.equal(captioned.evidence.some((item) => item.type === "youtube-transcript"), false);
  assert.equal(notCaptioned.metadata.captionsAvailable, false);
  assert.equal(notCaptioned.evidence.some((item) => item.type === "youtube-transcript"), false);
});

test("curated YouTube sources do not receive the microsoft tag", () => {
  const [candidate] = discoverYouTube({
    source: officialFeedSource({ enabled: true }),
    videos: [{
      id: "6IIUtEFKJec",
      snippet: {
        title: "Build with Azure Cosmos DB",
        description: "Use Azure Cosmos DB for NoSQL.",
        publishedAt: "2026-08-26T10:00:00Z",
        channelId: CHANNEL_ID,
        channelTitle: "SQLBits",
      },
    }],
    discoveredAt: "2026-08-27T12:00:00Z",
  });

  assert.deepEqual(candidate.metadata.tags, ["video"]);
});

test("checked-in registry contains the seven verified daily official feeds", () => {
  assert.equal(checkedInRegistry.version, "1.0.0");
  assert.equal(validateRegistry(checkedInRegistry), true, JSON.stringify(validateRegistry.errors));
  const youtubeSources = checkedInRegistry.sources.filter((item) => item.type === "youtube-channel");
  assert.deepEqual(
    youtubeSources.map((item) => ({
      id: item.id,
      channelId: item.channelId,
      ownerLabel: item.ownerLabel,
      trustTier: item.trustTier,
    })),
    [
      {
        id: "youtube-azure-cosmos-db",
        channelId: "UC9OJ32CzooNJNoP6_iIfxRw",
        ownerLabel: "Azure Cosmos DB",
        trustTier: "first-party",
      },
      {
        id: "youtube-coffee-with-azure-cosmos-db",
        channelId: "UCRA3PMzX6Rz2KrX6bf-XrHA",
        ownerLabel: "Coffee with Azure Cosmos DB",
        trustTier: "curated",
      },
      {
        id: "youtube-microsoft-azure",
        channelId: "UC0m-80FnNY2Qb7obvTL_2fA",
        ownerLabel: "Microsoft Azure",
        trustTier: "first-party",
      },
      {
        id: "youtube-microsoft-developer",
        channelId: "UCsMica-v34Irf9KVTh6xx-g",
        ownerLabel: "Microsoft Developer",
        trustTier: "first-party",
      },
      {
        id: "youtube-microsoft-reactor",
        channelId: "UCkm6luGCS3hD25jcEhvRMIA",
        ownerLabel: "Microsoft Reactor",
        trustTier: "first-party",
      },
      {
        id: "youtube-microsoft-mechanics",
        channelId: "UCJ9905MRHxwLZ2jeNQGIWxA",
        ownerLabel: "Microsoft Mechanics",
        trustTier: "first-party",
      },
      {
        id: "youtube-sqlbits",
        channelId: "UCn_9T5oprhCz9whckcRcEgg",
        ownerLabel: "SQLBits",
        trustTier: "curated",
      },
    ],
  );
  assert.ok(youtubeSources.every((item) => (
    item.enabled === true &&
    item.cadence === "daily" &&
    item.transport === "official-feed" &&
    item.endpoint === `https://www.youtube.com/feeds/videos.xml?channel_id=${item.channelId}` &&
    isYouTubeSourceConfigured(item)
  )));
});