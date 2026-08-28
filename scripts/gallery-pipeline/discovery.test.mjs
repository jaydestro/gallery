import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createFixtureTransport,
  isAllowedGitHubEndpoint,
  parseFeedXml,
  parseSafeXml,
  parseYouTubeFeedXml,
  runDiscovery,
} from "./discovery.mjs";
import { canonicalizeLearnUrl } from "./shared/canonicalize.mjs";

const DISCOVERED_AT = "2026-08-27T12:00:00Z";
const YOUTUBE_API_ENDPOINT = "https://youtube.googleapis.com/youtube/v3";
const YOUTUBE_CHANNEL_ID = "UC1234567890123456789012";
const YOUTUBE_FEED_ENDPOINT = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
const YOUTUBE_PLAYLIST_ID = "PL12345678901234567890123456789012";
const YOUTUBE_UPLOADS_PLAYLIST_ID = `UU${YOUTUBE_CHANNEL_ID.slice(2)}`;
const YOUTUBE_PLAYLIST_FIELDS = "nextPageToken,items(contentDetails/videoId)";
const YOUTUBE_VIDEO_FIELDS = "items(id,snippet(title,description,publishedAt,channelId,channelTitle,thumbnails),contentDetails/caption)";
const YOUTUBE_FEED_FIXTURE = await readFile(
  new URL("./fixtures/discovery/youtube-feed.xml", import.meta.url),
  "utf8",
);

function githubSource(overrides = {}) {
  return {
    id: "github-org-azurecosmosdb",
    type: "github-organization",
    endpoint: "https://api.github.com/orgs/AzureCosmosDB",
    organization: "AzureCosmosDB",
    trustTier: "first-party",
    enabled: true,
    ownerLabel: "Azure Cosmos DB",
    ...overrides,
  };
}

function feedSource(id, endpoint) {
  return {
    id,
    type: "rss-feed",
    endpoint,
    trustTier: "first-party",
    enabled: true,
    ownerLabel: "Azure Cosmos DB Blog",
  };
}

function youtubeSource(type, overrides = {}) {
  return {
    id: type,
    type,
    endpoint: YOUTUBE_API_ENDPOINT,
    ...(type === "youtube-channel"
      ? { channelId: YOUTUBE_CHANNEL_ID }
      : { playlistId: YOUTUBE_PLAYLIST_ID }),
    trustTier: "first-party",
    enabled: true,
    ownerLabel: "YouTube fixture",
    ...overrides,
  };
}

function youtubeFeedSource(overrides = {}) {
  return youtubeSource("youtube-channel", {
    id: "youtube-official-feed",
    endpoint: YOUTUBE_FEED_ENDPOINT,
    transport: "official-feed",
    trustTier: "curated",
    ownerLabel: "SQLBits",
    ...overrides,
  });
}

function youtubeApiUrl(resource, parameters) {
  const url = new URL(`${YOUTUBE_API_ENDPOINT}/${resource}`);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  return url.toString();
}

function youtubeVideo(id, overrides = {}) {
  return {
    id,
    snippet: {
      title: `Azure Cosmos DB video ${id}`,
      description: "Build an application with Azure Cosmos DB for NoSQL.",
      publishedAt: "2026-08-26T10:00:00Z",
      channelId: YOUTUBE_CHANNEL_ID,
      channelTitle: "Microsoft Developer",
      thumbnails: {
        high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
      },
    },
    contentDetails: { caption: "false" },
    ...overrides,
  };
}

function githubRepository(id, overrides = {}) {
  return {
    id,
    name: `repository-${id}`,
    full_name: `AzureCosmosDB/repository-${id}`,
    html_url: `https://github.com/AzureCosmosDB/repository-${id}`,
    owner: { login: "AzureCosmosDB" },
    description: "A sample repository",
    private: false,
    disabled: false,
    archived: false,
    size: 10,
    default_branch: "main",
    topics: [],
    ...overrides,
  };
}

function githubApiUrl(pathname, parameters) {
  const url = new URL(`https://api.github.com${pathname}`);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

function listingUrl(page, pageSize) {
  return githubApiUrl("/orgs/AzureCosmosDB/repos", {
    type: "public",
    sort: "updated",
    direction: "desc",
    per_page: String(pageSize),
    page: String(page),
  });
}

function searchUrl(pageSize) {
  return githubApiUrl("/search/repositories", {
    q: "cosmos db org:AzureCosmosDB",
    sort: "updated",
    order: "desc",
    per_page: String(pageSize),
  });
}

async function runWithFixtures({
  sources,
  responses,
  activeCatalog = [],
  retiredCatalog = [],
  limits = {},
  environment = { YOUTUBE_API_KEY: "fixture-youtube-api-key" },
  cadence = "all",
}) {
  const transport = createFixtureTransport(responses);
  const youtubeAuthentication = [];
  const fetchImpl = async (input, options) => {
    if (new URL(input).hostname === "youtube.googleapis.com") {
      const expectedKey = environment?.YOUTUBE_API_KEY;
      const headers = new Headers(options?.headers);
      youtubeAuthentication.push(
        typeof expectedKey === "string" &&
        expectedKey.length > 0 &&
        headers.get("X-Goog-Api-Key") === expectedKey,
      );
    }
    return transport.fetchImpl(input, options);
  };
  const result = await runDiscovery({
    trustedSources: { sources },
    activeCatalog,
    retiredCatalog,
    githubToken: "fixture-token",
    environment,
    discoveredAt: DISCOVERED_AT,
    cadence,
    limits,
    fetchOptions: { fetchImpl, lookup: transport.lookup },
  });
  return { result, requests: transport.requests, youtubeAuthentication };
}

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><link>https://devblogs.microsoft.com/cosmosdb/</link>${items.join("")}</channel></rss>`;
}

function rssItem(id, slug) {
  return `<item><guid>${id}</guid><link>https://devblogs.microsoft.com/cosmosdb/${slug}/</link><title>Azure Cosmos DB ${slug}</title><description>Azure Cosmos DB guidance.</description><pubDate>Thu, 27 Aug 2026 09:00:00 GMT</pubDate></item>`;
}

test("GitHub endpoint allowlist permits only the configured org and selected content", () => {
  const context = { organization: "AzureCosmosDB" };
  assert.equal(
    isAllowedGitHubEndpoint("https://api.github.com/orgs/AzureCosmosDB/repos?page=1", context),
    true,
  );
  assert.equal(
    isAllowedGitHubEndpoint(
      "https://api.github.com/search/repositories?q=cosmos+db+org%3AAzureCosmosDB",
      context,
    ),
    true,
  );
  assert.equal(
    isAllowedGitHubEndpoint(
      "https://api.github.com/search/code?q=CosmosClient+org%3AAzureCosmosDB",
      context,
    ),
    false,
  );
  assert.equal(
    isAllowedGitHubEndpoint("https://api.github.com/orgs/microsoft/repos", context),
    false,
  );
  assert.equal(
    isAllowedGitHubEndpoint("https://api.github.com/user", context),
    false,
  );
  assert.equal(
    isAllowedGitHubEndpoint(
      "https://api.github.com/repos/AzureCosmosDB/demo/contents/package.json?ref=main",
      { ...context, repository: "demo", contentPath: "package.json" },
    ),
    false,
  );
  assert.equal(
    isAllowedGitHubEndpoint(
      "https://api.github.com/repos/AzureCosmosDB/demo/contents/.github/workflows/release.yml",
      { ...context, repository: "demo", contentPath: "package.json" },
    ),
    false,
  );
});

test("GitHub listing pagination is bounded and repository search runs once per organization", async () => {
  const responses = {
    [listingUrl(1, 1)]: { body: [githubRepository(1)] },
    [listingUrl(2, 1)]: { body: [githubRepository(2)] },
    [searchUrl(1)]: {
      body: { total_count: 1, incomplete_results: false, items: [githubRepository(1)] },
    },
    "https://api.github.com/repos/AzureCosmosDB/repository-1/readme": { status: 404 },
  };
  const { result, requests } = await runWithFixtures({
    sources: [githubSource()],
    responses,
    limits: {
      githubPageSize: 1,
      githubListingPages: 2,
      githubRepositories: 2,
    },
  });

  assert.equal(requests.includes(listingUrl(3, 1)), false);
  assert.equal(requests.filter((url) => url.includes("/search/repositories?")).length, 1);
  assert.equal(requests.some((url) => url.includes("/search/code?")), false);
  assert.equal(result.sources[0].status, "succeeded");
});

test("GitHub repository search avoids a code-search 429 response", async () => {
  const repository = githubRepository(3, {
    description: "Azure Cosmos DB tooling",
    topics: ["cosmos-db"],
  });
  const legacyCodeSearch = "https://api.github.com/search/code?q=Microsoft.Azure.Cosmos+org%3AAzureCosmosDB";
  const responses = {
    [listingUrl(1, 2)]: { body: [repository] },
    [searchUrl(2)]: { body: { total_count: 1, incomplete_results: false, items: [repository] } },
    [legacyCodeSearch]: { status: 429 },
    "https://api.github.com/repos/AzureCosmosDB/repository-3/readme": { status: 503 },
  };
  const { result, requests } = await runWithFixtures({
    sources: [githubSource()],
    responses,
    limits: { githubPageSize: 2, githubListingPages: 1, githubRepositories: 2 },
  });

  assert.equal(requests.includes(legacyCodeSearch), false);
  assert.equal(requests.filter((url) => url.includes("/search/repositories?")).length, 1);
  assert.equal(result.sources[0].status, "succeeded");
  assert.equal(result.candidates.length, 1);
});

test("GitHub does not accept a repository from a Cosmos DB keyword alone", async () => {
  const repository = githubRepository(10, { description: "Mentions Azure Cosmos DB once" });
  const responses = {
    [listingUrl(1, 2)]: { body: [repository] },
    [searchUrl(2)]: { body: { total_count: 1, incomplete_results: false, items: [repository] } },
    "https://api.github.com/repos/AzureCosmosDB/repository-10/readme": { status: 404 },
  };
  const { result } = await runWithFixtures({
    sources: [githubSource()],
    responses,
    limits: {
      githubPageSize: 2,
      githubListingPages: 1,
      githubRepositories: 2,
    },
  });

  assert.equal(result.status, "complete");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0].reason, "insufficient-cosmos-evidence");
  assert.equal(result.rejected[0].sourceId, "10");
});

test("GitHub accepts strong SDK evidence found only in a bounded README", async () => {
  const repository = githubRepository(11);
  const responses = {
    [listingUrl(1, 2)]: { body: [repository] },
    [searchUrl(2)]: { body: { total_count: 0, incomplete_results: false, items: [] } },
    "https://api.github.com/repos/AzureCosmosDB/repository-11/readme": {
      body: {
        encoding: "base64",
        content: Buffer.from("dotnet add package Microsoft.Azure.Cosmos").toString("base64"),
      },
    },
  };
  const { result } = await runWithFixtures({
    sources: [githubSource()],
    responses,
    limits: { githubPageSize: 2, githubListingPages: 1, githubRepositories: 2 },
  });

  assert.equal(result.sources[0].status, "succeeded");
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].metadata.strongSignalKinds, ["sdk"]);
});

test("exact duplicate rejection covers active and retired catalog records", async () => {
  const endpoint = "https://devblogs.microsoft.com/cosmosdb/feed/";
  const responses = {
    [endpoint]: { body: rss([rssItem("active-guid", "active-post"), rssItem("retired-guid", "retired-post")]) },
  };
  const { result } = await runWithFixtures({
    sources: [feedSource("cosmos-feed", endpoint)],
    responses,
    activeCatalog: [{ source: "https://devblogs.microsoft.com/cosmosdb/active-post" }],
    retiredCatalog: {
      entries: [{ record: { canonicalSource: "https://devblogs.microsoft.com/cosmosdb/retired-post" } }],
    },
  });

  assert.equal(result.candidates.length, 0);
  assert.deepEqual(
    result.rejected.map((item) => item.matchedScopes),
    [["active"], ["retired"]],
  );
  assert.ok(result.rejected.every((item) => item.reason === "exact-duplicate"));
});

test("one source failure is indeterminate without discarding successful source candidates", async () => {
  const goodEndpoint = "https://devblogs.microsoft.com/cosmosdb/feed/";
  const failedEndpoint = "https://devblogs.microsoft.com/cosmosdb/unavailable-feed/";
  const responses = {
    [goodEndpoint]: { body: rss([rssItem("good-guid", "good-post")]) },
    [failedEndpoint]: { status: 503, body: "temporarily unavailable" },
  };
  const { result } = await runWithFixtures({
    sources: [feedSource("good-feed", goodEndpoint), feedSource("failed-feed", failedEndpoint)],
    responses,
  });

  assert.equal(result.status, "partial");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].sourceId, "good-guid");
  assert.equal(result.sources.find((source) => source.sourceRegistryId === "good-feed").status, "succeeded");
  assert.equal(
    result.sources.find((source) => source.sourceRegistryId === "failed-feed").status,
    "indeterminate",
  );
  assert.ok(result.rejected.some((item) => item.reason === "source-indeterminate"));
});

test("cadence filtering preserves mixed source statuses without duplicate queries", async () => {
  const weeklyEndpoint = "https://devblogs.microsoft.com/cosmosdb/feed/";
  const sources = [
    { ...feedSource("weekly-feed", weeklyEndpoint), cadence: "weekly" },
    youtubeFeedSource({ cadence: "daily" }),
  ];
  const responses = {
    [weeklyEndpoint]: { body: rss([rssItem("weekly-guid", "weekly-post")]) },
    [YOUTUBE_FEED_ENDPOINT]: { body: YOUTUBE_FEED_FIXTURE },
  };

  const daily = await runWithFixtures({ sources, responses, environment: {}, cadence: "daily" });
  const weekly = await runWithFixtures({ sources, responses, environment: {}, cadence: "weekly" });

  assert.equal(daily.result.cadence, "daily");
  assert.equal(weekly.result.cadence, "weekly");
  assert.deepEqual(daily.requests, [YOUTUBE_FEED_ENDPOINT]);
  assert.deepEqual(weekly.requests, [weeklyEndpoint]);
  assert.equal(
    [...daily.requests, ...weekly.requests].filter((url) => url === YOUTUBE_FEED_ENDPOINT).length,
    1,
  );
  assert.equal(
    [...daily.requests, ...weekly.requests].filter((url) => url === weeklyEndpoint).length,
    1,
  );
  assert.deepEqual(
    daily.result.sources.map(({ sourceRegistryId, status, queried, reason }) => ({
      sourceRegistryId,
      status,
      queried,
      reason,
    })),
    [
      {
        sourceRegistryId: "weekly-feed",
        status: "skipped",
        queried: false,
        reason: "cadence-not-selected",
      },
      {
        sourceRegistryId: "youtube-official-feed",
        status: "succeeded",
        queried: true,
        reason: undefined,
      },
    ],
  );
  assert.equal(weekly.result.sources[1].status, "skipped");
  assert.equal(weekly.result.sources[1].queried, false);
  assert.equal(weekly.result.sources[1].reason, "cadence-not-selected");
});

test("stops starting discovery requests after the operation deadline", async () => {
  const firstEndpoint = "https://devblogs.microsoft.com/cosmosdb/first-feed/";
  const secondEndpoint = "https://devblogs.microsoft.com/cosmosdb/second-feed/";
  const requests = [];
  let currentMilliseconds = 0;
  const result = await runDiscovery({
    trustedSources: {
      sources: [
        feedSource("first-feed", firstEndpoint),
        feedSource("second-feed", secondEndpoint),
      ],
    },
    discoveredAt: DISCOVERED_AT,
    deadlineMilliseconds: 100,
    now: () => currentMilliseconds,
    fetchOptions: {
      lookup: async () => [{ address: "20.12.34.56", family: 4 }],
      fetchImpl: async (input) => {
        requests.push(String(input));
        currentMilliseconds = 100;
        return new Response(rss([rssItem("late-guid", "late-post")]));
      },
    },
  });

  assert.deepEqual(requests, [firstEndpoint]);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(
    result.sources.map(({ sourceRegistryId, status, queried, reason }) => ({
      sourceRegistryId,
      status,
      queried,
      reason,
    })),
    [
      {
        sourceRegistryId: "first-feed",
        status: "indeterminate",
        queried: true,
        reason: "DISCOVERY_DEADLINE_EXCEEDED",
      },
      {
        sourceRegistryId: "second-feed",
        status: "indeterminate",
        queried: false,
        reason: "DISCOVERY_DEADLINE_EXCEEDED",
      },
    ],
  );
});

test("unavailable official Learn sitemap is indeterminate", async () => {
  const source = {
    id: "learn-cosmos-db",
    type: "documentation-root",
    endpoint: "https://learn.microsoft.com/azure/cosmos-db/",
    trustTier: "first-party",
    enabled: true,
    ownerLabel: "Microsoft Learn",
  };
  const { result } = await runWithFixtures({
    sources: [source],
    responses: {
      "https://learn.microsoft.com/azure/cosmos-db/sitemap.xml": { status: 404 },
      "https://learn.microsoft.com/sitemap.xml": { status: 503 },
      "https://learn.microsoft.com/azure/cosmos-db/": { status: 503 },
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].status, "indeterminate");
  assert.equal(result.candidates.length, 0);
});

test("Learn sitemap preserves the authoritative launch URL and keeps lastmod modification-only", async () => {
  const source = {
    id: "learn-cosmos-db",
    type: "documentation-root",
    endpoint: "https://learn.microsoft.com/azure/cosmos-db/",
    trustTier: "first-party",
    enabled: true,
    ownerLabel: "Microsoft Learn",
  };
  const launchUrl = "https://Learn.Microsoft.com/en-us/Azure/Cosmos-DB/NoSQL/Vector-Search?view=Full#Examples";
  const { result } = await runWithFixtures({
    sources: [source],
    responses: {
      "https://learn.microsoft.com/azure/cosmos-db/sitemap.xml": {
        body: `<?xml version="1.0"?><urlset><url><loc>${launchUrl}</loc><lastmod>2026-08-25</lastmod></url></urlset>`,
      },
    },
  });

  assert.equal(result.status, "complete");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].metadata.launchUrl, launchUrl);
  assert.equal(
    result.candidates[0].canonicalUrl,
    "https://learn.microsoft.com/Azure/Cosmos-DB/NoSQL/Vector-Search?view=Full",
  );
  assert.equal(result.candidates[0].publishedAt, null);
  assert.equal(result.candidates[0].metadata.publishedAt, null);
  assert.equal(result.candidates[0].modifiedAt, "2026-08-25T00:00:00.000Z");
});

test("Learn follows a same-host redirect to the official root index", async () => {
  const source = {
    id: "learn-cosmos-db",
    type: "documentation-root",
    endpoint: "https://learn.microsoft.com/azure/cosmos-db/",
    trustTier: "first-party",
    enabled: true,
    ownerLabel: "Microsoft Learn",
  };
  const rootHtml = `<!doctype html><html><body>
    <a href="/en-us/azure/cosmos-db/nosql/vector-search?view=azure-cli-latest#examples">Vector search</a>
    <a href="https://evil.example/azure/cosmos-db/stolen">External</a>
    <a href="//learn.microsoft.com.evil.example/azure/cosmos-db/spoofed">Spoofed</a>
    <a href="/en-us/azure/storage/blobs/">Out of root</a>
    <a href="javascript:alert(1)">Script</a>
    <script>const fake = '<a href="/azure/cosmos-db/fake">fake</a>';</script>
  </body></html>`;
  const { result, requests } = await runWithFixtures({
    sources: [source],
    responses: {
      "https://learn.microsoft.com/azure/cosmos-db/sitemap.xml": { status: 404 },
      "https://learn.microsoft.com/sitemap.xml": { status: 404 },
      "https://learn.microsoft.com/azure/cosmos-db/": {
        status: 302,
        headers: { location: "/en-us/azure/cosmos-db/" },
      },
      "https://learn.microsoft.com/en-us/azure/cosmos-db/": { body: rootHtml },
    },
  });

  assert.equal(result.status, "complete");
  assert.equal(result.sources[0].status, "succeeded");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.canonicalUrl),
    ["https://learn.microsoft.com/azure/cosmos-db/nosql/vector-search?view=azure-cli-latest"],
  );
  assert.equal(
    result.candidates[0].metadata.launchUrl,
    "https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/vector-search?view=azure-cli-latest#examples",
  );
  assert.equal(result.candidates[0].publishedAt, null);
  assert.ok(result.candidates[0].evidence.some((item) =>
    item.type === "learn-official-root-index" && item.url === canonicalizeLearnUrl(source.endpoint)));
  assert.equal(requests.filter((url) => url === source.endpoint).length, 1);
  assert.equal(requests.filter((url) => url === "https://learn.microsoft.com/en-us/azure/cosmos-db/").length, 1);
});

test("Learn rejects a cross-host redirect from the official root index", async () => {
  const source = {
    id: "learn-cosmos-db",
    type: "documentation-root",
    endpoint: "https://learn.microsoft.com/azure/cosmos-db/",
    trustTier: "first-party",
    enabled: true,
    ownerLabel: "Microsoft Learn",
  };
  const { result, requests } = await runWithFixtures({
    sources: [source],
    responses: {
      "https://learn.microsoft.com/azure/cosmos-db/sitemap.xml": { status: 404 },
      "https://learn.microsoft.com/sitemap.xml": { status: 404 },
      "https://learn.microsoft.com/azure/cosmos-db/": {
        status: 302,
        headers: { location: "https://evil.example/azure/cosmos-db/" },
      },
    },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].status, "indeterminate");
  assert.match(result.sources[0].reason, /untrusted hostname: evil\.example/);
  assert.equal(requests.includes("https://evil.example/azure/cosmos-db/"), false);
});

test("safe XML parsing rejects declarations and custom entities", () => {
  assert.throws(
    () => parseSafeXml('<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss>&xxe;</rss>'),
    /declarations and custom entities/,
  );
});

test("disabled, unconfigured, and keyless YouTube sources perform no requests", async () => {
  const { result, requests } = await runWithFixtures({
    sources: [
      youtubeSource("youtube-playlist", { id: "disabled", enabled: false }),
      youtubeSource("youtube-channel", { id: "keyless" }),
      { id: "youtube", type: "youtube-channel", endpoint: "https://www.youtube.com", enabled: true },
    ],
    responses: {},
    environment: {},
  });
  assert.deepEqual(requests, []);
  assert.deepEqual(
    result.sources.map((source) => source.status),
    ["skipped", "indeterminate", "skipped"],
  );
  assert.equal(result.sources[1].queried, false);
  assert.match(result.sources[1].reason, /YOUTUBE_API_KEY/);
  assert.equal(result.sources[2].reason, "immutable-youtube-source-id-required");
});

test("YouTube rejects a credential-bearing alternate endpoint without storing its key", async () => {
  const registryKey = "must-not-enter-the-report";
  const { result, requests } = await runWithFixtures({
    sources: [youtubeSource("youtube-playlist", {
      endpoint: `${YOUTUBE_API_ENDPOINT}?key=${registryKey}`,
    })],
    responses: {},
  });

  assert.deepEqual(requests, []);
  assert.equal(result.sources[0].status, "indeterminate");
  assert.equal(result.sources[0].queried, false);
  assert.equal(JSON.stringify(result).includes(registryKey), false);
  assert.equal(result.rejected[0].canonicalUrl, `https://www.youtube.com/playlist?list=${YOUTUBE_PLAYLIST_ID}`);
});

test("YouTube playlist discovery uses exact key-free endpoints and no transcript call", async () => {
  const playlistItemsUrl = youtubeApiUrl("playlistItems", {
    part: "contentDetails",
    playlistId: YOUTUBE_PLAYLIST_ID,
    maxResults: 50,
    fields: YOUTUBE_PLAYLIST_FIELDS,
  });
  const videosUrl = youtubeApiUrl("videos", {
    part: "contentDetails,snippet",
    id: "6IIUtEFKJec",
    fields: YOUTUBE_VIDEO_FIELDS,
  });
  const { result, requests, youtubeAuthentication } = await runWithFixtures({
    sources: [youtubeSource("youtube-playlist")],
    responses: {
      [playlistItemsUrl]: {
        body: { items: [{ contentDetails: { videoId: "6IIUtEFKJec" } }] },
      },
      [videosUrl]: {
        body: {
          items: [youtubeVideo("6IIUtEFKJec", { contentDetails: { caption: "true" } })],
        },
      },
    },
  });

  assert.deepEqual(requests, [playlistItemsUrl, videosUrl]);
  assert.ok(youtubeAuthentication.every(Boolean));
  assert.ok(requests.every((url) => !url.includes("key=")));
  assert.ok(requests.every((url) => !url.includes("captions")));
  assert.equal(result.status, "complete");
  assert.equal(result.sources[0].status, "succeeded");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].metadata.youtubeSourceType, "youtube-playlist");
  assert.equal(result.candidates[0].metadata.youtubeSourceId, YOUTUBE_PLAYLIST_ID);
  assert.equal(result.candidates[0].metadata.captionsAvailable, true);
  assert.equal(
    result.candidates[0].evidence.some((item) => item.type === "youtube-transcript"),
    false,
  );
});

test("YouTube channel discovery resolves only the channel's exact uploads playlist", async () => {
  const channelsUrl = youtubeApiUrl("channels", {
    part: "contentDetails",
    id: YOUTUBE_CHANNEL_ID,
    fields: "items(id,contentDetails/relatedPlaylists/uploads)",
  });
  const playlistItemsUrl = youtubeApiUrl("playlistItems", {
    part: "contentDetails",
    playlistId: YOUTUBE_UPLOADS_PLAYLIST_ID,
    maxResults: 50,
    fields: YOUTUBE_PLAYLIST_FIELDS,
  });
  const videosUrl = youtubeApiUrl("videos", {
    part: "contentDetails,snippet",
    id: "AbCdEfGhI12",
    fields: YOUTUBE_VIDEO_FIELDS,
  });
  const { result, requests } = await runWithFixtures({
    sources: [youtubeSource("youtube-channel")],
    responses: {
      [channelsUrl]: {
        body: {
          items: [{
            id: YOUTUBE_CHANNEL_ID,
            contentDetails: { relatedPlaylists: { uploads: YOUTUBE_UPLOADS_PLAYLIST_ID } },
          }],
        },
      },
      [playlistItemsUrl]: {
        body: { items: [{ contentDetails: { videoId: "AbCdEfGhI12" } }] },
      },
      [videosUrl]: { body: { items: [youtubeVideo("AbCdEfGhI12")] } },
    },
  });

  assert.deepEqual(requests, [channelsUrl, playlistItemsUrl, videosUrl]);
  assert.equal(result.sources[0].status, "succeeded");
  assert.equal(result.candidates[0].metadata.youtubeSourceType, "youtube-channel");
  assert.equal(result.candidates[0].metadata.youtubeSourceId, YOUTUBE_CHANNEL_ID);
});

test("YouTube official feed discovery uses one keyless request and preserves Atom metadata", async () => {
  const source = youtubeFeedSource();
  const parsed = parseYouTubeFeedXml(YOUTUBE_FEED_FIXTURE, source);
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(
    {
      id: parsed.videos[0].id,
      title: parsed.videos[0].snippet.title,
      description: parsed.videos[0].snippet.description,
      publishedAt: parsed.videos[0].snippet.publishedAt,
      updatedAt: parsed.videos[0].updatedAt,
      thumbnail: parsed.videos[0].snippet.thumbnails.high.url,
      author: parsed.videos[0].snippet.channelTitle,
      channelUrl: parsed.videos[0].channelUrl,
    },
    {
      id: "6IIUtEFKJec",
      title: "Build with Azure Cosmos DB",
      description: "Create a data application with Azure Cosmos DB for NoSQL.",
      publishedAt: "2026-08-26T10:00:00+00:00",
      updatedAt: "2026-08-27T11:00:00+00:00",
      thumbnail: "https://i4.ytimg.com/vi/6IIUtEFKJec/hqdefault.jpg",
      author: "SQLBits",
      channelUrl: `https://www.youtube.com/channel/${YOUTUBE_CHANNEL_ID}`,
    },
  );

  const { result, requests, youtubeAuthentication } = await runWithFixtures({
    sources: [source],
    responses: { [YOUTUBE_FEED_ENDPOINT]: { body: YOUTUBE_FEED_FIXTURE } },
    environment: {},
  });

  assert.deepEqual(requests, [YOUTUBE_FEED_ENDPOINT]);
  assert.deepEqual(youtubeAuthentication, []);
  assert.equal(result.status, "complete");
  assert.equal(result.sources[0].status, "succeeded");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.rejected[0].sourceId, "AbCdEfGhI12");
  assert.equal(result.rejected[0].reason, "insufficient-cosmos-evidence");
  assert.equal(result.candidates[0].modifiedAt, "2026-08-27T11:00:00.000Z");
  assert.equal(result.candidates[0].metadata.preview, "https://i4.ytimg.com/vi/6IIUtEFKJec/hqdefault.jpg");
  assert.equal(result.candidates[0].metadata.website, `https://www.youtube.com/channel/${YOUTUBE_CHANNEL_ID}`);
  assert.equal(result.candidates[0].metadata.author, "SQLBits");
  assert.deepEqual(result.candidates[0].metadata.tags, ["video"]);
});

test("YouTube official feed preserves valid entries and marks malformed entries indeterminate", async () => {
  const malformedEntries = `
    <entry><id>yt:video:not-valid</id><yt:videoId>not-valid</yt:videoId></entry>
    <entry>
      <id>yt:video:ZyXwVuTsRq1</id><yt:videoId>ZyXwVuTsRq1</yt:videoId>
      <yt:channelId>UC9999999999999999999999</yt:channelId>
    </entry>`;
  const body = YOUTUBE_FEED_FIXTURE.replace("</feed>", `${malformedEntries}</feed>`);
  const { result } = await runWithFixtures({
    sources: [youtubeFeedSource()],
    responses: { [YOUTUBE_FEED_ENDPOINT]: { body } },
    environment: {},
  });

  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].status, "indeterminate");
  assert.equal(result.candidates.length, 1);
  assert.match(result.sources[0].reason, /invalid yt:videoId/);
  assert.match(result.sources[0].reason, /channel ID does not match/);
  assert.equal(
    result.rejected.filter((item) => item.reason === "invalid-youtube-feed-entry").length,
    2,
  );
});

test("YouTube official feed rejects entities and oversized responses", async () => {
  const cases = [
    {
      body: '<!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><feed>&xxe;</feed>',
      limits: {},
      reason: /declarations and custom entities/,
    },
    {
      body: `<feed>${"x".repeat(512)}</feed>`,
      limits: { responseBytes: 128 },
      reason: /128 byte limit/,
    },
  ];
  for (const fixture of cases) {
    const { result, requests } = await runWithFixtures({
      sources: [youtubeFeedSource()],
      responses: { [YOUTUBE_FEED_ENDPOINT]: { body: fixture.body } },
      environment: {},
      limits: fixture.limits,
    });
    assert.deepEqual(requests, [YOUTUBE_FEED_ENDPOINT]);
    assert.equal(result.status, "partial");
    assert.equal(result.sources[0].status, "indeterminate");
    assert.match(result.sources[0].reason, fixture.reason);
    assert.equal(result.candidates.length, 0);
  }
});

test("YouTube candidate limit stops pagination before another quota call", async () => {
  const firstPageUrl = youtubeApiUrl("playlistItems", {
    part: "contentDetails",
    playlistId: YOUTUBE_PLAYLIST_ID,
    maxResults: 1,
    fields: YOUTUBE_PLAYLIST_FIELDS,
  });
  const videosUrl = youtubeApiUrl("videos", {
    part: "contentDetails,snippet",
    id: "6IIUtEFKJec",
    fields: YOUTUBE_VIDEO_FIELDS,
  });
  const { result, requests } = await runWithFixtures({
    sources: [youtubeSource("youtube-playlist")],
    responses: {
      [firstPageUrl]: {
        body: {
          nextPageToken: "NEXT_PAGE_MUST_NOT_BE_USED",
          items: [
            { contentDetails: { videoId: "6IIUtEFKJec" } },
            { contentDetails: { videoId: "AbCdEfGhI12" } },
          ],
        },
      },
      [videosUrl]: { body: { items: [youtubeVideo("6IIUtEFKJec")] } },
    },
    limits: { youtubeCandidates: 1 },
  });

  assert.deepEqual(requests, [firstPageUrl, videosUrl]);
  assert.equal(result.candidates.length, 1);
});

test("YouTube quota failure after a 50-video batch preserves partial candidates", async () => {
  const videoIds = Array.from({ length: 51 }, (_, index) => `YT${String(index).padStart(9, "0")}`);
  const firstBatch = videoIds.slice(0, 50);
  const secondBatch = videoIds.slice(50);
  const firstPageUrl = youtubeApiUrl("playlistItems", {
    part: "contentDetails",
    playlistId: YOUTUBE_PLAYLIST_ID,
    maxResults: 50,
    fields: YOUTUBE_PLAYLIST_FIELDS,
  });
  const secondPageUrl = youtubeApiUrl("playlistItems", {
    part: "contentDetails",
    playlistId: YOUTUBE_PLAYLIST_ID,
    maxResults: 1,
    pageToken: "PAGE_TWO",
    fields: YOUTUBE_PLAYLIST_FIELDS,
  });
  const firstVideosUrl = youtubeApiUrl("videos", {
    part: "contentDetails,snippet",
    id: firstBatch.join(","),
    fields: YOUTUBE_VIDEO_FIELDS,
  });
  const secondVideosUrl = youtubeApiUrl("videos", {
    part: "contentDetails,snippet",
    id: secondBatch.join(","),
    fields: YOUTUBE_VIDEO_FIELDS,
  });
  const apiKey = "quota-fixture-secret";
  const { result, requests } = await runWithFixtures({
    sources: [youtubeSource("youtube-playlist")],
    responses: {
      [firstPageUrl]: {
        body: {
          nextPageToken: "PAGE_TWO",
          items: firstBatch.map((videoId) => ({ contentDetails: { videoId } })),
        },
      },
      [secondPageUrl]: {
        body: { items: secondBatch.map((videoId) => ({ contentDetails: { videoId } })) },
      },
      [firstVideosUrl]: { body: { items: firstBatch.map((videoId) => youtubeVideo(videoId)) } },
      [secondVideosUrl]: {
        status: 403,
        body: { error: { errors: [{ reason: "quotaExceeded" }] } },
      },
    },
    environment: { YOUTUBE_API_KEY: apiKey },
    limits: {
      youtubePageSize: 50,
      youtubeListingPages: 2,
      youtubeCandidates: 51,
    },
  });

  assert.deepEqual(requests, [firstPageUrl, secondPageUrl, firstVideosUrl, secondVideosUrl]);
  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].status, "indeterminate");
  assert.match(result.sources[0].reason, /quotaExceeded/);
  assert.equal(result.candidates.length, 50);
  assert.equal(
    result.rejected.find((item) => item.sourceId === secondBatch[0]).reason,
    "youtube-video-indeterminate",
  );
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  assert.ok(result.sources[0].endpoints.every((url) => !url.includes("key=")));
});

test("RSS parsing preserves fetched site, author, timestamp, and image metadata", () => {
  const [entry] = parseFeedXml(`<?xml version="1.0"?>
    <rss version="2.0" xmlns:dc="urn:dc" xmlns:media="urn:media">
      <channel>
        <title>Azure Cosmos DB Blog</title>
        <link>https://devblogs.microsoft.com/cosmosdb/</link>
        <item>
          <guid>entry-1</guid>
          <link>https://devblogs.microsoft.com/cosmosdb/vector-search/</link>
          <title>Azure Cosmos DB vector search</title>
          <description>Azure Cosmos DB guidance.</description>
          <pubDate>Thu, 27 Aug 2026 09:00:00 GMT</pubDate>
          <author>Azure Cosmos DB Team</author>
          <media:thumbnail url="https://devblogs.microsoft.com/media/vector.png" />
        </item>
      </channel>
    </rss>`);

  assert.equal(entry.feedSiteUrl, "https://devblogs.microsoft.com/cosmosdb/");
  assert.equal(entry.author, "Azure Cosmos DB Team");
  assert.equal(entry.publishedAt, "Thu, 27 Aug 2026 09:00:00 GMT");
  assert.equal(entry.imageUrl, "https://devblogs.microsoft.com/media/vector.png");
});