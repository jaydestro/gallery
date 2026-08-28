import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { applyCatalogPlan } from "./apply-catalog-plan.mjs";
import { makeCatalogReplayFixture } from "./apply-catalog-plan.fixtures.mjs";
import {
  CATALOG_PLAN_PATH,
  CATALOG_STATE_FILES,
  CatalogDiffValidationError,
  validateCatalogDiff,
  validateCatalogRepositoryDiff,
} from "./validate-catalog-diff.mjs";

const execFileAsync = promisify(execFile);

function clone(value) {
  return structuredClone(value);
}

function expectedFixture() {
  const fixture = makeCatalogReplayFixture();
  const proposedFiles = applyCatalogPlan(fixture);
  return {
    fixture,
    proposedFiles,
    changedPaths: [CATALOG_PLAN_PATH, ...Object.values(CATALOG_STATE_FILES)],
  };
}

function validationInput() {
  const { fixture, proposedFiles, changedPaths } = expectedFixture();
  return {
    changedPaths,
    plan: fixture.plan,
    policy: fixture.policy,
    trustedRepository: fixture.trustedRepository,
    baseFiles: {
      activeCatalog: fixture.activeCatalog,
      health: fixture.health,
      retired: fixture.retired,
      audit: fixture.audit,
    },
    proposedFiles,
  };
}

function expectCode(code) {
  return (error) => error instanceof CatalogDiffValidationError && error.code === code;
}

async function writeJson(rootDirectory, filePath, value) {
  const outputPath = path.join(rootDirectory, filePath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("accepts only proposed catalog files exactly reproduced by the fixed-path replay proof", () => {
  const result = validateCatalogDiff(validationInput());

  assert.equal(result.required, true);
  assert.equal(result.operations, 5);
  assert.deepEqual(result.statePaths, Object.values(CATALOG_STATE_FILES).sort());
  assert.equal(
    result.message,
    "Catalog replay validation passed: 5 planned operations exactly reproduce 4 catalog state files with an append-only audit.",
  );
});

test("returns explicit success when a pull request has no catalog state or plan change", () => {
  const result = validateCatalogDiff({
    changedPaths: ["scripts/gallery-pipeline/validate-catalog-diff.mjs"],
  });

  assert.deepEqual(result, {
    required: false,
    operations: 0,
    statePaths: [],
    message: "Catalog replay validation passed: no catalog state changes detected; replay proof not required.",
  });
});

test("rejects state changes without the exact proof path and proof-only changes", () => {
  const missingProof = validationInput();
  missingProof.changedPaths = missingProof.changedPaths.filter((filePath) => filePath !== CATALOG_PLAN_PATH);
  assert.throws(() => validateCatalogDiff(missingProof), expectCode("REPLAY_PROOF_MISSING"));

  assert.throws(
    () => validateCatalogDiff({ changedPaths: [CATALOG_PLAN_PATH] }),
    expectCode("UNEXPLAINED_PLAN"),
  );

  const wrongProofPath = validationInput();
  wrongProofPath.changedPaths = wrongProofPath.changedPaths.map((filePath) => (
    filePath === CATALOG_PLAN_PATH ? "artifacts/catalog-change-plan.json" : filePath
  ));
  assert.throws(() => validateCatalogDiff(wrongProofPath), expectCode("REPLAY_PROOF_MISSING"));
});

test("rejects missing or extra catalog state paths relative to deterministic replay", () => {
  const missingStatePath = validationInput();
  missingStatePath.changedPaths = missingStatePath.changedPaths.filter(
    (filePath) => filePath !== CATALOG_STATE_FILES.health,
  );
  assert.throws(() => validateCatalogDiff(missingStatePath), expectCode("STATE_PATH_MISMATCH"));

  const emptyPlan = validationInput();
  emptyPlan.plan = {
    ...clone(emptyPlan.plan),
    summary: { publish: 0, update: 0, quarantine: 0, retire: 0, restore: 0, total: 0 },
    operations: [],
  };
  assert.throws(() => validateCatalogDiff(emptyPlan), expectCode("REPLAY_PROOF_INVALID"));
});

test("rejects every unrecognized path when catalog state changes", () => {
  const input = validationInput();
  input.changedPaths.push("docs/unrelated-change.md");

  assert.throws(() => validateCatalogDiff(input), expectCode("UNEXPECTED_CHANGED_PATHS"));
});

test("rejects any proposed state file that differs from replay output", () => {
  const mutations = {
    activeCatalog(input) {
      input.proposedFiles.activeCatalog[0].title = "Unplanned catalog title";
    },
    health(input) {
      input.proposedFiles.health.entries[0].checkedAt = "2026-08-27T12:00:01.000Z";
    },
    retired(input) {
      input.proposedFiles.retired.entries[0].retentionUntil = "2027-08-28";
    },
    audit(input) {
      input.proposedFiles.audit.entries[0].entryHash = "a".repeat(64);
    },
  };

  for (const mutate of Object.values(mutations)) {
    const input = validationInput();
    mutate(input);
    assert.throws(() => validateCatalogDiff(input), expectCode("PROPOSED_FILE_MISMATCH"));
  }
});

test("enforces the current policy batch limit independently during replay", () => {
  const input = validationInput();
  input.policy.batching.maxEntriesPerPullRequest = 4;

  assert.throws(() => validateCatalogDiff(input), (error) => (
    error instanceof CatalogDiffValidationError &&
    error.code === "REPLAY_FAILED" &&
    error.details.code === "BATCH_LIMIT_EXCEEDED"
  ));
});

test("requires a well-formed trusted current repository for retirement replay", () => {
  const missing = validationInput();
  delete missing.trustedRepository;
  assert.throws(() => validateCatalogDiff(missing), (error) => (
    error instanceof CatalogDiffValidationError &&
    error.code === "REPLAY_FAILED" &&
    error.details.code === "MISSING_GATE"
  ));

  for (const trustedRepository of [
    "foreign-owner/foreign-gallery",
    "example/gallery/extra",
    "Example/gallery",
  ]) {
    const input = validationInput();
    input.trustedRepository = trustedRepository;
    assert.throws(() => validateCatalogDiff(input), (error) => (
      error instanceof CatalogDiffValidationError &&
      error.code === "REPLAY_FAILED" &&
      error.details.code === "PROVENANCE_INVALID"
    ));
  }
});

test("allows the first exact audit append when the base revision has no audit file", () => {
  const input = validationInput();
  delete input.baseFiles.audit;

  assert.throws(() => validateCatalogDiff(input), expectCode("STATE_FILE_MISSING"));
  input.baseAuditMissing = true;

  const result = validateCatalogDiff(input);
  assert.equal(result.required, true);
  assert(input.proposedFiles.audit.entries[0].previousHash === null);
});

test("validates exact replay output across real base and head Git commits", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "gallery-replay-"));
  try {
    const input = validationInput();
    await Promise.all([
      writeJson(rootDirectory, CATALOG_STATE_FILES.activeCatalog, input.baseFiles.activeCatalog),
      writeJson(rootDirectory, CATALOG_STATE_FILES.health, input.baseFiles.health),
      writeJson(rootDirectory, CATALOG_STATE_FILES.retired, input.baseFiles.retired),
      writeJson(rootDirectory, ".github/gallery-pipeline/policy.json", input.policy),
    ]);
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: rootDirectory });
    await execFileAsync("git", ["config", "user.name", "Gallery Replay Test"], { cwd: rootDirectory });
    await execFileAsync("git", ["config", "user.email", "gallery-replay@example.invalid"], { cwd: rootDirectory });
    await execFileAsync("git", ["add", "."], { cwd: rootDirectory });
    await execFileAsync("git", ["commit", "-m", "base catalog state"], { cwd: rootDirectory });
    const { stdout: baseRefOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootDirectory });
    const baseRef = baseRefOutput.trim();

    await Promise.all([
      writeJson(rootDirectory, CATALOG_PLAN_PATH, input.plan),
      ...Object.entries(CATALOG_STATE_FILES).map(([key, filePath]) => (
        writeJson(rootDirectory, filePath, input.proposedFiles[key])
      )),
    ]);
    await execFileAsync("git", ["add", "."], { cwd: rootDirectory });
    await execFileAsync("git", ["commit", "-m", "apply catalog plan"], { cwd: rootDirectory });

    await assert.rejects(
      () => validateCatalogRepositoryDiff({
        rootDirectory,
        baseRef,
        changedPaths: input.changedPaths.slice(0, -1),
        trustedRepository: input.trustedRepository,
      }),
      expectCode("CHANGED_PATHS_INCOMPLETE"),
    );

    const result = await validateCatalogRepositoryDiff({
      rootDirectory,
      baseRef,
      changedPaths: input.changedPaths,
      trustedRepository: input.trustedRepository,
    });
    assert.equal(result.required, true);
    assert.equal(result.operations, input.plan.operations.length);
    assert.deepEqual(result.statePaths, Object.values(CATALOG_STATE_FILES).sort());

    await assert.rejects(
      () => validateCatalogRepositoryDiff({ rootDirectory, baseRef: "missing-base-ref" }),
      expectCode("GIT_DIFF_FAILED"),
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("does not treat malformed base audit JSON as a missing optional audit", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "gallery-replay-malformed-audit-"));
  try {
    const input = validationInput();
    await Promise.all([
      writeJson(rootDirectory, CATALOG_STATE_FILES.activeCatalog, input.baseFiles.activeCatalog),
      writeJson(rootDirectory, CATALOG_STATE_FILES.health, input.baseFiles.health),
      writeJson(rootDirectory, CATALOG_STATE_FILES.retired, input.baseFiles.retired),
      writeJson(rootDirectory, ".github/gallery-pipeline/policy.json", input.policy),
    ]);
    const auditPath = path.join(rootDirectory, CATALOG_STATE_FILES.audit);
    await mkdir(path.dirname(auditPath), { recursive: true });
    await writeFile(auditPath, "{ malformed audit json\n", "utf8");
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: rootDirectory });
    await execFileAsync("git", ["config", "user.name", "Gallery Replay Test"], { cwd: rootDirectory });
    await execFileAsync("git", ["config", "user.email", "gallery-replay@example.invalid"], { cwd: rootDirectory });
    await execFileAsync("git", ["add", "."], { cwd: rootDirectory });
    await execFileAsync("git", ["commit", "-m", "malformed base audit"], { cwd: rootDirectory });
    const { stdout: baseRefOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootDirectory });
    const baseRef = baseRefOutput.trim();

    await Promise.all([
      writeJson(rootDirectory, CATALOG_PLAN_PATH, input.plan),
      ...Object.entries(CATALOG_STATE_FILES).map(([key, filePath]) => (
        writeJson(rootDirectory, filePath, input.proposedFiles[key])
      )),
    ]);
    await execFileAsync("git", ["add", "."], { cwd: rootDirectory });
    await execFileAsync("git", ["commit", "-m", "replace malformed audit"], { cwd: rootDirectory });

    await assert.rejects(
      () => validateCatalogRepositoryDiff({ rootDirectory, baseRef }),
      expectCode("BASE_FILE_PARSE_FAILED"),
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});