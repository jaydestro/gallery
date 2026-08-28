import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  compareCatalogOperations,
  hashCanonicalValue,
  replayCatalogChangePlan,
} from "./build-catalog-change.mjs";
import {
  makeFreshnessEntry,
  makeHealthEntry,
  makeRecord,
} from "./build-catalog-change.fixtures.mjs";
import {
  catalogProposalExitCode,
  CatalogProposalError,
  createModelAnalysisVerification,
  createModelAnalysisReceipt,
  expectedModelAnalysisConfigurationHashes,
  main,
  proposeCatalogChanges,
  validateCatalogProposalReceipt,
  validateCatalogProposalReport,
} from "./propose-catalog-changes.mjs";
import {
  makeDisabledProposalFixture as makeUnboundDisabledProposalFixture,
  makeHealthArtifactFixture,
  makePartialProposalFixture as makeUnboundPartialProposalFixture,
  makeProposalFixture as makeUnboundProposalFixture,
} from "./propose-catalog-changes.fixtures.mjs";
import { hashHealthBytes } from "./persist-health.mjs";
import { verifyAuditLog } from "./write-audit.mjs";

const REPOSITORY_POLICY_PATH = fileURLToPath(new URL(
  "../../.github/gallery-pipeline/policy.json",
  import.meta.url,
));
const PROPOSAL_WORKFLOW_PATH = fileURLToPath(new URL(
  "../../.github/workflows/propose-gallery-changes.yml",
  import.meta.url,
));
const ANALYSIS_SCHEMA_PATH = fileURLToPath(new URL(
  "../../.github/gallery-pipeline/analysis.schema.json",
  import.meta.url,
));
const repositoryPolicy = JSON.parse(await readFile(REPOSITORY_POLICY_PATH, "utf8"));
const repositoryAnalysisSchema = JSON.parse(await readFile(ANALYSIS_SCHEMA_PATH, "utf8"));
const FIXTURE_NOW = "2026-08-27T12:05:00.000Z";

function clone(value) {
  return structuredClone(value);
}

function prettyJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function mutateJsonFile(filePath, mutate) {
  const value = JSON.parse(await readFile(filePath, "utf8"));
  mutate(value);
  await writeFile(filePath, prettyJsonBytes(value));
}

async function resealHealthProvenance(directory, field, value) {
  const reportPath = path.join(directory, "gallery-health-report.json");
  const receiptPath = path.join(directory, "gallery-health-receipt.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  report.provenance[field] = value;
  receipt[field] = value;
  const reportBytes = prettyJsonBytes(report);
  receipt.outputs.report.sha256 = hashHealthBytes(reportBytes);
  await Promise.all([
    writeFile(reportPath, reportBytes),
    writeFile(receiptPath, prettyJsonBytes(receipt)),
  ]);
}

function modelVerification(input) {
  const sourceDiscoveryArtifact = input.upstreamArtifacts
    .find((artifact) => artifact?.name === "discovery");
  return createModelAnalysisVerification({
    modelAnalysis: prettyJsonBytes(input.modelAnalysis),
    discovery: prettyJsonBytes(input.discovery),
    candidateGates: prettyJsonBytes(input.candidateGates),
    activeCatalog: prettyJsonBytes(input.activeCatalog),
    retiredCatalog: prettyJsonBytes(input.retired),
    policy: prettyJsonBytes(input.policy),
    analysisSchema: prettyJsonBytes(input.analysisSchema),
    sourceDiscoveryArtifact: prettyJsonBytes(sourceDiscoveryArtifact),
  });
}

function rejectedLedger(candidateGates) {
  const entries = clone(candidateGates.rejected);
  return {
    count: entries.length,
    entries,
    hash: `sha256:${hashCanonicalValue(entries)}`,
  };
}

function bindModelAnalysis(input) {
  const selectedCandidates = input.candidateGates.summary.selectedCandidates ??
    input.candidateGates.summary.candidates;
  Object.assign(input.candidateGates, {
    schemaVersion: "2.0.0",
    coverageStatus: (
      selectedCandidates === input.candidateGates.summary.candidates &&
      input.candidateGates.summary.indeterminateAvailabilityChecks === 0
    ) ? "complete" : "partial",
  });
  Object.assign(input.candidateGates.summary, {
    selectedCandidates,
    executedCandidateChecks: input.candidateGates.summary.executedCandidateChecks ??
      selectedCandidates,
    executedAvailabilityChecks: input.candidateGates.summary.executedAvailabilityChecks ??
      input.candidateGates.summary.availabilityChecks,
    deadlineExceededAvailabilityChecks: input.candidateGates.summary
      .deadlineExceededAvailabilityChecks ?? 0,
  });
  input.analysisSchema = clone(repositoryAnalysisSchema);
  if (!input.modelAnalysis) {
    input.modelAnalysisVerification = null;
    return input;
  }
  input.modelAnalysis.schemaVersion = "2.0.0";
  input.modelAnalysis.rejectedLedger = rejectedLedger(input.candidateGates);
  Object.assign(
    input.modelAnalysis.configuration,
    expectedModelAnalysisConfigurationHashes(input),
  );
  input.modelAnalysis.fileHashes = modelVerification(input).fileHashes;
  input.modelAnalysisReceipt = createModelAnalysisReceipt(input.modelAnalysis);
  input.modelAnalysisVerification = modelVerification(input);
  return input;
}

function makeProposalFixture(options) {
  return bindModelAnalysis(makeUnboundProposalFixture(options));
}

function makePartialProposalFixture(options) {
  return bindModelAnalysis(makeUnboundPartialProposalFixture(options));
}

function makeDisabledProposalFixture(options) {
  return bindModelAnalysis(makeUnboundDisabledProposalFixture(options));
}

function ledgerEntry(result, subjectType, subjectId) {
  return result.report.reasonLedger.find((entry) => (
    entry.subjectType === subjectType && entry.subjectId === subjectId
  ));
}

function flattenedOperations(result) {
  return result.plans.flatMap((plan) => plan.operations);
}

function retargetFirstCandidateForUpdate(input, target) {
  for (const candidate of [
    input.discovery.candidates[0],
    input.candidateGates.eligible[0].candidate,
  ]) {
    candidate.metadata.galleryId = target.id;
  }
  const analysis = input.modelAnalysis.analyses[0];
  analysis.recommendation = "update";
  analysis.reasonCodes = ["AI_UPDATE_APPROVED"];
  input.modelAnalysisReceipt = createModelAnalysisReceipt(input.modelAnalysis);
}

function rejectCandidateAsIndeterminate(input, index) {
  const [entry] = input.candidateGates.eligible.splice(index, 1);
  const candidateId = entry.candidate.identityKey;
  input.candidateGates.rejected.push({
    candidateId,
    reasonCodes: ["SOURCE_TIMEOUT"],
    availability: {
      checkedAt: input.candidateGates.completedAt,
      classification: "indeterminate",
      statusCode: null,
      reasonCode: "SOURCE_TIMEOUT",
      retryAttempts: 1,
      retryReasons: ["SOURCE_TIMEOUT"],
    },
  });
  input.candidateGates.coverageStatus = "partial";
  input.candidateGates.summary.indeterminateAvailabilityChecks += 1;
  input.candidateGates.summary.eligible -= 1;
  input.candidateGates.summary.rejected += 1;
  input.modelAnalysis.analyses = input.modelAnalysis.analyses
    .filter((analysis) => analysis.candidateId !== candidateId);
  const eligibleIds = input.candidateGates.eligible
    .map((eligible) => eligible.candidate.identityKey)
    .sort((left, right) => left.localeCompare(right));
  input.modelAnalysis.eligibleSet = {
    count: eligibleIds.length,
    candidateIds: eligibleIds,
    hash: `sha256:${hashCanonicalValue(eligibleIds)}`,
  };
  bindModelAnalysis(input);
  return candidateId;
}

function proposeFixture(input, { preserveModelBindings = false } = {}) {
  const cloneableInput = { ...input };
  delete cloneableInput.aiClient;
  const executionInput = clone(cloneableInput);
  if (input.aiClient) executionInput.aiClient = input.aiClient;
  if (executionInput.modelAnalysis) {
    if (preserveModelBindings) {
      executionInput.modelAnalysisVerification = modelVerification(executionInput);
    } else {
      bindModelAnalysis(executionInput);
    }
  }
  return proposeCatalogChanges(executionInput, { now: FIXTURE_NOW });
}

test("requires an explicit current run timestamp after all evidence and within the workflow window", () => {
  const missing = makeProposalFixture({ candidateCount: 1 });
  missing.workflowStartedAt = "2026-08-27T11:55:00.000Z";
  delete missing.generatedAt;
  assert.throws(() => proposeCatalogChanges(missing, {
    now: "2026-08-27T12:05:00.000Z",
  }), (error) => error instanceof CatalogProposalError && error.code === "GENERATED_AT_REQUIRED");

  const invalid = makeProposalFixture({ candidateCount: 1 });
  invalid.generatedAt = "not-a-timestamp";
  assert.throws(() => proposeCatalogChanges(invalid, {
    now: "2026-08-27T12:05:00.000Z",
  }), (error) => error instanceof CatalogProposalError && error.code === "GENERATED_AT_INVALID");

  const dateOnly = makeProposalFixture({ candidateCount: 1 });
  dateOnly.generatedAt = "2026-08-27";
  assert.throws(() => proposeCatalogChanges(dateOnly, {
    now: "2026-08-27T12:05:00.000Z",
  }), (error) => error instanceof CatalogProposalError && error.code === "GENERATED_AT_INVALID");

  const invalidEvidence = makeProposalFixture({ candidateCount: 1 });
  invalidEvidence.health.entries[0].checkedAt = "not-a-timestamp";
  assert.throws(() => proposeCatalogChanges(invalidEvidence, {
    now: "2026-08-27T12:05:00.000Z",
  }), (error) => error instanceof CatalogProposalError && error.code === "EVIDENCE_TIMESTAMP_INVALID");

  const futureEvidenceField = makeProposalFixture({ candidateCount: 1 });
  futureEvidenceField.discovery.evaluatedAt = "2026-08-27T12:00:01.000Z";
  assert.throws(() => proposeCatalogChanges(futureEvidenceField, {
    now: "2026-08-27T12:05:00.000Z",
  }), (error) => error instanceof CatalogProposalError && error.code === "GENERATED_AT_BEFORE_EVIDENCE");

  const beforeEvidence = makeProposalFixture({ candidateCount: 1 });
  beforeEvidence.workflowStartedAt = "2026-08-27T11:55:00.000Z";
  beforeEvidence.generatedAt = "2026-08-27T11:59:59.000Z";
  assert.throws(() => proposeCatalogChanges(beforeEvidence, {
    now: "2026-08-27T12:05:00.000Z",
  }), (error) => error instanceof CatalogProposalError && error.code === "GENERATED_AT_BEFORE_EVIDENCE");

  const stale = makeProposalFixture({ candidateCount: 1 });
  stale.workflowStartedAt = "2026-08-27T11:55:00.000Z";
  assert.throws(() => proposeCatalogChanges(stale, {
    now: "2026-08-27T12:20:01.000Z",
  }), (error) => error instanceof CatalogProposalError && error.code === "GENERATED_AT_STALE");

  const outsideRun = makeProposalFixture({ candidateCount: 1 });
  outsideRun.workflowStartedAt = "2026-08-27T10:59:59.000Z";
  assert.throws(() => proposeCatalogChanges(outsideRun, {
    now: "2026-08-27T12:05:00.000Z",
  }), (error) => error instanceof CatalogProposalError && error.code === "GENERATED_AT_OUTSIDE_RUN");
});

test("requires exact upstream producer provenance and persists it in the proposal receipt", () => {
  const input = makeProposalFixture({ candidateCount: 1 });
  const result = proposeFixture(input);
  assert.deepEqual(result.receipt.upstreamArtifacts, input.upstreamArtifacts);
  assert.equal(result.receipt.trustedRepository, input.trustedRepository);
  assert.equal(result.receipt.trustedRef, input.trustedRef);
  assert.equal(result.receipt.trustedSha, input.trustedSha);

  for (const mutate of [
    (value) => { value.upstreamArtifacts.pop(); },
    (value) => { value.upstreamArtifacts[0].repository = "attacker/gallery"; },
    (value) => { value.upstreamArtifacts[0].workflowPath = ".github/workflows/other.yml"; },
    (value) => { value.upstreamArtifacts[0].sourceRef = "refs/heads/untrusted"; },
    (value) => { value.upstreamArtifacts[0].sourceSha = "f".repeat(40); },
    (value) => { value.upstreamArtifacts[0].artifactName = "gallery-discovery-latest"; },
    (value) => { value.upstreamArtifacts[0].digest = "sha256:unverified"; },
  ]) {
    const invalid = makeProposalFixture({ candidateCount: 1 });
    mutate(invalid);
    assert.throws(() => proposeFixture(invalid), (error) => (
      error instanceof CatalogProposalError && error.code === "UPSTREAM_ARTIFACTS_INVALID"
    ));
  }
});

test("rejects tampered model reports and receipts as one failed producer", () => {
  const cases = [
    ...[
      "discovery",
      "candidateGates",
      "activeCatalog",
      "retiredCatalog",
      "policy",
      "analysisSchema",
      "sourceDiscoveryArtifact",
    ].map((name, index) => ({
      name: `${name} input file hash`,
      reseal: true,
      mutate(input) {
        input.modelAnalysis.fileHashes[name] = `sha256:${String(index).repeat(64)}`;
      },
    })),
    ...["promptHash", "schemaHash", "policyHash", "catalogHash"].map((name, index) => ({
      name: `${name} recomputation`,
      reseal: true,
      mutate(input) {
        input.modelAnalysis.configuration[name] = `sha256:${String(index + 4).repeat(64)}`;
      },
    })),
    {
      name: "discovery artifact binding",
      reseal: true,
      mutate(input) {
        input.modelAnalysis.provenance.sourceDiscoveryArtifact.digest = `sha256:${"f".repeat(64)}`;
      },
    },
    {
      name: "model producer binding",
      reseal: true,
      mutate(input) { input.modelAnalysis.provenance.runId = "9999"; },
    },
    {
      name: "eligible set hash",
      reseal: true,
      mutate(input) { input.modelAnalysis.eligibleSet.hash = `sha256:${"e".repeat(64)}`; },
    },
    {
      name: "rejected ledger hash",
      reseal: true,
      mutate(input) { input.modelAnalysis.rejectedLedger.hash = `sha256:${"d".repeat(64)}`; },
    },
    {
      name: "duplicate analysis",
      reseal: true,
      mutate(input) { input.modelAnalysis.analyses[1] = clone(input.modelAnalysis.analyses[0]); },
    },
    {
      name: "extra analysis",
      reseal: true,
      mutate(input) {
        input.modelAnalysis.analyses.push({
          ...clone(input.modelAnalysis.analyses[0]),
          candidateId: "learn-document:extra",
        });
      },
    },
    {
      name: "raw report hash",
      mutate(input) { input.modelAnalysisReceipt.reportFileHash = `sha256:${"0".repeat(64)}`; },
    },
    {
      name: "canonical report fingerprint",
      mutate(input) { input.modelAnalysisReceipt.reportFingerprint = `sha256:${"0".repeat(64)}`; },
    },
    {
      name: "unexpected receipt data",
      mutate(input) { input.modelAnalysisReceipt.token = "must-not-be-accepted"; },
    },
    {
      name: "receipt rejected ledger",
      mutate(input) {
        input.modelAnalysisReceipt.rejectedLedger.entries.push({
          candidateId: "learn-document:invented",
          reasonCodes: ["SOURCE_TIMEOUT"],
        });
      },
    },
  ];

  for (const definition of cases) {
    const input = makeProposalFixture({ candidateCount: 2 });
    definition.mutate(input);
    if (definition.reseal) {
      input.modelAnalysisReceipt = createModelAnalysisReceipt(input.modelAnalysis);
    }
    const result = proposeFixture(input, { preserveModelBindings: true });
    assert.equal(result.report.status, "blocked", definition.name);
    assert.equal(result.report.summary.operations, 0, definition.name);
    assert.deepEqual(
      result.report.stage.reasonCodes,
      ["MODEL_ANALYSIS_RECEIPT_INVALID"],
      definition.name,
    );
  }
});

test("CLI recomputes model receipt hashes from the actual input file bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gallery-proposal-receipt-inputs-"));
  const input = makeProposalFixture({ candidateCount: 1 });
  const healthArtifacts = makeHealthArtifactFixture(input, { now: FIXTURE_NOW });
  const fileValues = {
    "discovery.json": input.discovery,
    "candidate-gates.json": input.candidateGates,
    "model-analysis.json": input.modelAnalysis,
    "model-analysis-receipt.json": input.modelAnalysisReceipt,
    "freshness.json": input.freshness,
    "active.json": input.activeCatalog,
    "retired.json": input.retired,
    "audit.json": input.audit,
    "exemptions.json": input.exemptions,
    "policy.json": input.policy,
    "analysis-schema.json": input.analysisSchema,
    "upstream-artifacts.json": input.upstreamArtifacts,
  };
  const filePath = (name) => path.join(root, name);
  const argumentsFor = (reportDirectory) => [
    "--report-directory", reportDirectory,
    "--discovery", filePath("discovery.json"),
    "--candidate-gates", filePath("candidate-gates.json"),
    "--model-analysis", filePath("model-analysis.json"),
    "--model-analysis-receipt", filePath("model-analysis-receipt.json"),
    "--health", filePath("proposed-gallery-health.json"),
    "--health-report", filePath("gallery-health-report.json"),
    "--health-receipt", filePath("gallery-health-receipt.json"),
    "--freshness", filePath("freshness.json"),
    "--active", filePath("active.json"),
    "--retired", filePath("retired.json"),
    "--audit", filePath("audit.json"),
    "--exemptions", filePath("exemptions.json"),
    "--policy", filePath("policy.json"),
    "--analysis-schema", filePath("analysis-schema.json"),
    "--upstream-artifacts", filePath("upstream-artifacts.json"),
    "--run-id", input.runId,
    "--generated-at", input.generatedAt,
    "--workflow-started-at", input.workflowStartedAt,
    "--trusted-repository", input.trustedRepository,
    "--trusted-ref", input.trustedRef,
    "--trusted-sha", input.trustedSha,
  ];

  try {
    await Promise.all(Object.entries(fileValues).map(([name, value]) => (
      writeFile(filePath(name), prettyJsonBytes(value))
    )));
    await Promise.all(Object.entries(healthArtifacts.artifactBytes).map(([name, bytes]) => (
      writeFile(filePath(name), bytes)
    )));
    const verified = await main(argumentsFor(filePath("verified")), {
      stdout: { write() {} },
      env: {},
      now: FIXTURE_NOW,
    });
    assert.equal(verified.result.report.status, "complete");

    await writeFile(
      filePath("discovery.json"),
      `${JSON.stringify(input.discovery, null, 2)} \n`,
    );
    const tampered = await main(argumentsFor(filePath("tampered")), {
      stdout: { write() {} },
      env: {},
      now: FIXTURE_NOW,
    });
    assert.equal(tampered.result.report.status, "blocked");
    assert.deepEqual(tampered.result.report.stage.reasonCodes, [
      "MODEL_ANALYSIS_RECEIPT_INVALID",
    ]);
    assert.equal(tampered.result.report.summary.operations, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI consumes the live three-file health artifact and blocks cleanly when policy is disabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gallery-proposal-live-health-"));
  const input = makeDisabledProposalFixture({ candidateCount: 1 });
  input.policy = repositoryPolicy;
  const healthArtifacts = makeHealthArtifactFixture(input, { now: FIXTURE_NOW });
  assert.equal(healthArtifacts.report.entries, undefined);
  assert.throws(() => proposeCatalogChanges({
    ...input,
    health: healthArtifacts.report,
  }, { now: FIXTURE_NOW }), (error) => (
    error instanceof CatalogProposalError &&
    error.code === "INPUT_INVALID" &&
    /health\.entries/.test(error.message)
  ));
  const filePath = (name) => path.join(root, name);
  const fileValues = {
    "discovery.json": input.discovery,
    "candidate-gates.json": input.candidateGates,
    "freshness.json": input.freshness,
    "active.json": input.activeCatalog,
    "retired.json": input.retired,
    "audit.json": input.audit,
    "exemptions.json": input.exemptions,
    "policy.json": input.policy,
    "analysis-schema.json": input.analysisSchema,
    "upstream-artifacts.json": input.upstreamArtifacts,
  };

  try {
    await Promise.all(Object.entries(fileValues).map(([name, value]) => (
      writeFile(filePath(name), prettyJsonBytes(value))
    )));
    await Promise.all(Object.entries(healthArtifacts.artifactBytes).map(([name, bytes]) => (
      writeFile(filePath(name), bytes)
    )));
    const outcome = await main([
      "--report-directory", filePath("proposal"),
      "--discovery", filePath("discovery.json"),
      "--candidate-gates", filePath("candidate-gates.json"),
      "--health", filePath("proposed-gallery-health.json"),
      "--health-report", filePath("gallery-health-report.json"),
      "--health-receipt", filePath("gallery-health-receipt.json"),
      "--freshness", filePath("freshness.json"),
      "--active", filePath("active.json"),
      "--retired", filePath("retired.json"),
      "--audit", filePath("audit.json"),
      "--exemptions", filePath("exemptions.json"),
      "--policy", filePath("policy.json"),
      "--analysis-schema", filePath("analysis-schema.json"),
      "--upstream-artifacts", filePath("upstream-artifacts.json"),
      "--run-id", input.runId,
      "--generated-at", input.generatedAt,
      "--workflow-started-at", input.workflowStartedAt,
      "--trusted-repository", input.trustedRepository,
      "--trusted-ref", input.trustedRef,
      "--trusted-sha", input.trustedSha,
    ], {
      stdout: { write() {} },
      env: {},
      now: FIXTURE_NOW,
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result.report.status, "blocked");
    assert.equal(outcome.result.report.summary.plans, 0);
    assert.equal(outcome.result.report.summary.operations, 0);
    assert.deepEqual(outcome.result.proposedState.health, healthArtifacts.proposedHealth);
    assert.deepEqual(outcome.result.receipt.healthArtifact, {
      report: healthArtifacts.receipt.outputs.report,
      proposedHealth: healthArtifacts.receipt.outputs.proposedHealth,
      receipt: {
        path: "gallery-health-receipt.json",
        sha256: hashHealthBytes(healthArtifacts.artifactBytes["gallery-health-receipt.json"]),
      },
    });
    validateCatalogProposalReport(outcome.result.report);
    validateCatalogProposalReceipt(outcome.result.receipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rejects missing, tampered, and mismatched live health artifacts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gallery-proposal-health-tamper-"));
  const input = makeDisabledProposalFixture({ candidateCount: 1 });
  input.policy = repositoryPolicy;
  const healthArtifacts = makeHealthArtifactFixture(input, { now: FIXTURE_NOW });
  const healthFile = (directory, name) => path.join(directory, name);
  const rewriteReport = async (directory, mutate) => {
    const reportPath = healthFile(directory, "gallery-health-report.json");
    const receiptPath = healthFile(directory, "gallery-health-receipt.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    mutate(report);
    const reportBytes = prettyJsonBytes(report);
    receipt.outputs.report.sha256 = hashHealthBytes(reportBytes);
    await Promise.all([
      writeFile(reportPath, reportBytes),
      writeFile(receiptPath, prettyJsonBytes(receipt)),
    ]);
  };
  const definitions = [
    {
      name: "missing report",
      mutate: (directory) => rm(healthFile(directory, "gallery-health-report.json")),
    },
    {
      name: "missing proposed state",
      mutate: (directory) => rm(healthFile(directory, "proposed-gallery-health.json")),
    },
    {
      name: "missing receipt",
      mutate: (directory) => rm(healthFile(directory, "gallery-health-receipt.json")),
    },
    {
      name: "malformed receipt",
      mutate: (directory) => writeFile(healthFile(directory, "gallery-health-receipt.json"), "{")
    },
    {
      name: "unexpected receipt field",
      mutate: (directory) => mutateJsonFile(
        healthFile(directory, "gallery-health-receipt.json"),
        (receipt) => { receipt.untrusted = true; },
      ),
    },
    {
      name: "receipt report path",
      mutate: (directory) => mutateJsonFile(
        healthFile(directory, "gallery-health-receipt.json"),
        (receipt) => { receipt.outputs.report.path = "other.json"; },
      ),
    },
    {
      name: "report raw bytes",
      mutate: async (directory) => {
        const reportPath = healthFile(directory, "gallery-health-report.json");
        await writeFile(reportPath, Buffer.concat([await readFile(reportPath), Buffer.from(" ")]));
      },
    },
    {
      name: "proposed state raw bytes",
      mutate: async (directory) => {
        const proposedPath = healthFile(directory, "proposed-gallery-health.json");
        await writeFile(proposedPath, Buffer.concat([await readFile(proposedPath), Buffer.from(" ")]));
      },
    },
    {
      name: "report output hash",
      mutate: (directory) => mutateJsonFile(
        healthFile(directory, "gallery-health-receipt.json"),
        (receipt) => { receipt.outputs.report.sha256 = `sha256:${"0".repeat(64)}`; },
      ),
    },
    {
      name: "proposed state output hash",
      mutate: (directory) => mutateJsonFile(
        healthFile(directory, "gallery-health-receipt.json"),
        (receipt) => { receipt.outputs.proposedHealth.sha256 = `sha256:${"0".repeat(64)}`; },
      ),
    },
    {
      name: "active catalog raw bytes",
      mutate: async (directory) => {
        const activePath = path.join(directory, "active.json");
        await writeFile(activePath, Buffer.concat([await readFile(activePath), Buffer.from(" ")]));
      },
    },
    {
      name: "catalog input hash",
      mutate: (directory) => mutateJsonFile(
        healthFile(directory, "gallery-health-receipt.json"),
        (receipt) => { receipt.inputs.catalog.sha256 = `sha256:${"0".repeat(64)}`; },
      ),
    },
    {
      name: "receipt mode",
      mutate: (directory) => mutateJsonFile(
        healthFile(directory, "gallery-health-receipt.json"),
        (receipt) => { receipt.mode = "write"; },
      ),
    },
    {
      name: "receipt mutation flag",
      mutate: (directory) => mutateJsonFile(
        healthFile(directory, "gallery-health-receipt.json"),
        (receipt) => { receipt.mutationPerformed = true; },
      ),
    },
    {
      name: "report mode",
      mutate: (directory) => rewriteReport(directory, (report) => { report.mode = "write"; }),
    },
    {
      name: "report mutation flag",
      mutate: (directory) => rewriteReport(
        directory,
        (report) => { report.mutationPerformed = true; },
      ),
    },
    {
      name: "report proposed-state binding",
      mutate: (directory) => rewriteReport(
        directory,
        (report) => { report.healthSnapshot.entries = []; },
      ),
    },
    {
      name: "report input binding",
      mutate: (directory) => rewriteReport(directory, (report) => {
        report.provenance.inputs.catalog.sha256 = `sha256:${"0".repeat(64)}`;
      }),
    },
    ...[
      ["repository", "attacker/gallery"],
      ["runId", "9999"],
      ["runAttempt", 2],
      ["sourceRef", "refs/heads/other"],
      ["sourceSha", "f".repeat(40)],
    ].map(([field, value]) => ({
      name: `re-sealed producer ${field}`,
      mutate: (directory) => resealHealthProvenance(directory, field, value),
    })),
  ];

  try {
    for (const [index, definition] of definitions.entries()) {
      await t.test(definition.name, async () => {
        const directory = path.join(root, `case-${String(index).padStart(2, "0")}`);
        await mkdir(directory);
        const fileValues = {
          "discovery.json": input.discovery,
          "candidate-gates.json": input.candidateGates,
          "freshness.json": input.freshness,
          "active.json": input.activeCatalog,
          "retired.json": input.retired,
          "audit.json": input.audit,
          "exemptions.json": input.exemptions,
          "policy.json": input.policy,
          "analysis-schema.json": input.analysisSchema,
          "upstream-artifacts.json": input.upstreamArtifacts,
        };
        await Promise.all([
          ...Object.entries(fileValues).map(([name, value]) => (
            writeFile(path.join(directory, name), prettyJsonBytes(value))
          )),
          ...Object.entries(healthArtifacts.artifactBytes).map(([name, bytes]) => (
            writeFile(path.join(directory, name), bytes)
          )),
        ]);
        await definition.mutate(directory);
        await assert.rejects(main([
          "--report-directory", path.join(directory, "proposal"),
          "--discovery", path.join(directory, "discovery.json"),
          "--candidate-gates", path.join(directory, "candidate-gates.json"),
          "--health", path.join(directory, "proposed-gallery-health.json"),
          "--health-report", path.join(directory, "gallery-health-report.json"),
          "--health-receipt", path.join(directory, "gallery-health-receipt.json"),
          "--freshness", path.join(directory, "freshness.json"),
          "--active", path.join(directory, "active.json"),
          "--retired", path.join(directory, "retired.json"),
          "--audit", path.join(directory, "audit.json"),
          "--exemptions", path.join(directory, "exemptions.json"),
          "--policy", path.join(directory, "policy.json"),
          "--analysis-schema", path.join(directory, "analysis-schema.json"),
          "--upstream-artifacts", path.join(directory, "upstream-artifacts.json"),
          "--run-id", input.runId,
          "--generated-at", input.generatedAt,
          "--workflow-started-at", input.workflowStartedAt,
          "--trusted-repository", input.trustedRepository,
          "--trusted-ref", input.trustedRef,
          "--trusted-sha", input.trustedSha,
        ], {
          stdout: { write() {} },
          env: {},
          now: FIXTURE_NOW,
        }), (error) => (
          error instanceof CatalogProposalError && error.code === "HEALTH_ARTIFACT_INVALID"
        ));
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal workflow selects only exact same-repository ref and SHA artifacts", async () => {
  const workflow = (await readFile(PROPOSAL_WORKFLOW_PATH, "utf8")).replaceAll("\r\n", "\n");

  for (const input of [
    "discovery_run_id",
    "health_run_id",
    "freshness_run_id",
    "model_analysis_run_id",
  ]) {
    assert.match(workflow, new RegExp(`^      ${input}:\\r?$`, "m"));
  }
  assert.match(workflow, /^permissions:\r?\n  contents: read\r?\n  actions: read\r?$/m);
  assert.doesNotMatch(workflow, /\b(?:contents|actions|checks|pull-requests|id-token): write\b/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.|pull_request_target|gh run download/);
  assert.doesNotMatch(workflow, /download_latest|regenerate|startsWith|sort \| head/);
  for (const binding of [
    ".repository.full_name",
    ".head_repository.full_name",
    ".workflow_id",
    ".path",
    ".head_branch",
    ".head_sha",
    ".conclusion",
    ".run_attempt",
    ".artifactName",
    ".artifactId",
    ".digest",
  ]) {
    assert.match(workflow, new RegExp(binding.replaceAll(".", "\\.")));
  }
  assert.match(workflow, /sha256sum/);
  assert.match(workflow, /upstream-artifact-diagnostics\.json/);
  assert.match(workflow, /--upstream-artifacts/);
  assert.match(workflow, /--trusted-sha/);
  assert.match(workflow, /--trusted-ref/);
  assert.match(workflow, /--workflow-started-at/);
  assert.match(workflow, /--analysis-schema/);
  assert.match(
    workflow,
    /"gallery-health-report\.json,proposed-gallery-health\.json,gallery-health-receipt\.json"\s*\\\n\s*"true"/,
  );
  assert.match(workflow, /health="\$\(single_file proposal-inputs\/health proposed-gallery-health\.json\)"/);
  assert.match(workflow, /--health-report "\$health_report"/);
  assert.match(workflow, /--health-receipt "\$health_receipt"/);
  assert.match(workflow, /if: always\(\)/);

  const verification = workflow.indexOf(
    "      - name: Verify trusted default-branch SHA and discovery artifact metadata",
  );
  const checkout = workflow.indexOf("      - name: Check out exact verified default-branch SHA");
  const setup = workflow.indexOf("      - name: Set up Node.js");
  const install = workflow.indexOf("      - name: Install dependencies");
  const resolution = workflow.indexOf("      - name: Resolve and verify exact upstream artifacts");
  const proposal = workflow.indexOf("      - name: Generate report-only catalog proposals");
  for (const [name, index] of Object.entries({
    verification,
    checkout,
    setup,
    install,
    resolution,
    proposal,
  })) {
    assert.notEqual(index, -1, `Missing ${name} workflow step`);
  }
  assert(verification < checkout);
  assert(checkout < setup);
  assert(setup < install);
  assert(install < resolution);
  assert(resolution < proposal);
  const trustedShell = workflow.slice(verification, checkout);
  assert.match(trustedShell, /gh api "repos\/\$\{GH_REPO\}"/);
  assert.match(trustedShell, /branches\/\$\{encoded_branch\}/);
  assert.match(trustedShell, /gallery-discovery-\$\{discovery_run_id\}-\$\{discovery_run_attempt\}/);
  assert.match(trustedShell, /\.digest \| test\("\^sha256:/);
  assert.doesNotMatch(trustedShell, /^\s*(?:node|npm|git)\s/m);
  assert.match(
    workflow.slice(checkout, setup),
    /ref: \$\{\{ steps\.trust\.outputs\.trusted_sha \}\}/,
  );
});

function retirementProvenance() {
  return {
    decisionRunUrl: "https://github.com/example/gallery/actions/runs/123456789",
    decisionPullRequestUrl: "https://github.com/example/gallery/pull/42",
    decisionRepositoryOwner: "example",
    decisionRepositoryName: "gallery",
    decisionRunId: "123456789",
    decisionPullRequestNumber: "42",
  };
}

async function recursiveFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await recursiveFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

test("partitions 146 accepted inputs into six bounded plans and a hash-chained audit", () => {
  const input = makeProposalFixture({ candidateCount: 146 });
  const untouched = clone(input);
  const existingIds = new Set(input.activeCatalog.map((record) => record.id));
  assert(input.health.entries.every((entry) => existingIds.has(entry.galleryId)));
  assert(input.freshness.entries.every((entry) => existingIds.has(entry.galleryId)));
  const result = proposeFixture(input);

  assert.deepEqual(input, untouched);
  assert.equal(result.report.status, "complete");
  assert.equal(result.report.stage.status, "completed");
  assert.equal(result.report.summary.candidates, 146);
  assert.equal(result.report.summary.plannedCandidates, 146);
  assert.equal(result.report.summary.rejectedCandidates, 0);
  assert.equal(result.report.summary.operations, 146);
  assert.equal(result.report.summary.plans, 6);
  assert.deepEqual(result.plans.map((plan) => plan.operations.length), [25, 25, 25, 25, 25, 21]);
  assert(result.plans.every((plan) => plan.operations.length <= 25));
  assert.equal(result.proposedState.activeCatalog.length, input.activeCatalog.length + 146);
  assert.equal(result.proposedState.audit.entries.length, 6);
  assert.strictEqual(validateCatalogProposalReport(result.report), result.report);
  assert.strictEqual(validateCatalogProposalReceipt(result.receipt), result.receipt);
  assert.strictEqual(verifyAuditLog(result.proposedState.audit, {
    trustedRepository: input.trustedRepository,
  }), result.proposedState.audit);
  for (let index = 1; index < result.proposedState.audit.entries.length; index += 1) {
    assert.equal(
      result.proposedState.audit.entries[index].previousHash,
      result.proposedState.audit.entries[index - 1].entryHash,
    );
  }
});

test("publishes a healthy available candidate without synthesizing health or freshness scores", () => {
  const input = makeProposalFixture({ candidateCount: 1 });
  input.generatedAt = "2026-08-27T12:01:00.000Z";
  const candidate = input.discovery.candidates[0];
  assert.equal(input.health.entries.some((entry) => entry.galleryId === candidate.metadata.galleryId), false);
  assert.equal(input.freshness.entries.some((entry) => entry.galleryId === candidate.metadata.galleryId), false);

  const result = proposeFixture(input);
  const operation = flattenedOperations(result)[0];
  const availability = input.candidateGates.eligible[0].availability;

  assert.equal(operation.type, "publish");
  assert.equal(operation.healthAfter, null);
  assert.deepEqual(operation.candidateAvailability, {
    candidateId: candidate.identityKey,
    source: candidate.canonicalUrl,
    checkedAt: availability.checkedAt,
    classification: "healthy",
    statusCode: 200,
    reasonCode: null,
  });
  assert.equal(operation.after.lastVerified, availability.checkedAt);
  assert.equal(operation.evidenceReferences.some((entry) => entry.kind === "health"), false);
  assert.equal(operation.evidenceReferences.some((entry) => entry.kind === "freshness"), false);
  assert(operation.evidenceReferences.some((entry) => entry.kind === "candidate-availability"));
  assert(operation.evidenceReferences.some((entry) => entry.kind === "candidate-deterministic-gate"));
  assert.equal("healthScore" in operation, false);
  assert.equal("components" in operation, false);
  assert.equal(
    result.proposedState.health.entries.some((entry) => entry.galleryId === candidate.metadata.galleryId),
    false,
  );
});

test("partial candidate coverage creates publish-only plans and blocks every existing-record path", () => {
  const input = makeProposalFixture({ candidateCount: 4 });
  const updateTarget = makeRecord(
    "partial-update",
    "https://learn.microsoft.com/azure/cosmos-db/partial-update",
  );
  const updateHealth = makeHealthEntry(updateTarget.id, updateTarget.canonicalSource);
  const updateFreshness = makeFreshnessEntry(updateHealth);
  input.activeCatalog.push(updateTarget);
  input.health.entries.push(updateHealth);
  input.freshness.entries.push(updateFreshness);
  input.freshness.healthSnapshot.entries.push(clone(updateHealth));
  for (const candidate of [input.discovery.candidates[0], input.candidateGates.eligible[0].candidate]) {
    candidate.metadata.galleryId = updateTarget.id;
  }
  input.modelAnalysis.analyses[0].recommendation = "update";
  input.modelAnalysis.analyses[0].reasonCodes = ["AI_UPDATE_APPROVED"];

  const restoreTarget = makeRecord(
    "partial-restore",
    "https://learn.microsoft.com/azure/cosmos-db/partial-restore",
    "retired",
  );
  const restoreHealth = makeHealthEntry(restoreTarget.id, restoreTarget.canonicalSource);
  const restoreFreshness = makeFreshnessEntry(restoreHealth);
  input.retired.entries.push({
    record: restoreTarget,
    retiredAt: "2026-08-01T00:00:00.000Z",
    retentionUntil: "2027-08-01",
    reasonCodes: ["PREVIOUS_RETIREMENT"],
    evidence: [{
      observedAt: "2026-08-01T00:00:00.000Z",
      source: restoreTarget.canonicalSource,
      reason: "health",
    }],
    supersededBy: null,
    decisionRunUrl: "https://github.com/example/gallery/actions/runs/100",
    decisionPullRequestUrl: "https://github.com/example/gallery/pull/10",
  });
  input.health.entries.push(restoreHealth);
  input.freshness.entries.push(restoreFreshness);
  input.freshness.healthSnapshot.entries.push(clone(restoreHealth));
  for (const candidate of [input.discovery.candidates[1], input.candidateGates.eligible[1].candidate]) {
    candidate.metadata.galleryId = restoreTarget.id;
  }
  input.modelAnalysis.analyses[1].recommendation = "update";
  input.modelAnalysis.analyses[1].reasonCodes = ["AI_UPDATE_APPROVED"];

  for (const [id, status, recommendation] of [
    ["partial-quarantine", "quarantined", "quarantine"],
    ["partial-retire", "retired", "retire"],
  ]) {
    const record = makeRecord(id, `https://learn.microsoft.com/azure/cosmos-db/${id}`);
    const health = makeHealthEntry(record.id, record.canonicalSource, status);
    const freshness = makeFreshnessEntry(health, recommendation);
    input.activeCatalog.push(record);
    input.health.entries.push(health);
    input.freshness.entries.push(freshness);
    input.freshness.healthSnapshot.entries.push(clone(health));
  }
  input.retirementProvenance = retirementProvenance();
  const rejectedId = rejectCandidateAsIndeterminate(input, 3);
  const originalActive = clone(input.activeCatalog);
  const originalRetired = clone(input.retired);

  const result = proposeFixture(input);
  const operations = flattenedOperations(result);

  assert.equal(result.report.status, "complete");
  assert.deepEqual(result.report.stage.reasonCodes, ["CANDIDATE_COVERAGE_PARTIAL_PUBLISH_ONLY"]);
  assert.deepEqual(operations.map((operation) => operation.type), ["publish"]);
  assert.equal(operations[0].targetId, input.discovery.candidates[2].metadata.galleryId);
  for (const candidate of input.discovery.candidates.slice(0, 2)) {
    assert.deepEqual(
      ledgerEntry(result, "candidate", candidate.identityKey).reasonCodes,
      ["CANDIDATE_COVERAGE_PARTIAL_PUBLISH_ONLY"],
    );
  }
  assert.deepEqual(ledgerEntry(result, "candidate", rejectedId).reasonCodes, ["SOURCE_TIMEOUT"]);
  for (const record of originalActive) {
    assert.deepEqual(
      result.proposedState.activeCatalog.find((candidate) => candidate.id === record.id),
      record,
    );
  }
  assert.deepEqual(result.proposedState.retired, originalRetired);
  assert.equal(operations.some((operation) => (
    ["update", "restore", "quarantine", "retire"].includes(operation.type)
  )), false);
});

test("existing changes require independently complete health and freshness evidence", () => {
  const input = makeProposalFixture({ candidateCount: 2 });
  retargetFirstCandidateForUpdate(input, input.activeCatalog[0]);
  input.health.status = "partial";

  const result = proposeFixture(input);
  const operations = flattenedOperations(result);

  assert.equal(result.report.status, "complete");
  assert.deepEqual(result.report.stage.reasonCodes, ["HEALTH_FRESHNESS_INCOMPLETE_PUBLISH_ONLY"]);
  assert.deepEqual(operations.map((operation) => operation.type), ["publish"]);
  assert.deepEqual(
    ledgerEntry(result, "candidate", input.discovery.candidates[0].identityKey).reasonCodes,
    ["HEALTH_FRESHNESS_INCOMPLETE_PUBLISH_ONLY"],
  );
});

test("fails candidate availability closed when evidence is missing, indeterminate, mismatched, or scored", () => {
  const cases = [
    {
      reason: "CANDIDATE_AVAILABILITY_MISSING",
      mutate(input) { delete input.candidateGates.eligible[0].availability; },
    },
    {
      reason: "CANDIDATE_AVAILABILITY_INDETERMINATE",
      mutate(input) {
        Object.assign(input.candidateGates.eligible[0].availability, {
          classification: "indeterminate",
          statusCode: null,
          reasonCode: "SOURCE_TIMEOUT",
        });
      },
    },
    {
      reason: "CANDIDATE_AVAILABILITY_UNHEALTHY",
      mutate(input) {
        Object.assign(input.candidateGates.eligible[0].availability, {
          classification: "definitive-failure",
          statusCode: 404,
          reasonCode: "SOURCE_HTTP_404",
        });
      },
    },
    {
      reason: "CANDIDATE_AVAILABILITY_TIMESTAMP_MISMATCH",
      mutate(input) {
        input.candidateGates.eligible[0].availability.checkedAt = "2026-08-27T11:59:59.000Z";
      },
    },
    {
      reason: "CANDIDATE_AVAILABILITY_TIMESTAMP_MISMATCH",
      mutate(input) { input.candidateGates.startedAt = "2026-08-27T11:59:59.000Z"; },
    },
    {
      reason: "CANDIDATE_AVAILABILITY_SCORE_UNSUPPORTED",
      mutate(input) { input.candidateGates.eligible[0].availability.qualityScore = 1; },
    },
  ];

  for (const definition of cases) {
    const input = makeProposalFixture({ candidateCount: 1 });
    const candidateId = input.discovery.candidates[0].identityKey;
    definition.mutate(input);
    const result = proposeFixture(input);

    assert.equal(result.report.summary.operations, 0, definition.reason);
    assert.equal(result.report.summary.rejectedCandidates, 1, definition.reason);
    assert(
      ledgerEntry(result, "candidate", candidateId).reasonCodes.includes(definition.reason),
      definition.reason,
    );
  }
});

test("requires scheduled health and freshness evidence for an existing candidate target", () => {
  const input = makeProposalFixture({ candidateCount: 1 });
  const target = input.activeCatalog[0];
  retargetFirstCandidateForUpdate(input, target);
  input.health.entries = input.health.entries.filter((entry) => entry.galleryId !== target.id);
  input.freshness.entries = input.freshness.entries.filter((entry) => entry.galleryId !== target.id);
  input.freshness.healthSnapshot.entries = input.freshness.healthSnapshot.entries
    .filter((entry) => entry.galleryId !== target.id);

  const result = proposeFixture(input);
  assert.equal(result.report.summary.operations, 0);
  assert.deepEqual(
    ledgerEntry(result, "candidate", input.discovery.candidates[0].identityKey).reasonCodes,
    ["FRESHNESS_DECISION_MISSING", "HEALTH_DECISION_MISSING"],
  );
});

test("uses candidate availability for an update only after matching scheduled target evidence", () => {
  const input = makeProposalFixture({ candidateCount: 1 });
  const target = makeRecord(
    "existing-update",
    "https://learn.microsoft.com/azure/cosmos-db/existing-update",
  );
  const targetHealth = makeHealthEntry(target.id, target.canonicalSource);
  const targetFreshness = makeFreshnessEntry(targetHealth);
  input.activeCatalog.push(target);
  input.health.entries.push(targetHealth);
  input.freshness.entries.push(targetFreshness);
  input.freshness.healthSnapshot.entries.push(clone(targetHealth));
  retargetFirstCandidateForUpdate(input, target);

  const candidate = input.discovery.candidates[0];
  const mismatched = clone(input);
  const candidateSource = candidate.canonicalUrl;
  const mismatchedHealth = mismatched.health.entries.find((entry) => entry.galleryId === target.id);
  const mismatchedFreshness = mismatched.freshness.entries.find((entry) => entry.galleryId === target.id);
  const mismatchedSnapshot = mismatched.freshness.healthSnapshot.entries
    .find((entry) => entry.galleryId === target.id);
  for (const health of [mismatchedHealth, mismatchedFreshness.health, mismatchedSnapshot]) {
    health.canonicalSource = candidateSource;
    health.evidence.forEach((entry) => { entry.source = candidateSource; });
  }
  mismatchedFreshness.canonicalSource = candidateSource;
  const mismatchedResult = proposeFixture(mismatched);
  assert.deepEqual(
    ledgerEntry(mismatchedResult, "candidate", candidate.identityKey).reasonCodes,
    ["FRESHNESS_DECISION_TARGET_MISMATCH", "HEALTH_DECISION_TARGET_MISMATCH"],
  );

  const result = proposeFixture(input);
  const operation = flattenedOperations(result)[0];

  assert.equal(result.report.summary.operations, 1);
  assert.equal(operation.type, "update");
  assert.equal(operation.before.canonicalSource, target.canonicalSource);
  assert.equal(operation.after.canonicalSource, candidate.canonicalUrl);
  assert.equal(operation.healthAfter.canonicalSource, candidate.canonicalUrl);
  assert.equal(operation.healthAfter.checkedAt, input.generatedAt);
  assert.equal(operation.healthAfter.healthScore, targetHealth.healthScore);
  assert.deepEqual(operation.healthAfter.components, targetHealth.components);
  assert.equal(
    operation.evidenceReferences.find((entry) => entry.kind === "health").source,
    target.canonicalSource,
  );
  assert.equal(
    operation.evidenceReferences.find((entry) => entry.kind === "freshness").source,
    target.canonicalSource,
  );
  assert.equal(operation.candidateAvailability.source, candidate.canonicalUrl);
});

test("rejects stale original scheduled evidence before projecting an existing update", () => {
  const input = makeProposalFixture({ candidateCount: 1 });
  const target = input.activeCatalog[0];
  retargetFirstCandidateForUpdate(input, target);
  const targetHealth = input.health.entries.find((entry) => entry.galleryId === target.id);
  targetHealth.checkedAt = "2026-07-27T11:59:59.000Z";
  targetHealth.evidence.forEach((entry) => {
    entry.observedAt = targetHealth.checkedAt;
  });

  const result = proposeFixture(input);

  assert.equal(result.report.summary.operations, 0);
  assert.deepEqual(
    ledgerEntry(result, "candidate", input.discovery.candidates[0].identityKey).reasonCodes,
    ["MISSING_GATE"],
  );
  assert.deepEqual(result.proposedState.health, input.health);
});

test("restores an existing retired target only with matching scheduled target evidence", () => {
  const input = makeProposalFixture({ candidateCount: 1 });
  const target = makeRecord(
    "existing-restore",
    "https://learn.microsoft.com/azure/cosmos-db/existing-restore",
    "retired",
  );
  const targetHealth = makeHealthEntry(target.id, target.canonicalSource);
  const targetFreshness = makeFreshnessEntry(targetHealth);
  input.retired.entries.push({
    record: target,
    retiredAt: "2026-08-01T00:00:00.000Z",
    retentionUntil: "2027-08-01",
    reasonCodes: ["PREVIOUS_RETIREMENT"],
    evidence: [{
      observedAt: "2026-08-01T00:00:00.000Z",
      source: target.canonicalSource,
      reason: "health",
    }],
    supersededBy: null,
    decisionRunUrl: "https://github.com/example/gallery/actions/runs/100",
    decisionPullRequestUrl: "https://github.com/example/gallery/pull/10",
  });
  input.health.entries.push(targetHealth);
  input.freshness.entries.push(targetFreshness);
  input.freshness.healthSnapshot.entries.push(clone(targetHealth));
  retargetFirstCandidateForUpdate(input, target);

  const candidate = input.discovery.candidates[0];
  const result = proposeFixture(input);
  const operation = flattenedOperations(result)[0];

  assert.equal(result.report.summary.operations, 1);
  assert.equal(operation.type, "restore");
  assert.equal(operation.before.lifecycleStatus, "retired");
  assert.equal(operation.after.lifecycleStatus, "active");
  assert.equal(operation.healthAfter.canonicalSource, candidate.canonicalUrl);
});

test("uses the repository default policy to emit a blocked schema-valid zero-plan report without AI", () => {
  const input = makeDisabledProposalFixture({ candidateCount: 2 });
  input.policy = repositoryPolicy;
  let aiCalls = 0;
  input.aiClient = { invoke() { aiCalls += 1; } };

  const result = proposeFixture(input);

  assert.equal(aiCalls, 0);
  assert.equal(result.report.status, "blocked");
  assert.equal(result.report.stage.status, "blocked");
  assert(result.report.stage.reasonCodes.includes("POLICY_EMERGENCY_DISABLED"));
  assert(result.report.stage.reasonCodes.includes("AI_AUTOMATION_DISABLED"));
  assert(result.report.stage.reasonCodes.includes("MUTATION_AUTOMATION_DISABLED"));
  assert.equal(result.report.upstream.modelAnalysis, "not-required");
  assert.equal(result.report.summary.plans, 0);
  assert.equal(result.report.summary.operations, 0);
  assert.deepEqual(result.plans, []);
  assert.deepEqual(result.proposedState.activeCatalog, input.activeCatalog);
  validateCatalogProposalReport(result.report);
});

test("partial source discovery or incomplete gate execution yields zero promotable plans", () => {
  const partial = makePartialProposalFixture({ candidateCount: 3 });
  const partialResult = proposeFixture(partial);
  assert.equal(partialResult.report.status, "partial");
  assert.deepEqual(partialResult.plans, []);
  assert.equal(partialResult.report.summary.operations, 0);
  assert(partialResult.report.reasonLedger.every((entry) => entry.disposition === "rejected"));

  const incomplete = makeProposalFixture({ candidateCount: 3 });
  incomplete.candidateGates.status = "incomplete";
  incomplete.candidateGates.coverageStatus = "partial";
  incomplete.candidateGates.summary.executedCandidateChecks -= 1;
  incomplete.candidateGates.summary.executedAvailabilityChecks -= 1;
  incomplete.candidateGates.summary.indeterminateAvailabilityChecks = 1;
  incomplete.candidateGates.summary.deadlineExceededAvailabilityChecks = 1;
  bindModelAnalysis(incomplete);
  const incompleteResult = proposeFixture(incomplete);
  assert.equal(incompleteResult.report.status, "incomplete");
  assert.equal(catalogProposalExitCode(incompleteResult.report), 2);
  assert.deepEqual(incompleteResult.plans, []);
  assert.equal(incompleteResult.report.summary.operations, 0);
  assert.deepEqual(incompleteResult.report.stage.reasonCodes, ["UPSTREAM_EXECUTION_INCOMPLETE"]);
  assert.deepEqual(incompleteResult.proposedState.audit, incomplete.audit);
});

test("fails the model artifact closed for missing analysis and rejects missing publication facts", () => {
  const missingAnalysis = makeProposalFixture({ candidateCount: 3 });
  missingAnalysis.modelAnalysis.analyses.pop();
  missingAnalysis.modelAnalysisReceipt = createModelAnalysisReceipt(missingAnalysis.modelAnalysis);
  const analysisResult = proposeFixture(missingAnalysis);
  assert.equal(analysisResult.report.status, "blocked");
  assert.equal(analysisResult.report.summary.operations, 0);
  assert.equal(analysisResult.report.summary.rejectedCandidates, 3);
  assert.deepEqual(analysisResult.report.stage.reasonCodes, ["MODEL_ANALYSIS_RECEIPT_INVALID"]);

  const missingFacts = makeProposalFixture({ candidateCount: 3 });
  const candidateId = missingFacts.discovery.candidates[0].identityKey;
  for (const candidate of [
    missingFacts.discovery.candidates[0],
    missingFacts.candidateGates.eligible[0].candidate,
  ]) {
    candidate.publishedAt = null;
    candidate.metadata.sourceOwner = null;
  }
  const factsResult = proposeFixture(missingFacts);
  assert.equal(factsResult.report.summary.operations, 2);
  assert.deepEqual(
    ledgerEntry(factsResult, "candidate", candidateId).reasonCodes,
    ["PUBLISHED_AT_MISSING"],
  );

  const nonMaterial = makeProposalFixture({ candidateCount: 1 });
  nonMaterial.modelAnalysis.analyses[0].relevance.material = false;
  nonMaterial.modelAnalysisReceipt = createModelAnalysisReceipt(nonMaterial.modelAnalysis);
  const nonMaterialResult = proposeFixture(nonMaterial);
  assert.equal(nonMaterialResult.report.summary.operations, 0);
  assert.deepEqual(
    ledgerEntry(
      nonMaterialResult,
      "candidate",
      nonMaterial.discovery.candidates[0].identityKey,
    ).reasonCodes,
    ["GATE_REJECTED"],
  );

  const noReport = makeProposalFixture({ candidateCount: 2 });
  noReport.modelAnalysis = null;
  noReport.modelAnalysisReceipt = null;
  const noReportResult = proposeFixture(noReport);
  assert.equal(noReportResult.report.status, "blocked");
  assert.equal(noReportResult.report.summary.operations, 0);
  assert.deepEqual(noReportResult.report.stage.reasonCodes, ["MODEL_ANALYSIS_MISSING"]);
});

test("does not invent retirement PR provenance and accepts it only when supplied", () => {
  const input = makeProposalFixture({ candidateCount: 2 });
  const retiringRecord = makeRecord(
    "retirement-proposal",
    "https://learn.microsoft.com/azure/cosmos-db/retirement-proposal",
  );
  const retiringHealth = makeHealthEntry(
    retiringRecord.id,
    retiringRecord.canonicalSource,
    "retired",
  );
  const retiringFreshness = makeFreshnessEntry(retiringHealth, "retire");
  input.activeCatalog.push(retiringRecord);
  input.health.entries.push(retiringHealth);
  input.freshness.entries.push(retiringFreshness);
  input.freshness.healthSnapshot.entries.push(clone(retiringHealth));

  const withoutProvenance = proposeFixture(input);
  assert.equal(withoutProvenance.report.summary.operations, 2);
  assert.equal(flattenedOperations(withoutProvenance).some((operation) => operation.type === "retire"), false);
  assert.deepEqual(
    ledgerEntry(withoutProvenance, "catalog", retiringRecord.id).reasonCodes,
    ["RETIREMENT_PROVENANCE_MISSING"],
  );

  input.retirementProvenance = retirementProvenance();
  const withProvenance = proposeFixture(input);
  const retirement = flattenedOperations(withProvenance)
    .find((operation) => operation.targetId === retiringRecord.id);
  assert.equal(retirement.type, "retire");
  assert.equal(retirement.decisionRunUrl, input.retirementProvenance.decisionRunUrl);
  assert.equal(retirement.decisionPullRequestUrl, input.retirementProvenance.decisionPullRequestUrl);
});

test("orders operations canonically and sequential proposals replay idempotently", () => {
  const input = makeProposalFixture({ candidateCount: 28 });
  const first = proposeFixture(input);
  const second = proposeFixture(clone(input));
  assert.deepEqual(second, first);

  const operations = flattenedOperations(first);
  for (let index = 1; index < operations.length; index += 1) {
    assert(compareCatalogOperations(operations[index - 1], operations[index]) <= 0);
  }

  let replayed = {
    activeRecords: clone(input.activeCatalog),
    retiredRecords: input.retired.entries.map((entry) => clone(entry.record)),
  };
  for (const plan of first.plans) {
    replayed = replayCatalogChangePlan(plan, replayed, {
      trustedRepository: input.trustedRepository,
    });
  }
  assert.deepEqual(replayed.activeRecords, first.proposedState.activeCatalog);
  assert.deepEqual(
    replayed.retiredRecords,
    first.proposedState.retired.entries.map((entry) => entry.record),
  );
  for (const plan of first.plans) {
    replayed = replayCatalogChangePlan(plan, replayed, {
      trustedRepository: input.trustedRepository,
    });
  }
  assert.deepEqual(replayed.activeRecords, first.proposedState.activeCatalog);

  const reordered = clone(input);
  reordered.discovery.candidates.reverse();
  reordered.candidateGates.eligible.reverse();
  reordered.health.entries.reverse();
  reordered.freshness.entries.reverse();
  reordered.freshness.healthSnapshot.entries.reverse();
  const reorderedOperations = flattenedOperations(proposeFixture(reordered));
  assert.deepEqual(
    reorderedOperations.map(({ type, targetId, after }) => ({ type, targetId, after })),
    operations.map(({ type, targetId, after }) => ({ type, targetId, after })),
  );
});

test("writes plans, receipt, and proposed state only beneath the explicit report directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gallery-proposal-"));
  const reportDirectory = path.join(root, "reports");
  const sentinelPath = path.join(root, "sentinel.txt");
  const fixture = makeProposalFixture({ candidateCount: 26 });
  const untouched = clone(fixture);
  await writeFile(sentinelPath, "unchanged\n");

  try {
    const first = await main([
      "--fixtures",
      "--report-directory",
      reportDirectory,
    ], {
      stdout: { write() {} },
      env: {},
      now: FIXTURE_NOW,
      loadFixture: async () => fixture,
    });
    assert.equal(first.exitCode, 0);
    assert.deepEqual(fixture, untouched);
    assert.deepEqual(await recursiveFiles(reportDirectory), [
      "plans/catalog-change-plan-001.json",
      "plans/catalog-change-plan-002.json",
      "proposal-receipt.json",
      "proposal-report.json",
      "proposed/catalog-audit.json",
      "proposed/gallery-health.json",
      "proposed/retired-templates.json",
      "proposed/templates.json",
    ]);
    assert.equal(await readFile(sentinelPath, "utf8"), "unchanged\n");
    assert.equal(
      hashCanonicalValue(JSON.parse(await readFile(path.join(reportDirectory, "proposal-report.json"), "utf8"))),
      first.result.receipt.reportFingerprint,
    );

    await main(["--fixtures", `--report-directory=${reportDirectory}`], {
      stdout: { write() {} },
      env: {},
      now: FIXTURE_NOW,
      loadFixture: async () => makeProposalFixture({ candidateCount: 1 }),
    });
    assert.equal((await recursiveFiles(reportDirectory)).includes("plans/catalog-change-plan-002.json"), false);
    assert.deepEqual((await readdir(root)).sort(), ["reports", "sentinel.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI requires an explicit report directory and has no mutation flags", async () => {
  await assert.rejects(main([], { stdout: { write() {} }, env: {} }), (error) => (
    error instanceof CatalogProposalError && error.code === "ARGUMENT_INVALID"
  ));
  for (const flag of ["--write", "--apply", "--mutate"]) {
    await assert.rejects(main([flag], { stdout: { write() {} }, env: {} }), (error) => (
      error instanceof CatalogProposalError && error.code === "WRITE_MODE_DISABLED"
    ));
  }
});