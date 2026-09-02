const assert = require("node:assert/strict");
const test = require("node:test");

const { createGalleryItemsService } = require("../src/services/gallery-items-service");

const HASH = `sha256:${"a".repeat(64)}`;

function activeMarker() {
  return {
    resource: {
      id: "active-snapshot",
      type: "active-snapshot",
      schemaVersion: "1.0.0",
      catalogPartition: "gallery",
      snapshotId: "snapshot-42",
      itemCount: 2,
      catalogHash: HASH,
      operationId: "publish-42",
      publishedAt: "2026-08-28T00:00:00.000Z",
      _etag: '"marker-etag"',
    },
    etag: '"marker-etag"',
  };
}

function publicItem(catalogId, displayOrder) {
  return {
    id: `snapshot-42:${catalogId}`,
    catalogId,
    type: "catalog-item",
    schemaVersion: "2.0.0",
    catalogPartition: "gallery",
    snapshotId: "snapshot-42",
    publicationStatus: "published",
    displayOrder,
    title: `Title ${catalogId}`,
    summary: `Summary ${catalogId}`,
    preview: `/img/${catalogId}.png`,
    launchUrl: `https://example.test/${catalogId}`,
    canonicalSource: `https://github.com/example/${catalogId}`,
    sourceType: "github-repository",
    author: "Example",
    sourceOwner: "example",
    website: `https://example.test/${catalogId}`,
    tags: ["Cosmos DB"],
    publishedAt: "2026-08-01",
    dateAdded: "2026-08-02",
    lastVerified: "2026-08-28T00:00:00.000Z",
    lifecycleStatus: "active",
    supersededBy: null,
    operationId: "publish-42",
    sourceItemHash: HASH,
    _etag: `"${catalogId}-etag"`,
  };
}

function fixtureRepository() {
  const calls = [];
  const repository = {
    async readActiveSnapshot() {
      calls.push({ method: "readActiveSnapshot" });
      return activeMarker();
    },
    async querySnapshotPage(request) {
      calls.push({ method: "querySnapshotPage", request });
      if (!request.continuationToken) {
        return { resources: [publicItem("alpha", 1)], continuationToken: "opaque-next" };
      }
      return { resources: [publicItem("beta", 2)], continuationToken: null };
    },
  };
  return { calls, repository };
}

test("paginates only the active snapshot and returns public fields", async () => {
  const fixture = fixtureRepository();
  const service = createGalleryItemsService({ publicCatalogRepository: fixture.repository });

  const first = await service.getItems({ pageSize: 1 });
  const second = await service.getItems({ pageSize: 1, continuationToken: first.continuationToken });

  assert.deepEqual(first.items.map(({ id }) => id), ["alpha"]);
  assert.deepEqual(second.items.map(({ id }) => id), ["beta"]);
  assert.equal(first.continuationToken, "opaque-next");
  assert.deepEqual(first.metadata, {
    etag: '"marker-etag"',
    snapshotId: "snapshot-42",
    catalogHash: HASH,
    totalItems: 2,
  });
  assert.deepEqual(fixture.calls[1], {
    method: "querySnapshotPage",
    request: { snapshotId: "snapshot-42", pageSize: 1, continuationToken: null },
  });
  assert.deepEqual(fixture.calls[3], {
    method: "querySnapshotPage",
    request: { snapshotId: "snapshot-42", pageSize: 1, continuationToken: "opaque-next" },
  });
  assert.equal(Object.hasOwn(first.items[0], "snapshotId"), false);
  assert.equal(Object.hasOwn(first.items[0], "operationId"), false);
  assert.equal(Object.keys(first.items[0]).some((key) => key.startsWith("_")), false);
});

test("returns 304 after the marker point read without querying items", async () => {
  const fixture = fixtureRepository();
  const service = createGalleryItemsService({ publicCatalogRepository: fixture.repository });

  const result = await service.getItems({ ifNoneMatch: 'W/"marker-etag"' });

  assert.equal(result.statusCode, 304);
  assert.deepEqual(result.items, []);
  assert.equal(result.continuationToken, null);
  assert.deepEqual(fixture.calls, [{ method: "readActiveSnapshot" }]);
});

test("fails closed on malformed Cosmos marker and item output", async () => {
  const malformedMarker = fixtureRepository();
  malformedMarker.repository.readActiveSnapshot = async () => ({
    ...activeMarker(),
    resource: { ...activeMarker().resource, publishedAt: "August 28, 2026" },
  });
  await assert.rejects(
    createGalleryItemsService({ publicCatalogRepository: malformedMarker.repository }).getItems(),
    (error) => error.code === "UPSTREAM_RESPONSE_INVALID" && error.status === 502,
  );

  const malformedItem = fixtureRepository();
  malformedItem.repository.querySnapshotPage = async () => ({
    resources: [{ ...publicItem("alpha", 1), publicationStatus: "draft" }],
    continuationToken: null,
  });
  await assert.rejects(
    createGalleryItemsService({ publicCatalogRepository: malformedItem.repository }).getItems(),
    (error) => error.code === "UPSTREAM_RESPONSE_INVALID" && error.status === 502,
  );
});