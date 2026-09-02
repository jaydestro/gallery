const assert = require("node:assert/strict");
const test = require("node:test");

const { createTableRateLimiter } = require("../src/adapters/table-rate-limiter");
const { ApiError } = require("../src/domain/api-error");

function memoryTable() {
  let entity;
  let version = 0;
  return {
    get saved() {
      return entity;
    },
    async getEntity() {
      if (!entity) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return structuredClone(entity);
    },
    async createEntity(next) {
      if (entity) throw Object.assign(new Error("conflict"), { statusCode: 409 });
      version += 1;
      entity = { ...structuredClone(next), etag: `W/\"${version}\"` };
    },
    async updateEntity(next, mode, options) {
      assert.equal(mode, "Replace");
      if (options.etag !== entity?.etag) {
        throw Object.assign(new Error("stale"), { statusCode: 412 });
      }
      version += 1;
      entity = { ...structuredClone(next), etag: `W/\"${version}\"` };
    },
  };
}

test("allows 20 requests per minute without storing the raw client address", async () => {
  const tableClient = memoryTable();
  const limiter = createTableRateLimiter({ tableClient, now: () => 1_800_000 });
  for (let request = 0; request < 20; request += 1) {
    await limiter.consume("203.0.113.10");
  }

  assert.equal(tableClient.saved.minuteCount, 20);
  assert.equal(tableClient.saved.dayCount, 20);
  assert.equal(JSON.stringify(tableClient.saved).includes("203.0.113.10"), false);
  await assert.rejects(
    limiter.consume("203.0.113.10"),
    (error) => error instanceof ApiError && error.status === 429 && error.code === "RATE_LIMIT_EXCEEDED",
  );
});

test("allows 200 requests per day across minute windows", async () => {
  const tableClient = memoryTable();
  let currentTime = 0;
  const limiter = createTableRateLimiter({ tableClient, now: () => currentTime });
  for (let request = 0; request < 200; request += 1) {
    await limiter.consume("2001:db8::1");
    currentTime += 60_000;
  }

  await assert.rejects(
    limiter.consume("2001:db8::1"),
    (error) => error instanceof ApiError && error.status === 429 && error.code === "RATE_LIMIT_EXCEEDED",
  );
});

test("fails closed when the trusted client address is absent", async () => {
  const limiter = createTableRateLimiter({ tableClient: memoryTable() });
  await assert.rejects(
    limiter.consume(null),
    (error) => error instanceof ApiError && error.status === 400 && error.code === "CLIENT_IP_REQUIRED",
  );
});