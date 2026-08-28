import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { discoverYouTube, isYouTubeDiscoveryEnabled } from "./youtube.mjs";

const API_ENDPOINT = "https://youtube.googleapis.com/youtube/v3";
const CHANNEL_ID = "UC1234567890123456789012";
const PLAYLIST_ID = "PL12345678901234567890123456789012";

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

test("schema accepts disabled exact YouTube channel and playlist sources", () => {
  assert.equal(validateRegistry(registry([
    source("youtube-channel"),
    source("youtube-playlist"),
    source("youtube-playlist", { id: "youtube-legacy-playlist", playlistId: "PLBCF2DAC6FFB574DE" }),
  ])), true, JSON.stringify(validateRegistry.errors));
});

test("schema rejects mutable IDs, alternate endpoints, crossed IDs, and configured keys", () => {
  const invalidSources = [
    source("youtube-channel", { channelId: "@cosmosdb" }),
    source("youtube-channel", { channelId: `PL${CHANNEL_ID.slice(2)}` }),
    source("youtube-playlist", { playlistId: "PLtoo-short" }),
    source("youtube-playlist", { endpoint: `${API_ENDPOINT}/` }),
    { ...source("youtube-channel"), playlistId: PLAYLIST_ID },
    { ...source("youtube-playlist"), channelId: CHANNEL_ID },
    { ...source("youtube-playlist"), apiKey: "must-not-be-configured" },
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

test("checked-in registry advertises support without an unverified YouTube source", () => {
  assert.equal(checkedInRegistry.version, "1.0.0");
  assert.deepEqual(
    checkedInRegistry.sources.filter((item) => item.type.startsWith("youtube-")),
    [],
  );
});