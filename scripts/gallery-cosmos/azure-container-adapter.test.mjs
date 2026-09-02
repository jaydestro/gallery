import assert from "node:assert/strict";
import test from "node:test";

import { createAzureContainerAdapter } from "./azure-container-adapter.mjs";

test("maps the domain port to Azure create, point-read, ETag replace, and paged query calls", async () => {
  const calls = [];
  const container = {
    items: {
      async create(document, options) {
        calls.push({ method: "create", document, options });
        return { resource: { ...document, _etag: "\"created\"" }, statusCode: 201 };
      },
      query(specification, options) {
        calls.push({ method: "query", specification, options });
        return {
          async fetchNext() {
            return { resources: [{ id: "one" }], continuationToken: "next", requestCharge: 2.5 };
          },
        };
      },
    },
    item(id, partitionKey) {
      return {
        async read() {
          calls.push({ method: "read", id, partitionKey });
          return { resource: { id, _etag: "\"read\"" }, statusCode: 200 };
        },
        async replace(document, options) {
          calls.push({ method: "replace", id, partitionKey, document, options });
          return { resource: { ...document, _etag: "\"replaced\"" }, statusCode: 200 };
        },
      };
    },
  };
  const adapter = createAzureContainerAdapter(container);

  const created = await adapter.createItem({ id: "one", catalogPartition: "gallery" }, {
    partitionKey: "gallery",
    ifNoneMatch: "*",
  });
  const read = await adapter.readItem("one", { partitionKey: "gallery" });
  const replaced = await adapter.replaceItem("one", { id: "one", catalogPartition: "gallery" }, {
    partitionKey: "gallery",
    ifMatch: "\"read\"",
  });
  const page = await adapter.queryItems({
    query: "SELECT * FROM c",
    parameters: [],
    partitionKey: "gallery",
    continuationToken: "prior",
    maxItemCount: 10,
  });

  assert.deepEqual(calls[0].options, {
    accessCondition: { type: "IfNoneMatch", condition: "*" },
  });
  assert.deepEqual(calls[2].options, {
    accessCondition: { type: "IfMatch", condition: "\"read\"" },
  });
  assert.equal(calls[3].options.continuationToken, "prior");
  assert.equal(calls[3].options.maxItemCount, 10);
  assert.equal(created.etag, "\"created\"");
  assert.equal(read.etag, "\"read\"");
  assert.equal(replaced.etag, "\"replaced\"");
  assert.deepEqual(page, {
    resources: [{ id: "one" }],
    continuationToken: "next",
    requestCharge: 2.5,
  });
});

test("rejects objects that do not expose the Azure Container surface", () => {
  assert.throws(() => createAzureContainerAdapter({}), /Container-compatible/);
});