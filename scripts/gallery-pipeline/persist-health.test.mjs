import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HEALTH_ARTIFACT_FILES,
  HealthPersistenceError,
  createHealthPersistenceArtifacts,
  persistHealthProposal,
  replayHealthPersistenceProposal,
  writeHealthScanArtifacts,
} from "./persist-health.mjs";
import {
  HEALTH_RUN,
  makeHealthPersistenceFixture,
  prettyJsonBytes,
} from "./persist-health.fixtures.mjs";

function exactHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function expectCode(code) {
  return (error) => error instanceof HealthPersistenceError && error.code === code;
}

function createArtifacts(overrides = {}) {
  const fixture = makeHealthPersistenceFixture();
  return {
    fixture,
    artifacts: createHealthPersistenceArtifacts({
      ...fixture,
      now: "2026-08-27T12:00:01.000Z",
      ...overrides,
    }),
  };
}

test("receipt binds exact prior, catalog, report, and proposed-state bytes to run identity", () => {
  const { fixture, artifacts } = createArtifacts();
  const { receipt, artifactBytes } = artifacts;

  assert.equal(receipt.repository, HEALTH_RUN.repository);
  assert.equal(receipt.runId, HEALTH_RUN.runId);
  assert.equal(receipt.runAttempt, HEALTH_RUN.runAttempt);
  assert.equal(receipt.sourceRef, HEALTH_RUN.sourceRef);
  assert.equal(receipt.sourceSha, HEALTH_RUN.sourceSha);
  assert.equal(receipt.observedAt, HEALTH_RUN.observedAt);
  assert.equal(receipt.inputs.priorHealth.sha256, exactHash(fixture.priorHealthBytes));
  assert.equal(receipt.inputs.catalog.sha256, exactHash(fixture.catalogBytes));
  assert.equal(
    receipt.outputs.report.sha256,
    exactHash(artifactBytes[HEALTH_ARTIFACT_FILES.report]),
  );
  assert.equal(
    receipt.outputs.proposedHealth.sha256,
    exactHash(artifactBytes[HEALTH_ARTIFACT_FILES.proposedHealth]),
  );
  assert.deepEqual(artifacts.report.healthSnapshot, fixture.proposedHealth);
});

test("proposal replay is exact and a second replay is an idempotent no-op", () => {
  const { fixture, artifacts } = createArtifacts();
  const replay = (currentHealthBytes) => replayHealthPersistenceProposal({
    currentHealthBytes,
    catalogBytes: fixture.catalogBytes,
    reportBytes: artifacts.artifactBytes[HEALTH_ARTIFACT_FILES.report],
    proposedHealthBytes: artifacts.artifactBytes[HEALTH_ARTIFACT_FILES.proposedHealth],
    receiptBytes: artifacts.artifactBytes[HEALTH_ARTIFACT_FILES.receipt],
    expectedRun: fixture.run,
    now: "2026-08-28T12:00:00.000Z",
  });

  const first = replay(fixture.priorHealthBytes);
  assert.equal(first.status, "ready");
  assert.deepEqual(first.healthBytes, artifacts.artifactBytes[HEALTH_ARTIFACT_FILES.proposedHealth]);

  const repeated = replay(first.healthBytes);
  assert.equal(repeated.status, "already-applied");
  assert.deepEqual(repeated.healthBytes, first.healthBytes);
});

test("fails closed for malformed, mismatched, future, duplicate, and stale state", () => {
  const fixture = makeHealthPersistenceFixture();
  assert.throws(() => createHealthPersistenceArtifacts({
    ...fixture,
    priorHealthBytes: Buffer.from("{not-json\n"),
    now: "2026-08-27T12:00:01.000Z",
  }), expectCode("PRIOR_STATE_MALFORMED"));

  assert.throws(() => createHealthPersistenceArtifacts({
    ...fixture,
    priorHealthBytes: prettyJsonBytes({ ...fixture.priorHealth, version: "9.9.9" }),
    now: "2026-08-27T12:00:01.000Z",
  }), expectCode("PRIOR_STATE_MISMATCH"));

  assert.throws(() => createHealthPersistenceArtifacts({
    ...fixture,
    run: { ...fixture.run, observedAt: "2026-08-28T00:00:00.000Z" },
    now: "2026-08-27T12:00:01.000Z",
  }), expectCode("OBSERVATION_TIME_FUTURE"));

  assert.throws(() => createHealthPersistenceArtifacts({
    ...fixture,
    proposedHealth: {
      ...fixture.proposedHealth,
      entries: [fixture.proposedHealth.entries[0], fixture.proposedHealth.entries[0]],
    },
    now: "2026-08-27T12:00:01.000Z",
  }), expectCode("DUPLICATE_OBSERVATION"));

  assert.throws(() => createHealthPersistenceArtifacts({
    ...fixture,
    proposedHealth: {
      ...fixture.proposedHealth,
      entries: [{
        ...fixture.proposedHealth.entries[0],
        canonicalSource: "https://example.com/stale-source",
      }],
    },
    now: "2026-08-27T12:00:01.000Z",
  }), expectCode("STALE_SOURCE_IDENTITY"));
});

test("replay rejects exact-byte drift and a stale trusted source identity", () => {
  const { fixture, artifacts } = createArtifacts();
  const base = {
    currentHealthBytes: fixture.priorHealthBytes,
    catalogBytes: fixture.catalogBytes,
    reportBytes: artifacts.artifactBytes[HEALTH_ARTIFACT_FILES.report],
    proposedHealthBytes: artifacts.artifactBytes[HEALTH_ARTIFACT_FILES.proposedHealth],
    receiptBytes: artifacts.artifactBytes[HEALTH_ARTIFACT_FILES.receipt],
    expectedRun: fixture.run,
    now: "2026-08-28T12:00:00.000Z",
  };

  assert.throws(() => replayHealthPersistenceProposal({
    ...base,
    currentHealthBytes: Buffer.from(`${fixture.priorHealthBytes.toString("utf8")} `),
  }), expectCode("PRIOR_STATE_MISMATCH"));
  assert.throws(() => replayHealthPersistenceProposal({
    ...base,
    catalogBytes: Buffer.from(`${fixture.catalogBytes.toString("utf8")} `),
  }), expectCode("CATALOG_STATE_MISMATCH"));
  assert.throws(() => replayHealthPersistenceProposal({
    ...base,
    expectedRun: { ...fixture.run, sourceSha: "f".repeat(40) },
  }), expectCode("STALE_SOURCE_IDENTITY"));
});

test("scan artifacts can only be emitted outside the repository root", async () => {
  const { artifacts } = createArtifacts();
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "gallery-health-artifacts-"));
  const rootDirectory = path.join(temporaryDirectory, "repository");
  const outputDirectory = path.join(temporaryDirectory, "artifacts");
  await mkdir(rootDirectory);
  try {
    await writeHealthScanArtifacts({
      rootDir: rootDirectory,
      outputDirectory,
      artifactBytes: artifacts.artifactBytes,
    });
    for (const fileName of Object.values(HEALTH_ARTIFACT_FILES)) {
      assert.deepEqual(
        await readFile(path.join(outputDirectory, fileName)),
        artifacts.artifactBytes[fileName],
      );
    }
    await assert.rejects(writeHealthScanArtifacts({
      rootDir: rootDirectory,
      outputDirectory: path.join(rootDirectory, "artifacts"),
      artifactBytes: artifacts.artifactBytes,
    }), expectCode("WORKSPACE_WRITE_FORBIDDEN"));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("publisher writes exact proposed bytes atomically and then reports already applied", async () => {
  const { fixture, artifacts } = createArtifacts();
  const rootDirectory = await mkdtemp(path.join(tmpdir(), "gallery-health-publish-"));
  const staticDirectory = path.join(rootDirectory, "static");
  const artifactDirectory = path.join(rootDirectory, "incoming");
  await mkdir(staticDirectory, { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });
  try {
    await writeFile(path.join(staticDirectory, "gallery-health.json"), fixture.priorHealthBytes);
    await writeFile(path.join(staticDirectory, "templates.json"), fixture.catalogBytes);
    for (const [fileName, bytes] of Object.entries(artifacts.artifactBytes)) {
      await writeFile(path.join(artifactDirectory, fileName), bytes);
    }

    const options = {
      rootDir: rootDirectory,
      artifactDirectory,
      expectedRun: fixture.run,
      now: "2026-08-28T12:00:00.000Z",
    };
    const first = await persistHealthProposal(options);
    assert.equal(first.status, "persisted");
    assert.deepEqual(
      await readFile(path.join(staticDirectory, "gallery-health.json")),
      artifacts.artifactBytes[HEALTH_ARTIFACT_FILES.proposedHealth],
    );
    const repeated = await persistHealthProposal(options);
    assert.equal(repeated.status, "already-applied");
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});