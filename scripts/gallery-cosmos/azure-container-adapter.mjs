function accessCondition(type, condition) {
  return condition ? { accessCondition: { type, condition } } : {};
}

function normalizeResponse(response) {
  return {
    resource: response?.resource ?? null,
    etag: response?.headers?.etag ?? response?.resource?._etag ?? null,
    statusCode: response?.statusCode ?? null,
    requestCharge: response?.requestCharge ?? response?.headers?.["x-ms-request-charge"] ?? null,
  };
}

export function createAzureContainerAdapter(container) {
  if (!container?.items || typeof container.item !== "function") {
    throw new TypeError("An @azure/cosmos Container-compatible object is required.");
  }
  return Object.freeze({
    async createItem(document, { ifNoneMatch } = {}) {
      return normalizeResponse(await container.items.create(
        document,
        accessCondition("IfNoneMatch", ifNoneMatch),
      ));
    },
    async readItem(id, { partitionKey } = {}) {
      return normalizeResponse(await container.item(id, partitionKey).read());
    },
    async replaceItem(id, document, { partitionKey, ifMatch } = {}) {
      return normalizeResponse(await container.item(id, partitionKey).replace(
        document,
        accessCondition("IfMatch", ifMatch),
      ));
    },
    async queryItems({ query, parameters, partitionKey, continuationToken, maxItemCount }) {
      const iterator = container.items.query(
        { query, parameters },
        {
          partitionKey,
          continuationToken: continuationToken || undefined,
          maxItemCount,
        },
      );
      const response = await iterator.fetchNext();
      return {
        resources: response.resources ?? [],
        continuationToken: response.continuationToken || null,
        requestCharge: response.requestCharge ?? response.headers?.["x-ms-request-charge"] ?? null,
      };
    },
  });
}