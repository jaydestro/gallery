import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkGitHubSource,
  checkHttpSource,
  main,
  mapAvailabilityChecks,
  parseArguments,
  runHealthScan,
} from "./scan-health.mjs";
import { HEALTH_ARTIFACT_FILES } from "./persist-health.mjs";
import { loadValidationContext } from "./validation.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIRECTORY, "../..");
const FIXTURE = path.join(TEST_DIRECTORY, "fixtures", "health");
const HEALTH_SCHEMA = "../.github/gallery-pipeline/health.schema.json";
const publicLookup = async () => [{ address: "20.12.34.56", family: 4 }];
const policy = {
  contractVersions: { health: "1.0.0" },
  http: { timeoutSeconds: 1, maxRedirects: 2 },
  lifecycle: { requiredConfirmations: 2, retirementGraceDays: 30 },
};

function emptyHealth() {
  return {
    $schema: HEALTH_SCHEMA,
    version: "1.0.0",
    entries: [],
  };
}

function runIdentity(runId, observedAt) {
  return {
    repository: "example/gallery",
    runId,
    runAttempt: 1,
    sourceRef: "refs/heads/main",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    observedAt,
  };
}

function exactHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

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

test("argument parsing is read-only and exposes no direct persistence mode", () => {
  assert.deepEqual(parseArguments([]), {
    fixturePath: null,
    rootDir: process.cwd(),
    checkedAt: null,
    concurrency: 6,
    outputDirectory: null,
  });
  assert.throws(() => parseArguments(["--write"]), /Unknown option/);
  assert.throws(() => parseArguments(["--concurrency", "0"]), /positive integer/);
});

test("serializes and paces Learn checks in deterministic order without real sleeping", async () => {
  const urls = Array.from(
    { length: 4 },
    (_, index) => `https://learn.microsoft.com/azure/cosmos-db/scheduled-${index}`,
  );
  const startResolvers = [];
  const releaseResolvers = [];
  const starts = urls.map((_, index) => new Promise((resolve) => {
    startResolvers[index] = resolve;
  }));
  const releases = urls.map((_, index) => new Promise((resolve) => {
    releaseResolvers[index] = resolve;
  }));
  const startedUrls = [];
  const delays = [];
  let activeLearn = 0;
  let maximumActiveLearn = 0;

  const scheduled = mapAvailabilityChecks(urls, 20, async (url, index) => {
    activeLearn += 1;
    maximumActiveLearn = Math.max(maximumActiveLearn, activeLearn);
    startedUrls.push(url);
    startResolvers[index]();
    await releases[index];
    activeLearn -= 1;
    return url;
  }, {
    delay: async (milliseconds) => delays.push(milliseconds),
  });

  await starts[0];
  assert.deepEqual(startedUrls, [urls[0]]);
  for (let index = 0; index < urls.length; index += 1) {
    assert.equal(activeLearn, 1);
    releaseResolvers[index]();
    if (index + 1 < urls.length) await starts[index + 1];
  }

  assert.deepEqual(await scheduled, urls);
  assert.equal(maximumActiveLearn, 1);
  assert.deepEqual(startedUrls, urls);
  assert.deepEqual(delays, [200, 200, 200]);
});

test("retains the global cap of six for non-Learn hosts without pacing", async () => {
  const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/scheduled-${index}`);
  const blocked = [];
  let releaseImmediately = false;
  let firstWaveReady;
  const firstWave = new Promise((resolve) => {
    firstWaveReady = resolve;
  });
  let active = 0;
  let maximumActive = 0;
  let started = 0;

  const scheduled = mapAvailabilityChecks(urls, 20, async (url) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    started += 1;
    if (started === 6) firstWaveReady();
    if (!releaseImmediately) await new Promise((resolve) => blocked.push(resolve));
    active -= 1;
    return url;
  }, {
    delay: async () => assert.fail("non-Learn checks must not be paced"),
  });

  await firstWave;
  assert.equal(active, 6);
  releaseImmediately = true;
  blocked.splice(0).forEach((resolve) => resolve());

  assert.deepEqual(await scheduled, urls);
  assert.equal(maximumActive, 6);
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
    previousHealth: emptyHealth(),
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
      $schema: HEALTH_SCHEMA,
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

test("two scan runs confirm from exact persisted state and same-run replay does not increment", async () => {
  const context = await loadValidationContext(ROOT);
  const records = [{ id: "two-run", canonicalSource: "https://example.com/two-run" }];
  const catalogBytes = Buffer.from(`${JSON.stringify(records)}\n`);
  const firstPrior = emptyHealth();
  const firstPriorBytes = Buffer.from(`${JSON.stringify(firstPrior)}\n`);
  const scan = ({ previousHealth, previousHealthBytes, checkedAt, runId }) => runHealthScan({
    context,
    records,
    catalogBytes,
    policy,
    previousHealth,
    previousHealthBytes,
    checkedAt,
    run: runIdentity(runId, checkedAt),
    now: "2026-02-02T00:00:00.000Z",
    token: null,
    lookup: publicLookup,
    fetchImpl: responseFetch({
      "HEAD https://example.com/two-run": { status: 404 },
    }),
  });

  const first = await scan({
    previousHealth: firstPrior,
    previousHealthBytes: firstPriorBytes,
    checkedAt: "2026-01-01T00:00:00.000Z",
    runId: "run-1",
  });
  assert.equal(first.proposedHealth.entries[0].consecutiveFindings, 1);
  assert.equal(first.receipt.inputs.priorHealth.sha256, exactHash(firstPriorBytes));
  assert.equal(first.receipt.inputs.catalog.sha256, exactHash(catalogBytes));

  const firstProposedBytes = first.artifactBytes[HEALTH_ARTIFACT_FILES.proposedHealth];
  const second = await scan({
    previousHealth: first.proposedHealth,
    previousHealthBytes: firstProposedBytes,
    checkedAt: "2026-02-01T00:00:00.000Z",
    runId: "run-2",
  });
  assert.equal(second.proposedHealth.entries[0].consecutiveFindings, 2);
  assert.equal(second.proposedHealth.entries[0].status, "quarantined");

  const secondProposedBytes = second.artifactBytes[HEALTH_ARTIFACT_FILES.proposedHealth];
  const replayed = await scan({
    previousHealth: second.proposedHealth,
    previousHealthBytes: secondProposedBytes,
    checkedAt: "2026-02-01T00:00:00.000Z",
    runId: "run-2",
  });
  assert.equal(replayed.proposedHealth.entries[0].consecutiveFindings, 2);
  assert.equal(replayed.proposedHealth.entries[0].status, "quarantined");
});

test("shared sources are checked once and dry-run never writes catalog or health files", async () => {
  const context = await loadValidationContext(ROOT);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "gallery-health-"));
  const staticDirectory = path.join(temporaryRoot, "static");
  await mkdir(staticDirectory);
  const templatesPath = path.join(staticDirectory, "templates.json");
  const healthPath = path.join(staticDirectory, "gallery-health.json");
  await writeFile(templatesPath, "unchanged\n", "utf8");
  await writeFile(healthPath, "unchanged health\n", "utf8");
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
      previousHealth: emptyHealth(),
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
    assert.equal(await readFile(templatesPath, "utf8"), "unchanged\n");
    assert.equal(await readFile(healthPath, "utf8"), "unchanged health\n");
    assert.deepEqual(dryRun.proposedHealth, dryRun.healthSnapshot);
    const validate = context.schemas.validators.get("health.schema.json");
    assert.equal(validate(dryRun.proposedHealth), true, JSON.stringify(validate.errors));
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

test("CLI emits report, proposed state, and receipt outside the workspace without source writes", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "gallery-health-cli-"));
  const outputDirectory = path.join(temporaryDirectory, "artifacts");
  const healthPath = path.join(ROOT, "static", "gallery-health.json");
  const healthBefore = await readFile(healthPath);
  const output = [];
  const errors = [];
  try {
    const exitCode = await main([
      "--root", ROOT,
      "--fixtures", FIXTURE,
      "--output-directory", outputDirectory,
    ], {
      stdout: { write: (chunk) => output.push(Buffer.from(chunk)) },
      stderr: { write: (chunk) => errors.push(String(chunk)) },
    });
    assert.equal(exitCode, 0, errors.join(""));
    const reportBytes = await readFile(path.join(outputDirectory, HEALTH_ARTIFACT_FILES.report));
    const proposedBytes = await readFile(
      path.join(outputDirectory, HEALTH_ARTIFACT_FILES.proposedHealth),
    );
    const receiptBytes = await readFile(path.join(outputDirectory, HEALTH_ARTIFACT_FILES.receipt));
    const receipt = JSON.parse(receiptBytes);
    assert.deepEqual(Buffer.concat(output), reportBytes);
    assert.equal(receipt.outputs.report.sha256, exactHash(reportBytes));
    assert.equal(receipt.outputs.proposedHealth.sha256, exactHash(proposedBytes));
    assert.deepEqual(await readFile(healthPath), healthBefore);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("workflow is unconditional, read-only, pinned, and uploads all health artifacts", async () => {
  const workflow = await readFile(
    path.join(ROOT, ".github", "workflows", "scan-gallery-health.yml"),
    "utf8",
  );
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /GALLERY_PIPELINE_DRY_RUN_ENABLED|contents: write|git (commit|push)/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /--output-directory "\$artifact_directory"/);
  for (const fileName of Object.values(HEALTH_ARTIFACT_FILES)) {
    assert.match(workflow, new RegExp(fileName.replaceAll(".", "\\.")));
  }
  for (const reference of workflow.matchAll(/uses:\s*[^\s@]+@([^\s]+)/g)) {
    assert.match(reference[1], /^[a-f0-9]{40}$/);
  }
});