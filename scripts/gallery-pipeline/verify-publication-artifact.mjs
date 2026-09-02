#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyCatalogPlan } from "./apply-catalog-plan.mjs";
import {
  compareCatalogOperations,
  composeCatalogChangePlan,
  hashCanonicalValue,
  replayCatalogChangePlan,
  validateCatalogChangePlanPolicy,
} from "./build-catalog-change.mjs";
import {
  validateCatalogProposalReceipt,
  validateCatalogProposalReport,
} from "./propose-catalog-changes.mjs";
import { CATALOG_PLAN_PATH, CATALOG_STATE_FILES } from "./validate-catalog-diff.mjs";
import { appendAuditPlan, emptyAuditLog } from "./write-audit.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const SCHEMA_VERSION = "1.0.0";
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 32;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLAN_PATH_PATTERN = /^plans\/catalog-change-plan-([0-9]{3})\.json$/;
const GENERATED_BRANCH_PATTERN = /^automation\/gallery\/([1-9][0-9]*)-([1-9][0-9]*)$/;
const RECEIPT_INPUT_NAMES = Object.freeze([
  "discovery",
  "candidateGates",
  "modelAnalysis",
  "modelAnalysisReceipt",
  "modelAnalysisVerification",
  "health",
  "freshness",
  "activeCatalog",
  "retired",
  "audit",
  "exemptions",
  "policy",
  "analysisSchema",
  "retirementProvenance",
  "upstreamArtifacts",
]);
const UPSTREAM_SPECS = Object.freeze({
  discovery: Object.freeze({
    workflowPath: ".github/workflows/discover-content.yml",
    artifactPrefix: "gallery-discovery-",
  }),
  health: Object.freeze({
    workflowPath: ".github/workflows/scan-gallery-health.yml",
    artifactPrefix: "gallery-health-",
  }),
  freshness: Object.freeze({
    workflowPath: ".github/workflows/evaluate-repository-freshness.yml",
    artifactPrefix: "gallery-freshness-",
  }),
  modelAnalysis: Object.freeze({
    workflowPath: ".github/workflows/analyze-gallery-candidates.yml",
    artifactPrefix: "gallery-candidate-analysis-",
  }),
});
const DIAGNOSTIC_CHECK_NAMES = Object.freeze([
  "proposal-context",
  "discovery",
  "health",
  "freshness",
  "modelAnalysis",
]);
const STATIC_ARTIFACT_PATHS = Object.freeze([
  "proposal-report.json",
  "proposal-receipt.json",
  "upstream-artifact-diagnostics.json",
  "proposed/templates.json",
  "proposed/gallery-health.json",
  "proposed/retired-templates.json",
  "proposed/catalog-audit.json",
]);
const API_METADATA_KEYS = Object.freeze([
  "schemaVersion",
  "repository",
  "defaultBranch",
  "defaultSha",
  "producerWorkflow",
  "producerRun",
  "artifact",
]);
const PRODUCER_WORKFLOW_KEYS = Object.freeze(["id", "name", "path"]);
const PRODUCER_RUN_KEYS = Object.freeze([
  "id",
  "attempt",
  "event",
  "status",
  "conclusion",
  "workflowId",
  "workflowPath",
  "repository",
  "headRepository",
  "headBranch",
  "headSha",
  "runStartedAt",
  "updatedAt",
]);
const ARTIFACT_KEYS = Object.freeze(["id", "name", "digest", "expired"]);

export class PublicationArtifactError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PublicationArtifactError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new PublicationArtifactError(code, message, details);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("VALUE_INVALID", `${label} must be an object.`);
  }
  return value;
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || value.trim() !== value || value === "") {
    fail("VALUE_INVALID", `${label} must be a non-empty trimmed string.`);
  }
  if (pattern && !pattern.test(value)) {
    fail("VALUE_INVALID", `${label} has an invalid format.`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(requireObject(value, label)).sort();
  const expected = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    fail("VALUE_INVALID", `${label} keys do not match the required contract.`, { actual, expected });
  }
  return value;
}

function requireDateTime(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    fail("VALUE_INVALID", `${label} must be a UTC date-time.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail("VALUE_INVALID", `${label} must be a valid UTC date-time.`);
  }
  return timestamp;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(filePath, label, { missingValue } = {}) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" && missingValue !== undefined) {
      return { bytes: null, value: clone(missingValue), missing: true };
    }
    fail("FILE_READ_FAILED", `Could not read ${label}: ${error.message}`);
  }
  if (bytes.length > MAX_FILE_BYTES) {
    fail("ARTIFACT_LIMIT_EXCEEDED", `${label} exceeds the per-file size limit.`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    fail("JSON_INVALID", `${label} is not valid JSON: ${error.message}`);
  }
}

async function artifactFiles(rootDirectory) {
  const files = [];
  let totalBytes = 0;

  async function walk(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        fail("ARTIFACT_SYMLINK", `Artifact entry ${relativePath} must not be a symbolic link.`);
      }
      if (metadata.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        fail("ARTIFACT_ENTRY_INVALID", `Artifact entry ${relativePath} is not a regular file.`);
      }
      if (
        relativePath.includes("\\") ||
        relativePath.startsWith("/") ||
        path.posix.normalize(relativePath) !== relativePath ||
        relativePath.split("/").includes("..")
      ) {
        fail("ARTIFACT_PATH_INVALID", `Artifact entry ${relativePath} has an unsafe path.`);
      }
      totalBytes += metadata.size;
      files.push(relativePath);
      if (metadata.size > MAX_FILE_BYTES || totalBytes > MAX_ARTIFACT_BYTES || files.length > MAX_ARTIFACT_FILES) {
        fail("ARTIFACT_LIMIT_EXCEEDED", "The publication artifact exceeds its file or size limit.");
      }
    }
  }

  await walk(rootDirectory);
  return files.sort();
}

function verifyApiMetadata(metadata) {
  requireExactKeys(metadata, API_METADATA_KEYS, "API metadata");
  if (metadata.schemaVersion !== SCHEMA_VERSION) {
    fail("API_METADATA_INVALID", "API metadata schemaVersion is unsupported.");
  }
  requireString(metadata.repository, "API metadata repository", REPOSITORY_PATTERN);
  requireString(metadata.defaultBranch, "API metadata defaultBranch");
  requireString(metadata.defaultSha, "API metadata defaultSha", GIT_SHA_PATTERN);

  const workflow = requireExactKeys(
    metadata.producerWorkflow,
    PRODUCER_WORKFLOW_KEYS,
    "API producer workflow",
  );
  requireString(workflow.id, "API producer workflow id", POSITIVE_INTEGER_PATTERN);
  if (workflow.name !== "Propose gallery changes (report only)") {
    fail("WORKFLOW_IDENTITY_INVALID", "The producer workflow name is not trusted.");
  }
  if (workflow.path !== ".github/workflows/propose-gallery-changes.yml") {
    fail("WORKFLOW_IDENTITY_INVALID", "The producer workflow path is not trusted.");
  }

  const run = requireExactKeys(metadata.producerRun, PRODUCER_RUN_KEYS, "API producer run");
  requireString(run.id, "API producer run id", POSITIVE_INTEGER_PATTERN);
  if (!Number.isSafeInteger(run.attempt) || run.attempt < 1) {
    fail("RUN_IDENTITY_INVALID", "The producer run attempt must be a positive integer.");
  }
  if (!["schedule", "workflow_dispatch"].includes(run.event)) {
    fail("RUN_IDENTITY_INVALID", "The producer run event is not trusted.");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    fail("RUN_IDENTITY_INVALID", "The producer run did not complete successfully.");
  }
  if (
    run.workflowId !== workflow.id ||
    run.workflowPath !== workflow.path ||
    run.repository !== metadata.repository ||
    run.headRepository !== metadata.repository ||
    run.headBranch !== metadata.defaultBranch ||
    run.headSha !== metadata.defaultSha
  ) {
    fail("RUN_IDENTITY_INVALID", "The producer run is not bound to the current default branch and workflow.");
  }
  const startedAt = requireDateTime(run.runStartedAt, "API producer runStartedAt");
  const updatedAt = requireDateTime(run.updatedAt, "API producer updatedAt");
  if (updatedAt < startedAt) {
    fail("RUN_IDENTITY_INVALID", "The producer run timestamps are inconsistent.");
  }

  const artifact = requireExactKeys(metadata.artifact, ARTIFACT_KEYS, "API artifact");
  requireString(artifact.id, "API artifact id", POSITIVE_INTEGER_PATTERN);
  requireString(artifact.digest, "API artifact digest", DIGEST_PATTERN);
  if (artifact.expired !== false) {
    fail("ARTIFACT_IDENTITY_INVALID", "The proposal artifact is expired.");
  }
  const expectedName = `gallery-proposal-${run.id}-${run.attempt}`;
  if (artifact.name !== expectedName) {
    fail("ARTIFACT_IDENTITY_INVALID", `The proposal artifact must be named ${expectedName}.`);
  }
  return { workflow, run, artifact, startedAt, updatedAt };
}

function verifyPolicy(policy) {
  const automation = requireObject(policy?.automation, "policy.automation");
  if (automation.emergencyDisable !== false) {
    fail("PUBLICATION_DISABLED", "Gallery publication is disabled by the emergency policy switch.");
  }
  if (automation.mutationMode !== "dry-run") {
    fail("PUBLICATION_DISABLED", "Gallery proposals must remain in report-only dry-run mode.");
  }
  if (automation.mutation?.automaticMerge !== true) {
    fail("PUBLICATION_DISABLED", "Gallery native auto-merge is disabled by policy.");
  }
}

function exactArtifactPaths(report) {
  const planPaths = report.plans.map((entry, index) => {
    const expectedPath = `plans/catalog-change-plan-${String(index + 1).padStart(3, "0")}.json`;
    if (entry.batchNumber !== index + 1 || entry.path !== expectedPath) {
      fail("BATCH_MANIFEST_INVALID", "Proposal batches must be contiguous and ordered from 001.");
    }
    return entry.path;
  });
  return [...STATIC_ARTIFACT_PATHS, ...planPaths].sort();
}

function verifyReceipt({ receipt, report, artifactValues }) {
  if (
    receipt.runId !== report.runId ||
    receipt.generatedAt !== report.generatedAt ||
    receipt.inputFingerprint !== report.inputFingerprint ||
    receipt.reportFingerprint !== hashCanonicalValue(report)
  ) {
    fail("RECEIPT_BINDING_INVALID", "The proposal receipt does not bind the report.");
  }

  const expectedOutputPaths = [
    "proposal-report.json",
    ...report.plans.map((entry) => entry.path),
    "proposed/templates.json",
    "proposed/gallery-health.json",
    "proposed/retired-templates.json",
    "proposed/catalog-audit.json",
  ].sort();
  const actualOutputPaths = receipt.outputs.map((entry) => entry.path).sort();
  if (
    new Set(actualOutputPaths).size !== actualOutputPaths.length ||
    !isDeepStrictEqual(actualOutputPaths, expectedOutputPaths)
  ) {
    fail("RECEIPT_BINDING_INVALID", "The proposal receipt output path set is not exact.");
  }
  for (const output of receipt.outputs) {
    if (output.fingerprint !== hashCanonicalValue(artifactValues.get(output.path))) {
      fail("RECEIPT_BINDING_INVALID", `Receipt fingerprint mismatch for ${output.path}.`);
    }
  }
  const inputNames = receipt.inputs.map((entry) => entry.name).sort();
  if (!isDeepStrictEqual(inputNames, [...RECEIPT_INPUT_NAMES].sort())) {
    fail("RECEIPT_BINDING_INVALID", "The proposal receipt input path set is not exact.");
  }
  const inputs = new Map(receipt.inputs.map((entry) => [entry.name, entry]));
  for (const name of RECEIPT_INPUT_NAMES.filter((name) => name !== "retirementProvenance")) {
    if (inputs.get(name)?.provided !== true) {
      fail("RECEIPT_BINDING_INVALID", `Required proposal input ${name} is not present.`);
    }
  }
  if (inputs.get("upstreamArtifacts")?.fingerprint !== hashCanonicalValue(receipt.upstreamArtifacts)) {
    fail("RECEIPT_BINDING_INVALID", "The proposal receipt does not bind its upstream artifact list.");
  }

  const expectedNames = Object.keys(UPSTREAM_SPECS).sort();
  const actualNames = receipt.upstreamArtifacts.map((artifact) => artifact.name).sort();
  const runIds = new Set();
  const artifactIds = new Set();
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    fail("RECEIPT_BINDING_INVALID", "The proposal receipt upstream producer set is not exact.");
  }
  for (const artifact of receipt.upstreamArtifacts) {
    const spec = UPSTREAM_SPECS[artifact.name];
    if (
      artifact.repository !== receipt.trustedRepository ||
      artifact.sourceRef !== receipt.trustedRef ||
      artifact.sourceSha !== receipt.trustedSha ||
      artifact.workflowPath !== spec.workflowPath ||
      artifact.artifactName !== `${spec.artifactPrefix}${artifact.runId}-${artifact.runAttempt}` ||
      runIds.has(artifact.runId) ||
      artifactIds.has(artifact.artifactId)
    ) {
      fail("RECEIPT_BINDING_INVALID", `Upstream artifact ${artifact.name} is not uniquely bound to the trusted producer context.`);
    }
    runIds.add(artifact.runId);
    artifactIds.add(artifact.artifactId);
  }
}

function verifyRunBindings({ metadata, api, report, receipt, diagnostics }) {
  const expectedRunId = `proposal-${api.run.id}-${api.run.attempt}`;
  if (report.runId !== expectedRunId || receipt.runId !== expectedRunId) {
    fail("RUN_BINDING_INVALID", "The proposal run ID does not match the API producer run.");
  }
  if (
    receipt.trustedRepository !== metadata.repository ||
    receipt.trustedRef !== `refs/heads/${metadata.defaultBranch}` ||
    receipt.trustedSha !== metadata.defaultSha ||
    Date.parse(receipt.workflowStartedAt) !== api.startedAt
  ) {
    fail("RUN_BINDING_INVALID", "The proposal receipt is not bound to the current trusted default branch run.");
  }
  const generatedAt = requireDateTime(receipt.generatedAt, "proposal generatedAt");
  if (generatedAt < api.startedAt || generatedAt > api.updatedAt) {
    fail("RUN_BINDING_INVALID", "The proposal generation timestamp is outside the producer run window.");
  }

  requireExactKeys(
    diagnostics,
    ["schemaVersion", "status", "repository", "trustedRef", "trustedSha", "workflowRunId", "workflowStartedAt", "checks"],
    "upstream diagnostics",
  );
  if (
    diagnostics.schemaVersion !== SCHEMA_VERSION ||
    diagnostics.status !== "verified" ||
    diagnostics.repository !== metadata.repository ||
    diagnostics.trustedRef !== receipt.trustedRef ||
    diagnostics.trustedSha !== receipt.trustedSha ||
    diagnostics.workflowRunId !== api.run.id ||
    diagnostics.workflowStartedAt !== api.run.runStartedAt ||
    !Array.isArray(diagnostics.checks) ||
    !isDeepStrictEqual(
      diagnostics.checks.map((check) => check?.name).sort(),
      [...DIAGNOSTIC_CHECK_NAMES].sort(),
    ) ||
    diagnostics.checks.some((check) => check?.status !== "verified")
  ) {
    fail("UPSTREAM_DIAGNOSTICS_INVALID", "Upstream artifact diagnostics are incomplete or unverified.");
  }
}

function replayPublicationPlan(plan, state, policy, trustedRepository) {
  let replayedState = clone(state);
  for (const [index, operation] of plan.operations.entries()) {
    const projectionPlan = composeCatalogChangePlan({
      runId: `${plan.runId}-verification-${String(index + 1).padStart(3, "0")}`,
      generatedAt: plan.generatedAt,
      operations: [operation],
      fingerprintInput: { publicationVerification: operation.operationId },
      trustedRepository,
    });
    if (operation.healthAfter === null) {
      const replayedRecords = replayCatalogChangePlan(projectionPlan, {
        activeRecords: replayedState.activeCatalog,
        retiredRecords: replayedState.retired.entries.map((entry) => entry.record),
      }, { trustedRepository });
      replayedState = {
        ...replayedState,
        activeCatalog: replayedRecords.activeRecords,
      };
      continue;
    }
    const audit = replayedState.audit;
    replayedState = applyCatalogPlan({
      plan: projectionPlan,
      activeCatalog: replayedState.activeCatalog,
      health: replayedState.health,
      retired: replayedState.retired,
      audit,
      policy,
      trustedRepository,
    });
    replayedState.audit = audit;
  }
  replayedState.audit = appendAuditPlan(replayedState.audit, plan, { trustedRepository });
  return replayedState;
}

function verifyBatches({ plans, report, receipt, policy, baseState }) {
  const operationIds = new Set();
  const orderedOperations = [];
  let replayedState = clone(baseState);
  for (const [index, plan] of plans.entries()) {
    const manifest = report.plans[index];
    validateCatalogChangePlanPolicy(plan, policy, { trustedRepository: receipt.trustedRepository });
    if (
      plan.runId !== manifest.runId ||
      plan.runId !== `${report.runId}-batch-${String(index + 1).padStart(3, "0")}` ||
      plan.inputFingerprint !== manifest.inputFingerprint ||
      plan.operations.length !== manifest.operationCount ||
      !isDeepStrictEqual(plan.operations.map((operation) => operation.operationId), manifest.operationIds) ||
      plan.operations.length > policy.batching.maxEntriesPerPullRequest
    ) {
      fail("BATCH_MANIFEST_INVALID", `Proposal batch ${index + 1} does not match its report manifest.`);
    }
    for (const operation of plan.operations) {
      if (operationIds.has(operation.operationId)) {
        fail("BATCH_MANIFEST_INVALID", `Duplicate operation ID ${operation.operationId}.`);
      }
      operationIds.add(operation.operationId);
      orderedOperations.push(operation);
    }
    replayedState = replayPublicationPlan(
      plan,
      replayedState,
      policy,
      receipt.trustedRepository,
    );
  }
  if (!isDeepStrictEqual(orderedOperations, [...orderedOperations].sort(compareCatalogOperations))) {
    fail("BATCH_ORDER_INVALID", "Operations are not deterministically ordered across proposal batches.");
  }
  return replayedState;
}

function verifyProposalSummary(report, plans) {
  if (report.status !== "complete" || report.stage.status !== "completed") {
    fail("PROPOSAL_NOT_PUBLISHABLE", "Only a complete proposal may be published.");
  }
  const operationCount = plans.reduce((total, plan) => total + plan.operations.length, 0);
  if (
    plans.length !== report.plans.length ||
    report.summary.plans !== plans.length ||
    report.summary.operations !== operationCount ||
    (plans.length === 0 && report.reasonLedger.some((entry) => entry.disposition === "planned"))
  ) {
    fail("BATCH_MANIFEST_INVALID", "Proposal report summary, ledger, and batch files are inconsistent.");
  }
  return operationCount;
}

function proposalBinding(metadata, report, receipt) {
  return {
    runId: metadata.producerRun.id,
    runAttempt: metadata.producerRun.attempt,
    artifactId: metadata.artifact.id,
    artifactName: metadata.artifact.name,
    artifactDigest: metadata.artifact.digest,
    reportRunId: report.runId,
    inputFingerprint: report.inputFingerprint,
    receiptFingerprint: hashCanonicalValue(receipt),
  };
}

async function writeNoPublicationPayload({ outputDirectory, metadata, report, receipt }) {
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    publishable: false,
    repository: metadata.repository,
    baseRef: `refs/heads/${metadata.defaultBranch}`,
    baseSha: metadata.defaultSha,
    branch: null,
    proposal: proposalBinding(metadata, report, receipt),
    batch: null,
    paths: [],
  };
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "publication-manifest.json"), prettyJson(manifest));
  return manifest;
}

async function writePublicationPayload({
  outputDirectory,
  metadata,
  report,
  receipt,
  firstPlan,
  baseState,
  firstBatchState,
}) {
  const branch = `automation/gallery/${metadata.producerRun.id}-${metadata.producerRun.attempt}`;
  if (!GENERATED_BRANCH_PATTERN.test(branch)) {
    fail("BRANCH_INVALID", "The generated publication branch is invalid.");
  }
  const payloadFiles = new Map([[CATALOG_PLAN_PATH, firstPlan]]);
  for (const [key, filePath] of Object.entries(CATALOG_STATE_FILES)) {
    if (!isDeepStrictEqual(baseState[key], firstBatchState[key])) {
      payloadFiles.set(filePath, firstBatchState[key]);
    }
  }
  if (payloadFiles.size === 1) {
    fail("PROPOSAL_NOT_PUBLISHABLE", "The first proposal batch does not change catalog state.");
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const paths = [];
  for (const [filePath, value] of [...payloadFiles].sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = Buffer.from(prettyJson(value));
    const destination = path.join(outputDirectory, ...filePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    paths.push({ path: filePath, digest: `sha256:${sha256(bytes)}` });
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    publishable: true,
    repository: metadata.repository,
    baseRef: `refs/heads/${metadata.defaultBranch}`,
    baseSha: metadata.defaultSha,
    branch,
    proposal: proposalBinding(metadata, report, receipt),
    batch: {
      number: 1,
      total: report.plans.length,
      runId: firstPlan.runId,
      operationCount: firstPlan.operations.length,
    },
    paths,
  };
  await writeFile(path.join(outputDirectory, "publication-manifest.json"), prettyJson(manifest));
  return manifest;
}

export async function verifyPublicationArtifact({
  artifactDirectory,
  artifactArchive,
  apiMetadataPath,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  outputDirectory,
}) {
  for (const [label, value] of Object.entries({
    artifactDirectory,
    artifactArchive,
    apiMetadataPath,
    repositoryRoot,
    outputDirectory,
  })) {
    if (typeof value !== "string" || value === "") {
      fail("ARGUMENT_INVALID", `${label} is required.`);
    }
  }

  const archiveMetadata = await stat(artifactArchive);
  if (!archiveMetadata.isFile() || archiveMetadata.size > MAX_ARTIFACT_BYTES) {
    fail("ARTIFACT_LIMIT_EXCEEDED", "The proposal artifact archive is invalid or too large.");
  }
  const [archiveBytes, metadataSnapshot] = await Promise.all([
    readFile(artifactArchive),
    readJson(apiMetadataPath, "API metadata"),
  ]);
  const metadata = metadataSnapshot.value;
  const api = verifyApiMetadata(metadata);
  if (`sha256:${sha256(archiveBytes)}` !== api.artifact.digest) {
    fail("ARTIFACT_DIGEST_INVALID", "The downloaded proposal artifact digest does not match the API.");
  }

  const files = await artifactFiles(artifactDirectory);
  const reportSnapshot = await readJson(path.join(artifactDirectory, "proposal-report.json"), "proposal report");
  const receiptSnapshot = await readJson(path.join(artifactDirectory, "proposal-receipt.json"), "proposal receipt");
  const diagnosticsSnapshot = await readJson(
    path.join(artifactDirectory, "upstream-artifact-diagnostics.json"),
    "upstream artifact diagnostics",
  );
  const report = validateCatalogProposalReport(reportSnapshot.value);
  const receipt = validateCatalogProposalReceipt(receiptSnapshot.value);
  const expectedFiles = exactArtifactPaths(report);
  if (!isDeepStrictEqual(files, expectedFiles)) {
    fail("ARTIFACT_PATH_SET_INVALID", "The proposal artifact path set is not exact.", {
      actual: files,
      expected: expectedFiles,
    });
  }

  const artifactValues = new Map([
    ["proposal-report.json", report],
    ["proposed/templates.json", (await readJson(path.join(artifactDirectory, "proposed", "templates.json"), "proposed templates")).value],
    ["proposed/gallery-health.json", (await readJson(path.join(artifactDirectory, "proposed", "gallery-health.json"), "proposed health")).value],
    ["proposed/retired-templates.json", (await readJson(path.join(artifactDirectory, "proposed", "retired-templates.json"), "proposed retired templates")).value],
    ["proposed/catalog-audit.json", (await readJson(path.join(artifactDirectory, "proposed", "catalog-audit.json"), "proposed audit")).value],
  ]);
  const plans = [];
  for (const manifest of report.plans) {
    const snapshot = await readJson(path.join(artifactDirectory, ...manifest.path.split("/")), manifest.path);
    plans.push(snapshot.value);
    artifactValues.set(manifest.path, snapshot.value);
  }

  verifyReceipt({ receipt, report, artifactValues });
  verifyRunBindings({ metadata, api, report, receipt, diagnostics: diagnosticsSnapshot.value });

  const baseSnapshots = await Promise.all([
    readJson(path.join(repositoryRoot, CATALOG_STATE_FILES.activeCatalog), "base templates"),
    readJson(path.join(repositoryRoot, CATALOG_STATE_FILES.health), "base health"),
    readJson(path.join(repositoryRoot, CATALOG_STATE_FILES.retired), "base retired templates"),
    readJson(
      path.join(repositoryRoot, CATALOG_STATE_FILES.audit),
      "base audit",
      { missingValue: emptyAuditLog() },
    ),
    readJson(path.join(repositoryRoot, ".github", "gallery-pipeline", "policy.json"), "publication policy"),
  ]);
  const [activeCatalog, health, retired, audit, policySnapshot] = baseSnapshots;
  const policy = policySnapshot.value;
  verifyPolicy(policy);
  const baseState = {
    activeCatalog: activeCatalog.value,
    health: health.value,
    retired: retired.value,
    audit: audit.value,
  };
  const operationCount = verifyProposalSummary(report, plans);
  if (operationCount === 0) {
    return writeNoPublicationPayload({
      outputDirectory,
      metadata,
      report,
      receipt,
    });
  }
  const replayedState = verifyBatches({ plans, report, receipt, policy, baseState });
  const proposedState = {
    activeCatalog: artifactValues.get("proposed/templates.json"),
    health: artifactValues.get("proposed/gallery-health.json"),
    retired: artifactValues.get("proposed/retired-templates.json"),
    audit: artifactValues.get("proposed/catalog-audit.json"),
  };
  if (!isDeepStrictEqual(replayedState, proposedState)) {
    fail("PROPOSAL_REPLAY_INVALID", "Proposal batches do not exactly replay to the proposed state snapshots.");
  }

  const firstBatchState = replayPublicationPlan(
    plans[0],
    baseState,
    policy,
    receipt.trustedRepository,
  );
  return writePublicationPayload({
    outputDirectory,
    metadata,
    report,
    receipt,
    firstPlan: plans[0],
    baseState,
    firstBatchState,
  });
}

function parseArguments(argv) {
  const names = new Map([
    ["--artifact-directory", "artifactDirectory"],
    ["--artifact-archive", "artifactArchive"],
    ["--api-metadata", "apiMetadataPath"],
    ["--repository-root", "repositoryRoot"],
    ["--output-directory", "outputDirectory"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = names.get(argv[index]);
    if (!name || !argv[index + 1] || argv[index + 1].startsWith("--") || options[name]) {
      fail("ARGUMENT_INVALID", `Invalid or duplicate argument ${argv[index]}.`);
    }
    options[name] = argv[index + 1];
    index += 1;
  }
  return options;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const manifest = await verifyPublicationArtifact(parseArguments(argv));
    stdout.write(`${JSON.stringify(manifest)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Publication artifact verification failed [${error.code ?? "ERROR"}]: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}