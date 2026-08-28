import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateCatalogFreshness } from "./freshness.mjs";
import {
  fetchGitHubMetadata,
  main,
  parseArguments,
  runFreshnessEvaluation,
} from "./score-freshness.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/freshness/input.json", import.meta.url));

test("parses fixture mode as dry-run and rejects mutation options", () => {
  assert.deepEqual(parseArguments(["--fixtures", fixturePath, "--now", "2026-08-27T12:00:00.000Z"]), {
    dryRun: true,
    fixturePath,
    rootDir: process.cwd(),
    evaluatedAt: "2026-08-27T12:00:00.000Z",
  });
  assert.throws(() => parseArguments(["--write"]), /Unknown option/);
});

test("fixture mode emits a schema-valid report and proposes no mutations", async () => {
  const report = await runFreshnessEvaluation({ rootDir, fixturePath });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.summary.applicable, 1);
  assert.equal(report.summary.notApplicable, 1);
  assert.equal(report.summary.healthy, 1);
  assert.equal(report.summary.proposedMutations, 0);
  assert.equal(report.healthSnapshot.entries[0].healthScore, 100);
  assert.ok(report.entries.every((entry) => entry.mutation === "none"));
});

test("the CLI writes only the report in fixture mode", async () => {
  let output = "";
  let errors = "";
  const exitCode = await main(["--fixtures", fixturePath, "--root", rootDir], {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { errors += value; } },
  });
  assert.equal(exitCode, 0);
  assert.equal(errors, "");
  const report = JSON.parse(output);
  assert.equal(report.generatedAt, "2026-08-27T12:00:00.000Z");
  assert.equal(report.summary.proposedMutations, 0);
});

test("live metadata evaluation fails closed without a GitHub token", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const githubRecord = fixture.records[0];
  let fetchCalled = false;
  const metadata = await fetchGitHubMetadata(githubRecord, {
    token: "",
    policy: fixture.policy,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("must not fetch");
    },
  });
  const policy = fixture.policy ?? JSON.parse(
    await readFile(path.join(rootDir, ".github", "gallery-pipeline", "policy.json"), "utf8"),
  );
  const report = evaluateCatalogFreshness([githubRecord], {
    githubMetadata: [metadata],
    policy,
    health: fixture.health,
    evaluatedAt: fixture.evaluatedAt,
  });
  const [result] = report.entries;
  assert.equal(fetchCalled, false);
  assert.equal(metadata.errorCode, "GITHUB_TOKEN_MISSING");
  assert.equal(result.health.status, "indeterminate");
  assert.ok(result.health.healthReasons.includes("FRESHNESS_EVALUATION_INDETERMINATE"));
  assert.equal(result.health.evidence.at(-1).value, "GITHUB_TOKEN_MISSING");
  assert.equal(result.recommendation, "no-action");
  assert.equal(result.mutation, "none");
});