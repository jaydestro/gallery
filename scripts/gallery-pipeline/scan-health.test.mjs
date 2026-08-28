import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkGitHubSource,
  checkHttpSource,
  parseArguments,
  runHealthScan,
} from "./scan-health.mjs";
import { loadValidationContext } from "./validation.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIRECTORY, "../..");
const FIXTURE = path.join(TEST_DIRECTORY, "fixtures", "health");
const publicLookup = async () => [{ address: "20.12.34.56", family: 4 }];
const policy = {
  contractVersions: { health: "1.0.0" },
  http: { timeoutSeconds: 1, maxRedirects: 2 },
  lifecycle: { requiredConfirmations: 2, retirementGraceDays: 30 },
};

function responseFetch(definitions, calls = []) {
  return async (input, init = {}) => {
    const key = `${init.method ?? "GET"} ${new URL(input).toString()}`;
    calls.push(key);
    const definition = definitions[key];
    if (!definition) throw new Error(`Unexpected request: ${key}`);
    const body = init.method === "HEAD" || definition.body === undefined
      ? null
      : JSON.stringify(definition.body);
    return new Response(body, { status: definition.status, headers: definition.headers });
  };
}

test("argument parsing is dry-run by default and rejects fixture writes", () => {
  assert.deepEqual(parseArguments([]), {
    write: false,
    fixturePath: null,
    rootDir: process.cwd(),
    checkedAt: null,
    concurrency: 6,
  });
  assert.throws(() => parseArguments(["--fixtures", "--write"]), /cannot be combined/);
  assert.throws(() => parseArguments(["--concurrency", "0"]), /positive integer/);
});

test("HTTP checks fall back from unsupported HEAD to GET and keep rate limits indeterminate", async () => {
  const fallbackCalls = [];
  const fallback = await checkHttpSource("https://example.com/resource", {
    policy,
    lookup: publicLookup,
    fetchImpl: responseFetch({
      "HEAD https://example.com/resource": { status: 405 },
      "GET https://example.com/resource": { status: 200 },
    }, fallbackCalls),
  });
  assert.equal(fallback.classification, "healthy");
  assert.deepEqual(fallbackCalls, [
    "HEAD https://example.com/resource",
    "GET https://example.com/resource",
  ]);

  const rateLimitCalls = [];
  const rateLimited = await checkHttpSource("https://example.com/limited", {
    policy,
    lookup: publicLookup,
    fetchImpl: responseFetch({
      "HEAD https://example.com/limited": { status: 429 },
    }, rateLimitCalls),
  });
  assert.equal(rateLimited.classification, "indeterminate");
  assert.equal(rateLimited.reason, "SOURCE_HTTP_429");
  assert.equal(rateLimitCalls.length, 1);
});

test("HTTP checks fail closed for partial and malformed responses", async () => {
  const partial = await checkHttpSource("https://example.com/partial", {
    policy,
    lookup: publicLookup,
    fetchImpl: responseFetch({
      "HEAD https://example.com/partial": { status: 206 },
    }),
  });
  assert.equal(partial.classification, "indeterminate");
  assert.equal(partial.reason, "SOURCE_PARTIAL_RESPONSE");

  const malformed = await checkHttpSource("https://example.com/malformed", {
    policy,
    lookup: publicLookup,
    fetchImpl: async () => ({
      status: undefined,
      statusText: "",
      headers: new Headers(),
      body: null,
    }),
  });
  assert.equal(malformed.classification, "indeterminate");
  assert.equal(malformed.reason, "SOURCE_RESPONSE_MALFORMED");
});

test("HTTP checks recover from transient failures using injected retry delays", async () => {
  const statuses = [503, 200];
  const delays = [];
  let calls = 0;
  const result = await checkHttpSource("https://example.com/recovery", {
    policy: {
      ...policy,
      http: { ...policy.http, retryDelaySeconds: [0, 5, 30, 120] },
    },
    lookup: publicLookup,
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      const status = statuses[calls];
      calls += 1;
      return new Response(null, { status });
    },
  });

  assert.equal(result.classification, "healthy");
  assert.equal(result.statusCode, 200);
  assert.equal(result.retryAttempts, 1);
  assert.deepEqual(result.retryReasons, ["SOURCE_HTTP_503"]);
  assert.deepEqual(delays, [5_000]);
  assert.equal(calls, 2);
  assert.deepEqual(
    result.evidence.filter((item) => item.kind === "availability-retry"),
    [{ kind: "availability-retry", value: "retry 1 after SOURCE_HTTP_503; delay 5s" }],
  );
});

test("HTTP checks fail closed after exhausting the configured retry envelope", async () => {
  const delays = [];
  let calls = 0;
  const result = await checkHttpSource("https://example.com/exhausted", {
    policy: {
      ...policy,
      http: { ...policy.http, retryDelaySeconds: [0, 5, 30, 120] },
    },
    lookup: publicLookup,
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
  });

  assert.equal(result.classification, "indeterminate");
  assert.equal(result.reason, "SOURCE_HTTP_503");
  assert.equal(result.retryAttempts, 3);
  assert.deepEqual(result.retryReasons, [
    "SOURCE_HTTP_503",
    "SOURCE_HTTP_503",
    "SOURCE_HTTP_503",
  ]);
  assert.deepEqual(delays, [5_000, 30_000, 120_000]);
  assert.equal(calls, 4);
});

test("HTTP checks cap Retry-After at the policy maximum without real waiting", async () => {
  const delays = [];
  let calls = 0;
  const result = await checkHttpSource("https://example.com/rate-limited", {
    policy: {
      ...policy,
      http: { ...policy.http, retryDelaySeconds: [0, 5, 30] },
    },
    lookup: publicLookup,
    delay: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 429, headers: { "Retry-After": "600" } })
        : new Response(null, { status: 200 });
    },
  });

  assert.equal(result.classification, "healthy");
  assert.equal(result.retryAttempts, 1);
  assert.deepEqual(delays, [30_000]);
  assert.equal(calls, 2);
});

test("HTTP checks do not retry healthy or definitive availability results", async (context) => {
  for (const status of [200, 404, 410]) {
    await context.test(String(status), async () => {
      let calls = 0;
      const result = await checkHttpSource(`https://example.com/status-${status}`, {
        policy: {
          ...policy,
          http: { ...policy.http, retryDelaySeconds: [0, 5, 30, 120] },
        },
        lookup: publicLookup,
        delay: async () => assert.fail(`status ${status} must not be delayed`),
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status });
        },
      });

      assert.equal(calls, 1);
      assert.equal(result.retryAttempts, 0);
      assert.equal(
        result.classification,
        status === 200 ? "healthy" : "definitive-failure",
      );
    });
  }
});

test("GitHub sources without a token use one bounded URL check", async () => {
  const calls = [];
  const context = await loadValidationContext(ROOT);
  const report = await runHealthScan({
    context,
    records: [{ id: "public-repo", canonicalSource: "https://github.com/example/repo" }],
    policy,
    previousHealth: { entries: [] },
    checkedAt: "2026-01-01T00:00:00.000Z",
    token: null,
    lookup: publicLookup,
    fetchImpl: responseFetch({
      "HEAD https://github.com/example/repo": { status: 200 },
    }, calls),
  });

  assert.deepEqual(calls, ["HEAD https://github.com/example/repo"]);
  assert.equal(report.sources[0].classification, "healthy");
});

test("token-authenticated GitHub checks use repository and path REST APIs", async () => {
  const archived = await checkGitHubSource("https://github.com/example/archived", {
    token: "fixture-token",
    policy,
    lookup: publicLookup,
    fetchImpl: responseFetch({
      "GET https://api.github.com/repos/example/archived": {
        status: 200,
        body: { archived: true, disabled: false },
      },
    }),
  });
  assert.equal(archived.classification, "definitive-failure");
  assert.equal(archived.reason, "GITHUB_REPOSITORY_ARCHIVED");

  const pathCalls = [];
  const deletedPath = await checkGitHubSource(
    "https://github.com/example/repo/blob/main/samples/demo.json",
    {
      token: "fixture-token",
      policy,
      lookup: publicLookup,
      fetchImpl: responseFetch({
        "GET https://api.github.com/repos/example/repo": {
          status: 200,
          body: { archived: false, disabled: false },
        },
        "GET https://api.github.com/repos/example/repo/contents/samples/demo.json?ref=main": {
          status: 404,
        },
      }, pathCalls),
    },
  );
  assert.equal(deletedPath.classification, "definitive-failure");
  assert.equal(deletedPath.reason, "SOURCE_HTTP_404");
  assert.equal(pathCalls.length, 2);
});

test("a partial GitHub path check is indeterminate and proposes no lifecycle action", async () => {
  const context = await loadValidationContext(ROOT);
  const source = "https://github.com/example/repo/blob/main/samples/demo.json";
  const report = await runHealthScan({
    context,
    records: [{ id: "partial", canonicalSource: source }],
    policy,
    previousHealth: {
      version: "1.0.0",
      entries: [{
        galleryId: "partial",
        canonicalSource: source,
        checkedAt: "2026-01-01T00:00:00.000Z",
        status: "needs-review",
        healthScore: 75,
        components: {
          availabilityIntegrity: 0,
          maintenanceFreshness: 25,
          sampleUsability: 20,
          productRelevance: 20,
          galleryValue: 10,
        },
        healthReasons: ["SOURCE_HTTP_404"],
        consecutiveFindings: 1,
        gracePeriodStartedAt: "2026-01-01T00:00:00.000Z",
        sourceState: {
          availability: "broken",
          archived: false,
          disabled: false,
          lastMeaningfulChange: null,
        },
        evidence: [],
      }],
    },
    checkedAt: "2026-02-01T00:00:00.000Z",
    token: "fixture-token",
    lookup: publicLookup,
    fetchImpl: responseFetch({
      "GET https://api.github.com/repos/example/repo": {
        status: 200,
        body: { archived: false, disabled: false },
      },
      "GET https://api.github.com/repos/example/repo/contents/samples/demo.json?ref=main": {
        status: 429,
      },
    }),
  });

  const [entry] = report.healthSnapshot.entries;
  assert.equal(entry.status, "indeterminate");
  assert.equal(entry.consecutiveFindings, 1);
  assert.equal(entry.gracePeriodStartedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(report.summary.quarantined, 0);
});

test("shared sources are checked once and dry-run never writes catalog or health files", async () => {
  const context = await loadValidationContext(ROOT);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "gallery-health-"));
  const staticDirectory = path.join(temporaryRoot, "static");
  await mkdir(staticDirectory);
  const templatesPath = path.join(staticDirectory, "templates.json");
  await writeFile(templatesPath, "unchanged\n", "utf8");
  const calls = [];
  try {
    const options = {
      rootDir: temporaryRoot,
      context,
      records: [
        { id: "first", canonicalSource: "https://example.com/shared" },
        { id: "second", canonicalSource: "https://example.com/shared/" },
      ],
      policy,
      previousHealth: { entries: [] },
      checkedAt: "2026-01-01T00:00:00.000Z",
      token: null,
      lookup: publicLookup,
      fetchImpl: responseFetch({
        "HEAD https://example.com/shared": { status: 200 },
      }, calls),
    };
    const dryRun = await runHealthScan(options);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.healthSnapshot.entries.length, 2);
    assert.equal(calls.length, 1);
    await assert.rejects(readFile(path.join(staticDirectory, "gallery-health.json")), /ENOENT/);
    assert.equal(await readFile(templatesPath, "utf8"), "unchanged\n");

    const written = await runHealthScan({ ...options, write: true });
    const persisted = JSON.parse(await readFile(written.writtenPath, "utf8"));
    const validate = context.schemas.validators.get("health.schema.json");
    assert.equal(validate(persisted), true, JSON.stringify(validate.errors));
    assert.equal(await readFile(templatesPath, "utf8"), "unchanged\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("fixture mode is fully offline and emits a schema-valid recovery snapshot", async () => {
  const context = await loadValidationContext(ROOT);
  const report = await runHealthScan({
    context,
    fixturePath: FIXTURE,
    fetchImpl: async () => { throw new Error("live network must not be used"); },
  });
  const validate = context.schemas.validators.get("health.schema.json");

  assert.equal(report.dryRun, true);
  assert.equal(report.summary.healthy, 1);
  assert.equal(report.healthSnapshot.entries[0].status, "healthy");
  assert.equal(validate(report.healthSnapshot), true, JSON.stringify(validate.errors));
});