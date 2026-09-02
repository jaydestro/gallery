const CATALOG_PARTITION = "gallery";
const PUBLIC_QUERY_PREFIX = "SELECT * FROM c WHERE c.catalogPartition = @catalogPartition AND c.type = @type AND c.snapshotId = @snapshotId AND c.publicationStatus = @publicationStatus AND (c.lifecycleStatus = @activeStatus OR c.lifecycleStatus = @reviewStatus)";

function queryParameters(snapshotId) {
  return [
    { name: "@catalogPartition", value: CATALOG_PARTITION },
    { name: "@type", value: "catalog-item" },
    { name: "@snapshotId", value: snapshotId },
    { name: "@publicationStatus", value: "published" },
    { name: "@activeStatus", value: "active" },
    { name: "@reviewStatus", value: "needs-review" },
  ];
}

function normalizedPage(response) {
  return {
    resources: response?.resources ?? [],
    continuationToken: response?.continuationToken || null,
  };
}

function validateContextRequest(terms, maxItems) {
  if (
    !Array.isArray(terms) ||
    terms.length < 1 ||
    terms.length > 8 ||
    terms.some((term) => typeof term !== "string" || term.length < 1 || term.length > 64) ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 20
  ) {
    throw new TypeError("Context queries require 1-8 bounded terms and at most 20 items.");
  }
}

function createCosmosPublicCatalogRepository(container) {
  if (!container?.items || typeof container.item !== "function") {
    throw new TypeError("An @azure/cosmos Container-compatible object is required.");
  }
  return Object.freeze({
    async readActiveSnapshot() {
      const response = await container.item("active-snapshot", CATALOG_PARTITION).read();
      return {
        resource: response?.resource ?? null,
        etag: response?.headers?.etag ?? response?.resource?._etag ?? null,
      };
    },

    async querySnapshotPage({ snapshotId, pageSize, continuationToken }) {
      const iterator = container.items.query(
        {
          query: `${PUBLIC_QUERY_PREFIX} ORDER BY c.displayOrder ASC, c.catalogId ASC`,
          parameters: queryParameters(snapshotId),
        },
        {
          partitionKey: CATALOG_PARTITION,
          continuationToken: continuationToken || undefined,
          maxItemCount: pageSize,
        },
      );
      return normalizedPage(await iterator.fetchNext());
    },

    async querySnapshotContext({ snapshotId, terms, maxItems = 20 }) {
      validateContextRequest(terms, maxItems);
      const termPredicates = terms.map((_, index) => (
        `(CONTAINS(LOWER(c.title), @term${index}) OR ` +
        `CONTAINS(LOWER(c.summary), @term${index}) OR ` +
        `EXISTS(SELECT VALUE tag FROM tag IN c.tags WHERE CONTAINS(LOWER(tag), @term${index})))`
      ));
      const iterator = container.items.query(
        {
          query: `SELECT TOP ${maxItems} * FROM c WHERE ` +
            `${PUBLIC_QUERY_PREFIX.slice("SELECT * FROM c WHERE ".length)} AND ` +
            `(${termPredicates.join(" OR ")}) ORDER BY c.displayOrder ASC, c.catalogId ASC`,
          parameters: [
            ...queryParameters(snapshotId),
            ...terms.map((term, index) => ({ name: `@term${index}`, value: term })),
          ],
        },
        { partitionKey: CATALOG_PARTITION, maxItemCount: maxItems },
      );
      return normalizedPage(await iterator.fetchNext());
    },
  });
}

module.exports = { CATALOG_PARTITION, PUBLIC_QUERY_PREFIX, createCosmosPublicCatalogRepository };