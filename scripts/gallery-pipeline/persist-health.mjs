import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { canonicalizeUrl } from "./shared/canonicalize.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const healthSchema = JSON.parse(await readFile(
  path.resolve(moduleDirectory, "..", "..", ".github", "gallery-pipeline", "health.schema.json"),
  "utf8",
));
const schemaAjv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(schemaAjv);
const validateHealthSchema = schemaAjv.compile(healthSchema);

const RECEIPT_VERSION = "1.0.0";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PRIOR_HEALTH_PATH = "static/gallery-health.json";
const CATALOG_PATH = "static/templates.json";

export const HEALTH_ARTIFACT_FILES = Object.freeze({
  report: "gallery-health-report.json",
  proposedHealth: "proposed-gallery-health.json",
  receipt: "gallery-health-receipt.json",
});

export class HealthPersistenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HealthPersistenceError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new HealthPersistenceError(code, message, details);
}

function clone(value) {
  return structuredClone(value);
}

function requireObject(value, name, code = "RECEIPT_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${name} must be an object.`);
  }
  return value;
}

function requireString(value, name, code = "RECEIPT_INVALID") {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${name} must be a non-empty string.`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, name, code = "RECEIPT_INVALID") {
  const actual = Object.keys(requireObject(value, name, code)).sort();
  const expected = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    fail(code, `${name} has missing or unexpected fields.`);
  }
}

function asBytes(value, name) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || typeof value === "string") return Buffer.from(value);
  fail("BYTES_REQUIRED", `${name} must be bytes or a string.`);
}

function prettyJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function hashHealthBytes(value) {
  return `sha256:${createHash("sha256").update(asBytes(value, "hash input")).digest("hex")}`;
}

function parseJsonBytes(value, name, code) {
  const bytes = asBytes(value, name);
  try {
    return { bytes, data: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    fail(code, `${name} is not valid JSON.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function dateMilliseconds(value, name, code) {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) fail(code, `${name} must be a valid date-time.`);
  return milliseconds;
}

function schemaMessage() {
  return (validateHealthSchema.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function validateHealthEnvelope(health, label, code) {
  if (!validateHealthSchema(health)) {
    fail(code, `${label} is invalid: ${schemaMessage()}`);
  }
  const ids = new Set();
  const observations = new Set();
  for (const entry of health.entries) {
    if (ids.has(entry.galleryId)) {
      fail("DUPLICATE_OBSERVATION", `${label} repeats gallery ID ${entry.galleryId}.`);
    }
    ids.add(entry.galleryId);
    for (const evidence of entry.evidence) {
      const key = JSON.stringify([
        entry.galleryId,
        evidence.kind,
        evidence.observedAt,
        canonicalizeUrl(evidence.source),
        evidence.value,
      ]);
      if (observations.has(key)) {
        fail("DUPLICATE_OBSERVATION", `${label} repeats an observation for ${entry.galleryId}.`);
      }
      observations.add(key);
    }

    const availability = entry.sourceState.availability;
    if (availability === "available" && (
      entry.consecutiveFindings !== 0 || entry.gracePeriodStartedAt !== null
    )) {
      fail(code, `${label} has confirmation state for available entry ${entry.galleryId}.`);
    }
    if (availability === "broken" && (
      entry.consecutiveFindings < 1 || entry.gracePeriodStartedAt === null
    )) {
      fail(code, `${label} is missing confirmation state for broken entry ${entry.galleryId}.`);
    }
    if ((entry.consecutiveFindings === 0) !== (entry.gracePeriodStartedAt === null)) {
      fail(code, `${label} has inconsistent confirmation state for ${entry.galleryId}.`);
    }
  }
  return health;
}

function catalogIdentity(records) {
  if (!Array.isArray(records)) fail("CATALOG_STATE_INVALID", "Catalog must be an array.");
  const identities = new Map();
  for (const record of records) {
    const source = record?.canonicalSource ?? record?.source ?? record?.website;
    if (typeof source !== "string" || source.trim() === "") {
      fail("CATALOG_STATE_INVALID", "Every catalog record must have a source URL.");
    }
    const canonicalSource = canonicalizeUrl(source);
    const galleryId = record?.id ?? record?.title ?? canonicalSource;
    if (typeof galleryId !== "string" || galleryId.trim() === "") {
      fail("CATALOG_STATE_INVALID", "Every catalog record must have a stable identity.");
    }
    if (identities.has(galleryId)) {
      fail("CATALOG_STATE_INVALID", `Catalog repeats gallery ID ${galleryId}.`);
    }
    identities.set(galleryId, canonicalSource);
  }
  return identities;
}

function validatePriorAgainstCatalog(priorHealth, identities) {
  for (const entry of priorHealth.entries) {
    if (!identities.has(entry.galleryId)) {
      fail(
        "PRIOR_STATE_MISMATCH",
        `Prior health contains gallery ID ${entry.galleryId}, which is absent from the catalog.`,
      );
    }
  }
}

function validateProposedAgainstCatalog(proposedHealth, identities) {
  if (proposedHealth.entries.length !== identities.size) {
    fail("STALE_SOURCE_IDENTITY", "Proposed health does not cover the exact current catalog identity set.");
  }
  for (const entry of proposedHealth.entries) {
    const expectedSource = identities.get(entry.galleryId);
    if (!expectedSource || canonicalizeUrl(entry.canonicalSource) !== expectedSource) {
      fail("STALE_SOURCE_IDENTITY", `Proposed health has a stale source identity for ${entry.galleryId}.`);
    }
  }
}

function validateHealthTimes(health, maximumTime, { exactCheckedAt = false } = {}) {
  for (const entry of health.entries) {
    const checkedAt = dateMilliseconds(entry.checkedAt, `${entry.galleryId}.checkedAt`, "HEALTH_TIME_INVALID");
    if (checkedAt > maximumTime || (exactCheckedAt && checkedAt !== maximumTime)) {
      fail("HEALTH_TIME_INVALID", `Health timestamp for ${entry.galleryId} is stale or in the future.`);
    }
    if (entry.gracePeriodStartedAt !== null) {
      const grace = dateMilliseconds(
        entry.gracePeriodStartedAt,
        `${entry.galleryId}.gracePeriodStartedAt`,
        "HEALTH_TIME_INVALID",
      );
      if (grace > checkedAt) {
        fail("HEALTH_TIME_INVALID", `Grace period starts after checkedAt for ${entry.galleryId}.`);
      }
    }
    for (const evidence of entry.evidence) {
      const observedAt = dateMilliseconds(
        evidence.observedAt,
        `${entry.galleryId}.evidence.observedAt`,
        "HEALTH_TIME_INVALID",
      );
      if (observedAt > checkedAt) {
        fail("HEALTH_TIME_INVALID", `Evidence is newer than checkedAt for ${entry.galleryId}.`);
      }
    }
  }
}

function normalizeRun(run, now) {
  requireExactKeys(
    run,
    ["repository", "runId", "runAttempt", "sourceRef", "sourceSha", "observedAt"],
    "run identity",
    "RUN_IDENTITY_INVALID",
  );
  const normalized = {
    repository: requireString(run.repository, "run.repository", "RUN_IDENTITY_INVALID"),
    runId: requireString(run.runId, "run.runId", "RUN_IDENTITY_INVALID"),
    runAttempt: run.runAttempt,
    sourceRef: requireString(run.sourceRef, "run.sourceRef", "RUN_IDENTITY_INVALID"),
    sourceSha: requireString(run.sourceSha, "run.sourceSha", "RUN_IDENTITY_INVALID"),
    observedAt: requireString(run.observedAt, "run.observedAt", "RUN_IDENTITY_INVALID"),
  };
  if (!Number.isSafeInteger(normalized.runAttempt) || normalized.runAttempt < 1) {
    fail("RUN_IDENTITY_INVALID", "run.runAttempt must be a positive integer.");
  }
  const observedAt = dateMilliseconds(
    normalized.observedAt,
    "run.observedAt",
    "RUN_IDENTITY_INVALID",
  );
  const nowTime = dateMilliseconds(now, "now", "RUN_IDENTITY_INVALID");
  if (observedAt > nowTime) {
    fail("OBSERVATION_TIME_FUTURE", "Health observation time cannot be in the future.");
  }
  return { run: normalized, observedAt };
}

function inputBinding(pathName, bytes) {
  return { path: pathName, sha256: hashHealthBytes(bytes) };
}

function outputBinding(pathName, bytes) {
  return { path: pathName, sha256: hashHealthBytes(bytes) };
}

export function createHealthPersistenceArtifacts({
  catalog,
  catalogBytes,
  priorHealth,
  priorHealthBytes,
  proposedHealth,
  run,
  summary,
  sources,
  now = new Date().toISOString(),
} = {}) {
  const normalized = normalizeRun(run, now);
  const parsedPrior = parseJsonBytes(
    priorHealthBytes,
    "Prior health state",
    "PRIOR_STATE_MALFORMED",
  );
  if (!isDeepStrictEqual(parsedPrior.data, priorHealth)) {
    fail("PRIOR_STATE_MISMATCH", "Prior health bytes do not match the state used by the scan.");
  }
  const parsedCatalog = parseJsonBytes(catalogBytes, "Catalog", "CATALOG_STATE_MALFORMED");
  if (!isDeepStrictEqual(parsedCatalog.data, catalog)) {
    fail("CATALOG_STATE_MISMATCH", "Catalog bytes do not match the records used by the scan.");
  }

  validateHealthEnvelope(priorHealth, "Prior health state", "PRIOR_STATE_INVALID");
  validateHealthEnvelope(proposedHealth, "Proposed health state", "PROPOSED_STATE_INVALID");
  const identities = catalogIdentity(catalog);
  validatePriorAgainstCatalog(priorHealth, identities);
  validateProposedAgainstCatalog(proposedHealth, identities);
  validateHealthTimes(priorHealth, normalized.observedAt);
  validateHealthTimes(proposedHealth, normalized.observedAt, { exactCheckedAt: true });

  const inputs = {
    priorHealth: inputBinding(PRIOR_HEALTH_PATH, parsedPrior.bytes),
    catalog: inputBinding(CATALOG_PATH, parsedCatalog.bytes),
  };
  const provenance = { ...normalized.run, inputs: clone(inputs) };
  const report = {
    schemaVersion: RECEIPT_VERSION,
    mode: "report-only",
    mutationPerformed: false,
    generatedAt: normalized.run.observedAt,
    provenance,
    summary: clone(summary),
    sources: clone(sources),
    healthSnapshot: clone(proposedHealth),
  };
  const proposedHealthOutput = clone(proposedHealth);
  const reportBytes = prettyJsonBytes(report);
  const proposedHealthOutputBytes = prettyJsonBytes(proposedHealthOutput);
  const receipt = {
    schemaVersion: RECEIPT_VERSION,
    mode: "report-only",
    mutationPerformed: false,
    ...normalized.run,
    inputs,
    outputs: {
      report: outputBinding(HEALTH_ARTIFACT_FILES.report, reportBytes),
      proposedHealth: outputBinding(
        HEALTH_ARTIFACT_FILES.proposedHealth,
        proposedHealthOutputBytes,
      ),
    },
  };
  const receiptBytes = prettyJsonBytes(receipt);
  return {
    report,
    proposedHealth: proposedHealthOutput,
    receipt,
    artifactBytes: {
      [HEALTH_ARTIFACT_FILES.report]: reportBytes,
      [HEALTH_ARTIFACT_FILES.proposedHealth]: proposedHealthOutputBytes,
      [HEALTH_ARTIFACT_FILES.receipt]: receiptBytes,
    },
  };
}

function validateBinding(binding, expectedPath, name) {
  requireExactKeys(binding, ["path", "sha256"], name);
  if (binding.path !== expectedPath || !SHA256_PATTERN.test(binding.sha256)) {
    fail("RECEIPT_INVALID", `${name} is invalid.`);
  }
}

function validateReceipt(receipt, now) {
  requireExactKeys(receipt, [
    "schemaVersion",
    "mode",
    "mutationPerformed",
    "repository",
    "runId",
    "runAttempt",
    "sourceRef",
    "sourceSha",
    "observedAt",
    "inputs",
    "outputs",
  ], "health receipt");
  if (
    receipt.schemaVersion !== RECEIPT_VERSION ||
    receipt.mode !== "report-only" ||
    receipt.mutationPerformed !== false
  ) {
    fail("RECEIPT_INVALID", "Health receipt is not a report-only v1 receipt.");
  }
  const run = normalizeRun({
    repository: receipt.repository,
    runId: receipt.runId,
    runAttempt: receipt.runAttempt,
    sourceRef: receipt.sourceRef,
    sourceSha: receipt.sourceSha,
    observedAt: receipt.observedAt,
  }, now).run;
  requireExactKeys(receipt.inputs, ["priorHealth", "catalog"], "receipt.inputs");
  requireExactKeys(receipt.outputs, ["report", "proposedHealth"], "receipt.outputs");
  validateBinding(receipt.inputs.priorHealth, PRIOR_HEALTH_PATH, "receipt.inputs.priorHealth");
  validateBinding(receipt.inputs.catalog, CATALOG_PATH, "receipt.inputs.catalog");
  validateBinding(receipt.outputs.report, HEALTH_ARTIFACT_FILES.report, "receipt.outputs.report");
  validateBinding(
    receipt.outputs.proposedHealth,
    HEALTH_ARTIFACT_FILES.proposedHealth,
    "receipt.outputs.proposedHealth",
  );
  return run;
}

function assertExpectedRun(actual, expected) {
  if (!expected) fail("STALE_SOURCE_IDENTITY", "Expected trusted run identity is required.");
  requireExactKeys(
    expected,
    ["repository", "runId", "runAttempt", "sourceRef", "sourceSha", "observedAt"],
    "expected run identity",
    "STALE_SOURCE_IDENTITY",
  );
  if (!isDeepStrictEqual(actual, expected)) {
    fail("STALE_SOURCE_IDENTITY", "Health proposal does not match the trusted source run identity.");
  }
}

export function replayHealthPersistenceProposal({
  currentHealthBytes,
  catalogBytes,
  reportBytes,
  proposedHealthBytes,
  receiptBytes,
  expectedRun,
  now = new Date().toISOString(),
} = {}) {
  const receiptSnapshot = parseJsonBytes(receiptBytes, "Health receipt", "RECEIPT_MALFORMED");
  const receipt = receiptSnapshot.data;
  const run = validateReceipt(receipt, now);
  assertExpectedRun(run, expectedRun);

  const current = parseJsonBytes(currentHealthBytes, "Current health state", "PRIOR_STATE_MALFORMED");
  const catalog = parseJsonBytes(catalogBytes, "Catalog", "CATALOG_STATE_MALFORMED");
  const report = parseJsonBytes(reportBytes, "Health report", "REPORT_MALFORMED");
  const proposed = parseJsonBytes(
    proposedHealthBytes,
    "Proposed health state",
    "PROPOSED_STATE_MALFORMED",
  );

  if (hashHealthBytes(catalog.bytes) !== receipt.inputs.catalog.sha256) {
    fail("CATALOG_STATE_MISMATCH", "Current catalog bytes differ from the scan input.");
  }
  if (hashHealthBytes(report.bytes) !== receipt.outputs.report.sha256) {
    fail("REPORT_HASH_MISMATCH", "Health report bytes do not match the receipt.");
  }
  if (hashHealthBytes(proposed.bytes) !== receipt.outputs.proposedHealth.sha256) {
    fail("PROPOSED_STATE_HASH_MISMATCH", "Proposed health bytes do not match the receipt.");
  }

  const expectedProvenance = { ...run, inputs: clone(receipt.inputs) };
  if (
    report.data.schemaVersion !== RECEIPT_VERSION ||
    report.data.mode !== "report-only" ||
    report.data.mutationPerformed !== false ||
    report.data.generatedAt !== run.observedAt ||
    !isDeepStrictEqual(report.data.provenance, expectedProvenance) ||
    !isDeepStrictEqual(report.data.healthSnapshot, proposed.data)
  ) {
    fail("REPORT_BINDING_MISMATCH", "Health report does not bind the receipt and proposed state.");
  }

  validateHealthEnvelope(current.data, "Current health state", "PRIOR_STATE_INVALID");
  validateHealthEnvelope(proposed.data, "Proposed health state", "PROPOSED_STATE_INVALID");
  const identities = catalogIdentity(catalog.data);
  validateProposedAgainstCatalog(proposed.data, identities);
  validateHealthTimes(proposed.data, dateMilliseconds(run.observedAt, "observedAt", "RECEIPT_INVALID"), {
    exactCheckedAt: true,
  });

  const currentHash = hashHealthBytes(current.bytes);
  if (currentHash === receipt.outputs.proposedHealth.sha256) {
    return { status: "already-applied", healthBytes: current.bytes, receipt: clone(receipt) };
  }
  if (currentHash !== receipt.inputs.priorHealth.sha256) {
    fail("PRIOR_STATE_MISMATCH", "Current health bytes differ from the scan input.");
  }
  validatePriorAgainstCatalog(current.data, identities);
  validateHealthTimes(current.data, dateMilliseconds(run.observedAt, "observedAt", "RECEIPT_INVALID"));
  return { status: "ready", healthBytes: proposed.bytes, receipt: clone(receipt) };
}

function isInside(rootDirectory, candidateDirectory) {
  const relative = path.relative(rootDirectory, candidateDirectory);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function writeHealthScanArtifacts({ rootDir, outputDirectory, artifactBytes } = {}) {
  const resolvedRoot = path.resolve(requireString(rootDir, "rootDir", "OUTPUT_INVALID"));
  const resolvedOutput = path.resolve(requireString(
    outputDirectory,
    "outputDirectory",
    "OUTPUT_INVALID",
  ));
  if (isInside(resolvedRoot, resolvedOutput)) {
    fail("WORKSPACE_WRITE_FORBIDDEN", "Health scan artifacts must be emitted outside the repository root.");
  }
  requireExactKeys(
    artifactBytes,
    Object.values(HEALTH_ARTIFACT_FILES),
    "artifactBytes",
    "OUTPUT_INVALID",
  );
  await mkdir(resolvedOutput, { recursive: true });
  await Promise.all(Object.entries(artifactBytes).map(([fileName, bytes]) => (
    writeFile(path.join(resolvedOutput, fileName), asBytes(bytes, fileName))
  )));
  return Object.fromEntries(
    Object.values(HEALTH_ARTIFACT_FILES).map((fileName) => [fileName, path.join(resolvedOutput, fileName)]),
  );
}

export async function persistHealthProposal({
  rootDir,
  artifactDirectory,
  expectedRun,
  now = new Date().toISOString(),
} = {}) {
  const resolvedRoot = path.resolve(requireString(rootDir, "rootDir", "PUBLISH_INPUT_INVALID"));
  const resolvedArtifacts = path.resolve(requireString(
    artifactDirectory,
    "artifactDirectory",
    "PUBLISH_INPUT_INVALID",
  ));
  const healthPath = path.join(resolvedRoot, ...PRIOR_HEALTH_PATH.split("/"));
  const catalogPath = path.join(resolvedRoot, ...CATALOG_PATH.split("/"));
  const [currentHealthBytes, catalogBytes, reportBytes, proposedHealthBytes, receiptBytes] = await Promise.all([
    readFile(healthPath),
    readFile(catalogPath),
    readFile(path.join(resolvedArtifacts, HEALTH_ARTIFACT_FILES.report)),
    readFile(path.join(resolvedArtifacts, HEALTH_ARTIFACT_FILES.proposedHealth)),
    readFile(path.join(resolvedArtifacts, HEALTH_ARTIFACT_FILES.receipt)),
  ]);
  const replay = replayHealthPersistenceProposal({
    currentHealthBytes,
    catalogBytes,
    reportBytes,
    proposedHealthBytes,
    receiptBytes,
    expectedRun,
    now,
  });
  if (replay.status === "already-applied") {
    return { status: replay.status, path: healthPath, sha256: hashHealthBytes(replay.healthBytes) };
  }

  const temporaryPath = `${healthPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, replay.healthBytes);
    await rename(temporaryPath, healthPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { status: "persisted", path: healthPath, sha256: hashHealthBytes(replay.healthBytes) };
}