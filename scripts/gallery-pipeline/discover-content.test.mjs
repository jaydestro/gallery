import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { main, runReportOnlyPipeline } from "./discover-content.mjs";

const FIXTURE_DIRECTORY = fileURLToPath(new URL("./fixtures/live-discovery/", import.meta.url));

function outputBuffer() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    value() { return value; },
  };
}

test("--fixtures runs a deterministic, fully offline combined dry run", async () => {
  const activePath = fileURLToPath(new URL("./fixtures/live-discovery/active.json", import.meta.url));
  const before = await readFile(activePath, "utf8");
  const firstOutput = outputBuffer();
  const first = await main(["--fixtures", FIXTURE_DIRECTORY], { stdout: firstOutput.stream, env: {} });
  const secondOutput = outputBuffer();
  const second = await main(["--fixtures", FIXTURE_DIRECTORY], { stdout: secondOutput.stream, env: {} });

  assert.equal(first.exitCode, 0);
  assert.equal(first.result.mode, "dry-run");
  assert.equal(first.result.mutationPerformed, false);
  assert.equal(first.result.status, "complete");
  assert.equal(first.result.discovery.candidates.length, 3);
  assert.ok(first.result.discovery.rejected.some((item) => item.reason === "exact-duplicate"));
  assert.equal(first.result.candidateGates.status, "complete");
  assert.equal(first.result.candidateGates.summary.eligible, 3);
  const youtubeCandidate = first.result.discovery.candidates.find(
    (candidate) => candidate.metadata.youtubeSourceType === "youtube-playlist",
  );
  assert.equal(youtubeCandidate.sourceId, "YtFixture01");
  assert.equal(youtubeCandidate.metadata.captionsAvailable, true);
  assert.equal(youtubeCandidate.evidence.some((item) => item.type === "youtube-transcript"), false);
  assert.equal(first.result.candidateGates.startedAt, first.result.discovery.completedAt);
  assert.deepEqual(JSON.parse(firstOutput.value()), first.result);
  assert.equal(firstOutput.value(), secondOutput.value());
  assert.deepEqual(first.result, second.result);
  assert.equal(firstOutput.value().includes("offline-fixture-youtube-key"), false);
  assert.equal(await readFile(activePath, "utf8"), before);
});

test("binds candidate gates to the exact discovery envelope and shared inputs", async () => {
  const trustedSources = { sources: [] };
  const activeCatalog = [];
  const retiredCatalog = { entries: [] };
  const policy = { batching: { maxCandidatesPerRun: 10 } };
  const fetchImpl = async () => {
    throw new Error("transport must not be called by orchestration stubs");
  };
  const lookup = async () => [];
  const inputs = {
    trustedSources,
    activeCatalog,
    retiredCatalog,
    policy,
    githubToken: "read-only-token",
    environment: { YOUTUBE_API_KEY: "fixture-youtube-key" },
    discoveredAt: "2026-08-28T12:00:00.000Z",
    limits: { feedEntries: 1 },
    fetchImpl,
    lookup,
    aiClient: { invoke() { throw new Error("AI must not run"); } },
    writer: { write() { throw new Error("writes must not run"); } },
  };
  const discovery = {
    status: "complete",
    startedAt: inputs.discoveredAt,
    completedAt: inputs.discoveredAt,
    candidates: [],
    sources: [],
  };
  const candidateGates = {
    status: "complete",
    startedAt: inputs.discoveredAt,
    completedAt: inputs.discoveredAt,
  };
  let discoveryOptions;
  let gateOptions;

  const result = await runReportOnlyPipeline(inputs, {
    async runDiscoveryImpl(options) {
      discoveryOptions = options;
      return discovery;
    },
    async runCandidateGatesImpl(options) {
      gateOptions = options;
      return candidateGates;
    },
  });

  assert.strictEqual(result.discovery, discovery);
  assert.strictEqual(result.candidateGates, candidateGates);
  assert.strictEqual(gateOptions.discovery, discovery);
  assert.equal(Object.hasOwn(gateOptions, "candidates"), false);
  assert.equal(Object.hasOwn(gateOptions, "sourceStatuses"), false);
  assert.strictEqual(gateOptions.trustedSources, trustedSources);
  assert.strictEqual(gateOptions.activeCatalog, activeCatalog);
  assert.strictEqual(gateOptions.retiredCatalog, retiredCatalog);
  assert.strictEqual(gateOptions.policy, policy);
  assert.strictEqual(gateOptions.fetchImpl, fetchImpl);
  assert.strictEqual(gateOptions.lookup, lookup);
  assert.equal(gateOptions.token, inputs.githubToken);
  assert.equal(gateOptions.checkedAt, discovery.completedAt);
  assert.strictEqual(discoveryOptions.fetchOptions.fetchImpl, fetchImpl);
  assert.strictEqual(discoveryOptions.fetchOptions.lookup, lookup);
  assert.strictEqual(discoveryOptions.environment, inputs.environment);
  assert.equal(Object.hasOwn(gateOptions, "aiClient"), false);
  assert.equal(Object.hasOwn(gateOptions, "writer"), false);
});

test("live CLI forwards only the environment YouTube key and never serializes it", async () => {
  const output = outputBuffer();
  const apiKey = "live-test-youtube-key";
  const timestamp = "2026-08-28T12:00:00.000Z";
  let discoveryOptions;
  const result = await main([], {
    stdout: output.stream,
    env: {
      GITHUB_TOKEN: "github-test-token",
      YOUTUBE_API_KEY: apiKey,
      UNRELATED_SECRET: "must-not-be-forwarded",
    },
    async runDiscoveryImpl(options) {
      discoveryOptions = options;
      return {
        schemaVersion: "1.0.0",
        mode: "dry-run",
        mutationPerformed: false,
        status: "complete",
        startedAt: timestamp,
        completedAt: timestamp,
        candidates: [],
        sources: [],
      };
    },
    async runCandidateGatesImpl() {
      return {
        schemaVersion: "1.0.0",
        mode: "dry-run",
        mutationPerformed: false,
        status: "complete",
        startedAt: timestamp,
        completedAt: timestamp,
        eligible: [],
        rejected: [],
      };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(discoveryOptions.environment, { YOUTUBE_API_KEY: apiKey });
  assert.equal(Object.hasOwn(discoveryOptions.environment, "UNRELATED_SECRET"), false);
  assert.equal(output.value().includes(apiKey), false);
});

test("writes both valid reports before returning nonzero for a partial run", async () => {
  const reportDirectory = await mkdtemp(path.join(tmpdir(), "gallery-report-only-"));
  const partialDiscovery = {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: "partial",
    startedAt: "2026-08-28T12:00:00.000Z",
    completedAt: "2026-08-28T12:00:00.000Z",
    candidates: [],
    sources: [],
  };
  const completeGates = {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: "complete",
    startedAt: partialDiscovery.completedAt,
    completedAt: partialDiscovery.completedAt,
    eligible: [],
    rejected: [],
  };
  const output = outputBuffer();

  try {
    const result = await main([
      "--fixtures",
      FIXTURE_DIRECTORY,
      "--report-directory",
      reportDirectory,
    ], {
      stdout: output.stream,
      env: {},
      async runDiscoveryImpl() {
        return partialDiscovery;
      },
      async runCandidateGatesImpl({ discovery }) {
        assert.strictEqual(discovery, partialDiscovery);
        return completeGates;
      },
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.result.status, "partial");
    assert.equal(output.value(), "");
    assert.deepEqual(
      (await readdir(reportDirectory)).sort(),
      ["candidate-gates.json", "discovery.json"],
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(reportDirectory, "discovery.json"), "utf8")),
      partialDiscovery,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(reportDirectory, "candidate-gates.json"), "utf8")),
      completeGates,
    );
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
});

test("writes valid combined JSON before returning nonzero for an indeterminate gate report", async () => {
  const output = outputBuffer();
  const discovery = {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: "complete",
    startedAt: "2026-08-28T12:00:00.000Z",
    completedAt: "2026-08-28T12:00:00.000Z",
    candidates: [],
    sources: [],
  };
  const candidateGates = {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: "indeterminate",
    startedAt: discovery.completedAt,
    completedAt: discovery.completedAt,
    eligible: [],
    rejected: [],
  };
  const result = await main(["--fixtures", FIXTURE_DIRECTORY], {
    stdout: output.stream,
    env: {},
    async runDiscoveryImpl() {
      return discovery;
    },
    async runCandidateGatesImpl() {
      return candidateGates;
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.result.status, "indeterminate");
  assert.deepEqual(JSON.parse(output.value()), result.result);
});

test("CLI rejects mutation flags and malformed arguments before running", async () => {
  const invalidArguments = [
    ["--write"],
    ["--apply"],
    ["--mutate"],
    ["--unknown"],
    ["positional-value"],
    ["--fixtures="],
    ["--fixtures", FIXTURE_DIRECTORY, "--fixtures", FIXTURE_DIRECTORY],
    ["--report-directory"],
    ["--report-directory="],
    ["--report-directory", "first", "--report-directory", "second"],
    ["--help", "--write"],
  ];

  for (const arguments_ of invalidArguments) {
    await assert.rejects(main(arguments_, { stdout: outputBuffer().stream, env: {} }), TypeError);
  }
});