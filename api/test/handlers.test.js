const assert = require("node:assert/strict");
const test = require("node:test");

const { createGalleryChatHandler } = require("../src/handlers/gallery-chat-handler");
const { createGalleryItemsHandler } = require("../src/handlers/gallery-items-handler");

const APIM_PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const ETAG = '"snapshot-etag"';
const rateLimiter = { async consume() {} };

function principalHeader(roles = ["Chat.Invoke"]) {
  return Buffer.from(JSON.stringify({
    claims: roles.map((role) => ({ typ: "roles", val: role })),
  })).toString("base64");
}

function request({ body, headers = {}, query = {}, signal } = {}) {
  const encoded = new TextEncoder().encode(body ?? "");
  return {
    headers: new Headers(headers),
    query: new URLSearchParams(query),
    signal,
    async arrayBuffer() {
      return encoded.buffer;
    },
  };
}

function context() {
  const errors = [];
  return { errors, error(...values) { errors.push(values); } };
}

test("GET handler returns cache metadata and a bodyless 304", async () => {
  const calls = [];
  const service = {
    async getItems(input) {
      calls.push(input);
      return {
        statusCode: input.ifNoneMatch === ETAG ? 304 : 200,
        items: input.ifNoneMatch === ETAG ? [] : [{ id: "alpha" }],
        continuationToken: null,
        metadata: { etag: ETAG, snapshotId: "snapshot", catalogHash: "hash", totalItems: 1 },
      };
    },
  };
  const handler = createGalleryItemsHandler({ service });
  const ok = await handler(request({ query: { pageSize: "25", continuationToken: "opaque" } }), context());
  const notModified = await handler(request({ headers: { "if-none-match": ETAG } }), context());

  assert.equal(ok.status, 200);
  assert.equal(ok.headers.ETag, ETAG);
  assert.equal(ok.jsonBody.items[0].id, "alpha");
  assert.deepEqual(calls[0], { pageSize: 25, continuationToken: "opaque", ifNoneMatch: null });
  assert.deepEqual(notModified, {
    status: 304,
    headers: { "Cache-Control": "public, max-age=60, must-revalidate", ETag: ETAG },
  });
});

test("GET handler maps invalid pagination and dependency failures", async () => {
  const validationHandler = createGalleryItemsHandler({ service: { async getItems() {} } });
  const invalid = await validationHandler(request({ query: { pageSize: "101" } }), context());
  assert.equal(invalid.status, 400);
  assert.equal(invalid.jsonBody.error.code, "PAGE_SIZE_INVALID");
  const invalidContinuation = await validationHandler(
    request({ query: { continuationToken: "line\nbreak" } }),
    context(),
  );
  assert.equal(invalidContinuation.status, 400);
  assert.equal(invalidContinuation.jsonBody.error.code, "CONTINUATION_TOKEN_INVALID");

  const dependencyContext = context();
  const dependencyHandler = createGalleryItemsHandler({
    service: { async getItems() { throw Object.assign(new Error("account details"), { statusCode: 429 }); } },
  });
  const unavailable = await dependencyHandler(request(), dependencyContext);
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.stringify({ unavailable, logs: dependencyContext.errors }).includes("account details"), false);
});

test("POST handler authorizes before parsing and returns only answer and trusted citations", async () => {
  const calls = [];
  const service = {
    async answer(input) {
      calls.push(input);
      return {
        answer: "Use Alpha.",
        citations: [{ id: "alpha", title: "Alpha", launchUrl: "https://example.test/alpha" }],
      };
    },
  };
  const handler = createGalleryChatHandler({ service, rateLimiter, expectedPrincipalId: APIM_PRINCIPAL_ID });
  const successContext = context();
  const response = await handler(request({
    body: '{"question":"Find Alpha"}',
    headers: {
      "content-type": "application/json",
      "x-gallery-client-ip": "203.0.113.10",
      "x-ms-client-principal-id": APIM_PRINCIPAL_ID,
      "x-ms-client-principal": principalHeader(),
    },
  }), successContext);

  assert.equal(response.status, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.deepEqual(response.jsonBody, {
    answer: "Use Alpha.",
    citations: [{ id: "alpha", title: "Alpha", launchUrl: "https://example.test/alpha" }],
  });
  assert.equal(calls[0].question, "Find Alpha");
  assert.deepEqual(successContext.errors, []);

  const unauthorized = await handler(request({
    body: '{"question":"secret question"}',
    headers: { "content-type": "application/json" },
  }), context());
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 1);
});

test("POST handler rejects history and does not log request content", async () => {
  const handler = createGalleryChatHandler({
    expectedPrincipalId: APIM_PRINCIPAL_ID,
    rateLimiter,
    service: { async answer() { throw new Error("must not run"); } },
  });
  const testContext = context();
  const response = await handler(request({
    body: '{"question":"secret question","history":["secret answer"]}',
    headers: {
      "content-type": "application/json",
      "x-gallery-client-ip": "203.0.113.10",
      "x-ms-client-principal-id": APIM_PRINCIPAL_ID,
      "x-ms-client-principal": principalHeader(),
    },
  }), testContext);

  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, "REQUEST_BODY_INVALID");
  const serialized = JSON.stringify({ response, logs: testContext.errors });
  assert.equal(serialized.includes("secret question"), false);
  assert.equal(serialized.includes("secret answer"), false);
});

test("POST handler accounts for the trusted APIM address before invoking the model", async () => {
  const calls = [];
  const handler = createGalleryChatHandler({
    expectedPrincipalId: APIM_PRINCIPAL_ID,
    rateLimiter: { async consume(clientIp) { calls.push(["limit", clientIp]); } },
    service: { async answer() { calls.push(["answer"]); return { answer: "ok", citations: [] }; } },
  });
  const response = await handler(request({
    body: '{"question":"Find a sample"}',
    headers: {
      "content-type": "application/json",
      "x-gallery-client-ip": "203.0.113.20",
      "x-ms-client-principal-id": APIM_PRINCIPAL_ID,
      "x-ms-client-principal": principalHeader(),
    },
  }), context());

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["limit", "203.0.113.20"], ["answer"]]);
});