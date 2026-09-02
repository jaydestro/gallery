const assert = require("node:assert/strict");
const test = require("node:test");

const { ApiError } = require("../src/domain/api-error");
const {
  MAX_COMPLETION_TOKENS,
  MAX_CONTEXT_ITEMS,
  MAX_SEARCH_TERMS,
  createGalleryChatService,
  extractSearchTerms,
} = require("../src/services/gallery-chat-service");

const HASH = `sha256:${"b".repeat(64)}`;

function markerResponse() {
  return {
    resource: {
      id: "active-snapshot",
      type: "active-snapshot",
      schemaVersion: "1.0.0",
      catalogPartition: "gallery",
      snapshotId: "snapshot-chat",
      itemCount: 1,
      catalogHash: HASH,
      operationId: "publish-chat",
      publishedAt: "2026-08-28T00:00:00.000Z",
    },
    etag: '"chat-etag"',
  };
}

function publicItem() {
  return {
    id: "snapshot-chat:alpha",
    catalogId: "alpha",
    type: "catalog-item",
    schemaVersion: "2.0.0",
    catalogPartition: "gallery",
    snapshotId: "snapshot-chat",
    publicationStatus: "published",
    displayOrder: 1,
    title: "Cosmos starter",
    summary: "A sample using Azure Cosmos DB.",
    preview: "/img/alpha.png",
    launchUrl: "https://example.test/alpha",
    canonicalSource: "https://github.com/example/alpha",
    sourceType: "github-repository",
    author: "Example",
    sourceOwner: "example",
    website: "https://example.test/alpha",
    tags: ["Cosmos DB", "JavaScript"],
    publishedAt: "2026-08-01",
    dateAdded: "2026-08-02",
    lastVerified: "2026-08-28T00:00:00.000Z",
    lifecycleStatus: "active",
    supersededBy: null,
    operationId: "publish-chat",
    sourceItemHash: HASH,
  };
}

function chatFixture(modelOutput = '{"answer":"Use the starter.","citationIds":["alpha"]}') {
  const calls = [];
  let persistenceCalls = 0;
  const publicCatalogRepository = {
    async readActiveSnapshot() {
      calls.push({ method: "readActiveSnapshot" });
      return markerResponse();
    },
    async querySnapshotContext(request) {
      calls.push({ method: "querySnapshotContext", request });
      return { resources: [publicItem()], continuationToken: null };
    },
    async createItem() {
      persistenceCalls += 1;
      throw new Error("Chat must not persist data.");
    },
  };
  const modelClient = {
    async complete(request) {
      calls.push({ method: "complete", request });
      return modelOutput;
    },
  };
  return { calls, modelClient, publicCatalogRepository, persistenceCalls: () => persistenceCalls };
}

test("uses bounded active-snapshot context and resolves citations from trusted records", async () => {
  const fixture = chatFixture();
  const service = createGalleryChatService({
    publicCatalogRepository: fixture.publicCatalogRepository,
    modelClient: fixture.modelClient,
  });

  const result = await service.answer({ question: "Show me a JavaScript Cosmos DB starter" });

  assert.deepEqual(result, {
    answer: "Use the starter.",
    citations: [{ id: "alpha", title: "Cosmos starter", launchUrl: "https://example.test/alpha" }],
  });
  assert.deepEqual(fixture.calls[1], {
    method: "querySnapshotContext",
    request: {
      snapshotId: "snapshot-chat",
      terms: ["javascript", "cosmos", "db", "starter"],
      maxItems: MAX_CONTEXT_ITEMS,
    },
  });
  const modelRequest = fixture.calls[2].request;
  assert.equal(modelRequest.maxCompletionTokens, MAX_COMPLETION_TOKENS);
  const modelInput = JSON.parse(modelRequest.input);
  assert.equal(modelInput.trustBoundary, "UNTRUSTED_CATALOG_CONTEXT");
  assert.equal(Object.hasOwn(modelInput, "history"), false);
  assert.equal(Object.hasOwn(modelInput, "messages"), false);
  assert.deepEqual(Object.keys(modelInput.catalogItems[0]).sort(), [
    "author", "id", "launchUrl", "sourceType", "summary", "tags", "title",
  ]);
  assert.equal(fixture.persistenceCalls(), 0);
});

test("rejects invented citations and over-bound Cosmos context", async () => {
  const invented = chatFixture('{"answer":"Invented.","citationIds":["missing"]}');
  const inventedService = createGalleryChatService({
    publicCatalogRepository: invented.publicCatalogRepository,
    modelClient: invented.modelClient,
  });
  await assert.rejects(
    inventedService.answer({ question: "Cosmos sample" }),
    (error) => error instanceof ApiError && error.code === "MODEL_OUTPUT_INVALID",
  );

  const oversized = chatFixture();
  oversized.publicCatalogRepository.querySnapshotContext = async () => ({
    resources: Array.from({ length: 21 }, publicItem),
    continuationToken: null,
  });
  const oversizedService = createGalleryChatService({
    publicCatalogRepository: oversized.publicCatalogRepository,
    modelClient: oversized.modelClient,
  });
  await assert.rejects(
    oversizedService.answer({ question: "Cosmos sample" }),
    (error) => error instanceof ApiError && error.code === "UPSTREAM_RESPONSE_INVALID",
  );
});

test("search terms are normalized, deduplicated, and capped", () => {
  const terms = extractSearchTerms("The COSMOS cosmos vector JavaScript Python Go Rust .NET C# SDK sample");
  assert.equal(terms[0], "cosmos");
  assert.equal(new Set(terms).size, terms.length);
  assert(terms.length <= MAX_SEARCH_TERMS);
});