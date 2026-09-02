const assert = require("node:assert/strict");
const test = require("node:test");

const { createCosmosPublicCatalogRepository } = require("../src/adapters/cosmos-public-catalog-repository");
const { authorizeEasyAuth } = require("../src/auth/easy-auth");
const { ApiError } = require("../src/domain/api-error");
const { readChatRequest } = require("../src/http/request");
const { errorResponse, mappedError } = require("../src/http/responses");
const { loadRuntimeConfig } = require("../src/runtime/config");

const APIM_PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";

function principalHeader(roles = ["Chat.Invoke"]) {
  return Buffer.from(JSON.stringify({
    claims: roles.map((role) => ({ typ: "roles", val: role })),
  })).toString("base64");
}

function requestFor(body, headers = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    headers: new Headers({ "content-type": "application/json", ...headers }),
    async arrayBuffer() {
      return bytes.buffer;
    },
  };
}

test("requires the configured APIM principal and Chat.Invoke role", () => {
  const headers = new Headers({
    "x-ms-client-principal-id": APIM_PRINCIPAL_ID,
    "x-ms-client-principal": principalHeader(),
  });
  assert.deepEqual(authorizeEasyAuth({ headers, expectedPrincipalId: APIM_PRINCIPAL_ID }), {
    principalId: APIM_PRINCIPAL_ID,
    role: "Chat.Invoke",
  });
  assert.throws(
    () => authorizeEasyAuth({
      headers: new Headers({
        "x-ms-client-principal-id": APIM_PRINCIPAL_ID,
        "x-ms-client-principal": principalHeader(["Reader"]),
      }),
      expectedPrincipalId: APIM_PRINCIPAL_ID,
    }),
    (error) => error instanceof ApiError && error.status === 403 && error.code === "ROLE_FORBIDDEN",
  );
  assert.throws(
    () => authorizeEasyAuth({ headers, expectedPrincipalId: "22222222-2222-4222-8222-222222222222" }),
    (error) => error instanceof ApiError && error.status === 403 && error.code === "PRINCIPAL_FORBIDDEN",
  );
});

test("accepts only a bounded question-only JSON body", async () => {
  assert.deepEqual(await readChatRequest(requestFor('{"question":"  How do I start?  "}')), {
    question: "How do I start?",
  });
  await assert.rejects(
    readChatRequest(requestFor('{"question":"Hi","history":[]}')),
    (error) => error instanceof ApiError && error.code === "REQUEST_BODY_INVALID",
  );
  await assert.rejects(
    readChatRequest(requestFor('{"question":"Hi"}', { "content-length": "9000" })),
    (error) => error instanceof ApiError && error.status === 413,
  );
  await assert.rejects(
    readChatRequest(requestFor(JSON.stringify({ question: "x".repeat(8192) }))),
    (error) => error instanceof ApiError && error.status === 413,
  );
});

test("Cosmos adapter point-reads the marker and bounds context to the exact snapshot", async () => {
  const calls = [];
  const container = {
    item(id, partitionKey) {
      calls.push({ method: "item", id, partitionKey });
      return {
        async read() {
          return { resource: { id }, headers: { etag: '"etag"' } };
        },
      };
    },
    items: {
      query(specification, options) {
        calls.push({ method: "query", specification, options });
        return { async fetchNext() { return { resources: [], continuationToken: null }; } };
      },
    },
  };
  const repository = createCosmosPublicCatalogRepository(container);
  assert.deepEqual(await repository.readActiveSnapshot(), {
    resource: { id: "active-snapshot" },
    etag: '"etag"',
  });
  await repository.querySnapshotContext({
    snapshotId: "snapshot-42",
    terms: ["cosmos", "vector"],
    maxItems: 20,
  });
  assert.deepEqual(calls[0], { method: "item", id: "active-snapshot", partitionKey: "gallery" });
  const queryCall = calls[1];
  assert.match(queryCall.specification.query, /^SELECT TOP 20 \*/);
  assert.equal(queryCall.options.maxItemCount, 20);
  assert.equal(
    queryCall.specification.parameters.find(({ name }) => name === "@snapshotId").value,
    "snapshot-42",
  );
  assert.deepEqual(
    queryCall.specification.parameters.filter(({ name }) => name.startsWith("@term")),
    [
      { name: "@term0", value: "cosmos" },
      { name: "@term1", value: "vector" },
    ],
  );
});

test("runtime configuration is credential-free and fail-closed", () => {
  const config = loadRuntimeConfig({
    AZURE_CLIENT_ID: APIM_PRINCIPAL_ID,
    AZURE_COSMOS_ENDPOINT: "https://gallery.documents.azure.com/",
    AZURE_COSMOS_DATABASE: "gallery",
    AZURE_COSMOS_PUBLIC_CONTAINER: "public-catalog",
    AZURE_STORAGE_ACCOUNT_NAME: "gallerystorage",
    GALLERY_RATE_LIMIT_TABLE: "gallerychatlimits",
    AZURE_FOUNDRY_ENDPOINT: "https://gallery.services.ai.azure.com/",
    AZURE_FOUNDRY_DEPLOYMENT: "gallery-mai-thinking-1",
    GALLERY_APIM_PRINCIPAL_ID: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(config.cosmosEndpoint, "https://gallery.documents.azure.com");
  assert.equal(Object.keys(config).some((name) => /key|secret|token|connection/i.test(name)), false);
  assert.throws(
    () => loadRuntimeConfig({}),
    (error) => error instanceof ApiError && error.code === "CONFIGURATION_INVALID",
  );
});

test("error mapping never exposes exception messages or secrets", () => {
  const logs = [];
  const context = { error(...values) { logs.push(values); } };
  const response = errorResponse(new Error("secret-token question text"), context);
  assert.deepEqual(mappedError({ statusCode: 429 }), {
    status: 503,
    code: "DEPENDENCY_UNAVAILABLE",
    message: "The gallery service is temporarily unavailable.",
  });
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify({ response, logs }).includes("secret-token"), false);
  assert.equal(JSON.stringify({ response, logs }).includes("question text"), false);
});