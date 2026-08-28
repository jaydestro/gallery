import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixtureTransport,
  isAllowedGitHubEndpoint,
  parseSafeXml,
  runDiscovery,
} from "./discovery.mjs";

const DISCOVERED_AT = "2026-08-27T12:00:00Z";

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

function searchUrl(page, pageSize) {
  return githubApiUrl("/search/code", {
    q: "Microsoft.Azure.Cosmos org:AzureCosmosDB",
    sort: "indexed",
    order: "desc",
    per_page: String(pageSize),
    page: String(page),
  });
}

async function runWithFixtures({ sources, responses, activeCatalog = [], retiredCatalog = [], limits = {} }) {
  const transport = createFixtureTransport(responses);
  const result = await runDiscovery({
    trustedSources: { sources },
    activeCatalog,
    retiredCatalog,
    githubToken: "fixture-token",
    discoveredAt: DISCOVERED_AT,
    limits,
    fetchOptions: { fetchImpl: transport.fetchImpl, lookup: transport.lookup },
  });
  return { result, requests: transport.requests };
}

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items.join("")}</channel></rss>`;
}

function rssItem(id, slug) {
  return `<item><guid>${id}</guid><link>https://devblogs.microsoft.com/cosmosdb/${slug}/</link><title>Azure Cosmos DB ${slug}</title><description>Azure Cosmos DB guidance.</description></item>`;
}

test("GitHub endpoint allowlist permits only the configured org and selected content", () => {
  const context = { organization: "AzureCosmosDB" };
  assert.equal(
    isAllowedGitHubEndpoint("https://api.github.com/orgs/AzureCosmosDB/repos?page=1", context),
    true,
  );
  assert.equal(
    isAllowedGitHubEndpoint(
      "https://api.github.com/search/code?q=CosmosClient+org%3AAzureCosmosDB",
      context,
    ),
    true,
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
    true,
  );
  assert.equal(
    isAllowedGitHubEndpoint(
      "https://api.github.com/repos/AzureCosmosDB/demo/contents/.github/workflows/release.yml",
      { ...context, repository: "demo", contentPath: "package.json" },
    ),
    false,
  );
});

test("GitHub pagination stops at configured listing and search page limits", async () => {
  const responses = {
    [listingUrl(1, 1)]: { body: [githubRepository(1)] },
    [listingUrl(2, 1)]: { body: [githubRepository(2)] },
    [searchUrl(1, 1)]: {
      body: { total_count: 2, incomplete_results: false, items: [
        { path: "unselected.txt", url: "https://api.github.com/user", repository: githubRepository(1) },
      ] },
    },
  };
  const { result, requests } = await runWithFixtures({
    sources: [githubSource()],
    responses,
    limits: {
      githubPageSize: 1,
      githubListingPages: 2,
      githubSearchPages: 1,
      githubRepositories: 2,
      githubSearchQueries: 1,
      githubFilesPerRepository: 1,
    },
  });

  assert.equal(requests.includes(listingUrl(3, 1)), false);
  assert.equal(requests.includes(searchUrl(2, 1)), false);
  assert.equal(requests.includes("https://api.github.com/user"), false);
  assert.equal(result.sources[0].status, "indeterminate");
  assert.match(result.sources[0].reason, /non-allowlisted GitHub endpoint/);
});

test("GitHub does not accept a repository from a Cosmos DB keyword alone", async () => {
  const repository = githubRepository(10, { description: "Mentions Azure Cosmos DB once" });
  const responses = {
    [listingUrl(1, 2)]: { body: [repository] },
    [searchUrl(1, 2)]: { body: { total_count: 0, incomplete_results: false, items: [] } },
    "https://api.github.com/repos/AzureCosmosDB/repository-10/readme": { status: 404 },
  };
  const { result } = await runWithFixtures({
    sources: [githubSource()],
    responses,
    limits: {
      githubPageSize: 2,
      githubListingPages: 1,
      githubSearchPages: 1,
      githubRepositories: 2,
      githubSearchQueries: 1,
      githubFilesPerRepository: 1,
    },
  });

  assert.equal(result.status, "complete");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0].reason, "insufficient-cosmos-evidence");
  assert.equal(result.rejected[0].sourceId, "10");
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
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].status, "indeterminate");
  assert.equal(result.candidates.length, 0);
});

test("safe XML parsing rejects declarations and custom entities", () => {
  assert.throws(
    () => parseSafeXml('<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss>&xxe;</rss>'),
    /declarations and custom entities/,
  );
});

test("disabled and unconfigured YouTube sources perform no requests", async () => {
  const { result, requests } = await runWithFixtures({
    sources: [
      { id: "disabled", type: "rss-feed", endpoint: "https://example.com/feed", enabled: false },
      { id: "youtube", type: "youtube-channel", endpoint: "https://www.youtube.com", enabled: true },
    ],
    responses: {},
  });
  assert.deepEqual(requests, []);
  assert.deepEqual(result.sources.map((source) => source.status), ["skipped", "skipped"]);
  assert.equal(result.sources[1].reason, "immutable-youtube-source-id-required");
});