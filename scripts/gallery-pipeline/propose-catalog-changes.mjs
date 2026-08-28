#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ANALYSIS_SYSTEM_INSTRUCTIONS } from "./analyze-content.mjs";
import { validateDeterministicGate } from "./ai-analysis.mjs";
import { applyCatalogPlan } from "./apply-catalog-plan.mjs";
import {
  buildCatalogChangePlanForTargets,
  compareCatalogOperations,
  composeCatalogChangePlan,
  hashCanonicalValue,
  replayCatalogChangePlan,
  validateCatalogChangePlanPolicy,
} from "./build-catalog-change.mjs";
import { GROUNDING_SYSTEM_INSTRUCTIONS } from "./verify-summary.mjs";
import {
  HEALTH_ARTIFACT_FILES,
  hashHealthBytes,
  replayHealthPersistenceProposal,
} from "./persist-health.mjs";
import { appendAuditPlan, emptyAuditLog } from "./write-audit.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const REPORT_VERSION = "1.0.0";
const MODEL_ANALYSIS_VERSION = "2.0.0";
const CANDIDATE_GATE_VERSION = "2.0.0";
const MAX_OPERATIONS_PER_PLAN = 25;
const MAX_GENERATED_AT_AGE_MS = 15 * 60 * 1000;
const MAX_WORKFLOW_RUN_DURATION_MS = 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const REASON_CODE_PATTERN = "^[A-Z][A-Z0-9_]*$";
const GIT_SHA_PATTERN = "^[a-f0-9]{40}$";
const SHA256_DIGEST_PATTERN = "^sha256:[a-f0-9]{64}$";
const POSITIVE_ID_PATTERN = "^[1-9][0-9]*$";
const TRUSTED_REF_PATTERN = "^refs/heads/[^\\s]+$";
const UPSTREAM_ARTIFACT_SPECS = Object.freeze({
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
const BASE_UPSTREAM_ARTIFACT_NAMES = Object.freeze(["discovery", "health", "freshness"]);
const MODEL_ANALYSIS_FILE_HASH_NAMES = Object.freeze([
  "activeCatalog",
  "analysisSchema",
  "candidateGates",
  "discovery",
  "policy",
  "retiredCatalog",
  "sourceDiscoveryArtifact",
]);
const EVIDENCE_TIMESTAMP_FIELDS = new Set([
  "checkedAt",
  "completedAt",
  "dateAdded",
  "discoveredAt",
  "generatedAt",
  "gracePeriodStartedAt",
  "lastMeaningfulChange",
  "lastVerified",
  "modifiedAt",
  "observedAt",
  "publishedAt",
  "startedAt",
  "timestamp",
]);
const RETIREMENT_PROVENANCE_FIELDS = Object.freeze([
  "decisionRunUrl",
  "decisionPullRequestUrl",
  "decisionRepositoryOwner",
  "decisionRepositoryName",
  "decisionRunId",
  "decisionPullRequestNumber",
]);
const ARTIFACT_PATHS = Object.freeze({
  report: "proposal-report.json",
  receipt: "proposal-receipt.json",
  activeCatalog: "proposed/templates.json",
  health: "proposed/gallery-health.json",
  retired: "proposed/retired-templates.json",
  audit: "proposed/catalog-audit.json",
});
const upstreamArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "repository",
    "workflowId",
    "workflowPath",
    "runId",
    "runAttempt",
    "sourceRef",
    "sourceSha",
    "artifactId",
    "artifactName",
    "digest",
  ],
  properties: {
    name: { enum: Object.keys(UPSTREAM_ARTIFACT_SPECS) },
    repository: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
    workflowId: { type: "string", pattern: POSITIVE_ID_PATTERN },
    workflowPath: { type: "string", minLength: 1 },
    runId: { type: "string", pattern: POSITIVE_ID_PATTERN },
    runAttempt: { type: "integer", minimum: 1 },
    sourceRef: { type: "string", pattern: TRUSTED_REF_PATTERN },
    sourceSha: { type: "string", pattern: GIT_SHA_PATTERN },
    artifactId: { type: "string", pattern: POSITIVE_ID_PATTERN },
    artifactName: { type: "string", minLength: 1 },
    digest: { type: "string", pattern: SHA256_DIGEST_PATTERN },
  },
};
const DEFAULT_INPUT_PATHS = Object.freeze({
  discovery: path.join("gallery-reports", "discovery.json"),
  candidateGates: path.join("gallery-reports", "candidate-gates.json"),
  health: HEALTH_ARTIFACT_FILES.proposedHealth,
  healthReport: HEALTH_ARTIFACT_FILES.report,
  healthReceipt: HEALTH_ARTIFACT_FILES.receipt,
  freshness: "gallery-freshness.json",
  activeCatalog: path.join("static", "templates.json"),
  retired: path.join("static", "retired-templates.json"),
  audit: path.join("static", "catalog-audit.json"),
  exemptions: path.join(".github", "gallery-pipeline", "exemptions.json"),
  policy: path.join(".github", "gallery-pipeline", "policy.json"),
  analysisSchema: path.join(".github", "gallery-pipeline", "analysis.schema.json"),
});

export class CatalogProposalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CatalogProposalError";
    this.code = code;
    this.details = details;
  }
}

const reasonLedgerSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["subjectType", "subjectId", "disposition", "reasonCodes"],
    properties: {
      subjectType: { enum: ["candidate", "catalog"] },
      subjectId: { type: "string", minLength: 1 },
      disposition: { enum: ["planned", "no-change", "rejected"] },
      reasonCodes: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", pattern: REASON_CODE_PATTERN },
      },
      message: { type: "string", minLength: 1 },
    },
  },
};

export const CATALOG_PROPOSAL_REPORT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:gallery-pipeline:schema:catalog-proposal-report:1.0.0",
  title: "Gallery catalog proposal report",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "mode",
    "mutationPerformed",
    "status",
    "runId",
    "generatedAt",
    "inputFingerprint",
    "stage",
    "upstream",
    "summary",
    "reasonLedger",
    "plans",
    "outputs",
  ],
  properties: {
    schemaVersion: { const: REPORT_VERSION },
    mode: { const: "report-only" },
    mutationPerformed: { const: false },
    status: { enum: ["complete", "blocked", "incomplete", "partial", "indeterminate"] },
    runId: { type: "string", minLength: 1 },
    generatedAt: { type: "string", format: "date-time" },
    inputFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    stage: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCodes"],
      properties: {
        status: { enum: ["completed", "blocked"] },
        reasonCodes: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: REASON_CODE_PATTERN },
        },
      },
    },
    upstream: {
      type: "object",
      additionalProperties: false,
      required: ["discovery", "candidateGates", "modelAnalysis", "health", "freshness"],
      properties: Object.fromEntries(
        ["discovery", "candidateGates", "modelAnalysis", "health", "freshness"]
          .map((name) => [name, { enum: ["complete", "incomplete", "missing", "partial", "indeterminate", "not-required"] }]),
      ),
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: [
        "candidates",
        "eligibleCandidates",
        "plannedCandidates",
        "rejectedCandidates",
        "noChangeCandidates",
        "rejectedCatalogTargets",
        "plans",
        "operations",
      ],
      properties: Object.fromEntries([
        "candidates",
        "eligibleCandidates",
        "plannedCandidates",
        "rejectedCandidates",
        "noChangeCandidates",
        "rejectedCatalogTargets",
        "plans",
        "operations",
      ].map((name) => [name, { type: "integer", minimum: 0 }])),
    },
    reasonLedger: reasonLedgerSchema,
    plans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["batchNumber", "path", "runId", "inputFingerprint", "operationCount", "operationIds"],
        properties: {
          batchNumber: { type: "integer", minimum: 1 },
          path: { type: "string", pattern: "^plans/catalog-change-plan-[0-9]{3}\\.json$" },
          runId: { type: "string", minLength: 1 },
          inputFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          operationCount: { type: "integer", minimum: 1, maximum: MAX_OPERATIONS_PER_PLAN },
          operationIds: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    outputs: {
      type: "object",
      additionalProperties: false,
      required: ["report", "receipt", "activeCatalog", "health", "retired", "audit"],
      properties: Object.fromEntries(
        Object.entries(ARTIFACT_PATHS).map(([name, value]) => [name, { const: value }]),
      ),
    },
  },
});

export const CATALOG_PROPOSAL_RECEIPT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:gallery-pipeline:schema:catalog-proposal-receipt:1.0.0",
  title: "Gallery catalog proposal receipt",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "mode",
    "mutationPerformed",
    "runId",
    "generatedAt",
    "workflowStartedAt",
    "trustedRepository",
    "trustedRef",
    "trustedSha",
    "upstreamArtifacts",
    "healthArtifact",
    "inputFingerprint",
    "reportFingerprint",
    "inputs",
    "outputs",
  ],
  properties: {
    schemaVersion: { const: REPORT_VERSION },
    mode: { const: "report-only" },
    mutationPerformed: { const: false },
    runId: { type: "string", minLength: 1 },
    generatedAt: { type: "string", format: "date-time" },
    workflowStartedAt: { type: "string", format: "date-time" },
    trustedRepository: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
    trustedRef: { type: "string", pattern: TRUSTED_REF_PATTERN },
    trustedSha: { type: "string", pattern: GIT_SHA_PATTERN },
    upstreamArtifacts: {
      type: "array",
      minItems: BASE_UPSTREAM_ARTIFACT_NAMES.length,
      maxItems: Object.keys(UPSTREAM_ARTIFACT_SPECS).length,
      items: upstreamArtifactSchema,
    },
    healthArtifact: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["report", "proposedHealth", "receipt"],
          properties: Object.fromEntries(Object.entries(HEALTH_ARTIFACT_FILES).map(([name, fileName]) => [
            name,
            {
              type: "object",
              additionalProperties: false,
              required: ["path", "sha256"],
              properties: {
                path: { const: fileName },
                sha256: { type: "string", pattern: SHA256_DIGEST_PATTERN },
              },
            },
          ])),
        },
      ],
    },
    inputFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    reportFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    inputs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "provided", "fingerprint"],
        properties: {
          name: { type: "string", minLength: 1 },
          provided: { type: "boolean" },
          fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
    },
    outputs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "fingerprint"],
        properties: {
          path: { type: "string", minLength: 1 },
          fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
    },
  },
});

const schemaAjv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(schemaAjv);
const validateDateTime = schemaAjv.compile({ type: "string", format: "date-time" });
const validateReportSchema = schemaAjv.compile(CATALOG_PROPOSAL_REPORT_SCHEMA);
const validateReceiptSchema = schemaAjv.compile(CATALOG_PROPOSAL_RECEIPT_SCHEMA);

function fail(code, message, details = {}) {
  throw new CatalogProposalError(code, message, details);
}

function clone(value) {
  return structuredClone(value);
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INPUT_INVALID", `${name} must be an object.`);
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) fail("INPUT_INVALID", `${name} must be an array.`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INPUT_INVALID", `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("INPUT_INVALID", `${name} must be a non-negative integer.`);
  }
  return value;
}

function normalizeTimestamp(value, name) {
  const timestamp = new Date(requireString(value, name));
  if (Number.isNaN(timestamp.valueOf())) fail("INPUT_INVALID", `${name} must be a valid date-time.`);
  return timestamp.toISOString();
}

function timestampMilliseconds(value, name, code, requireDateTime = false) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${name} must be a non-empty date-time string.`);
  }
  if (requireDateTime && !validateDateTime(value)) {
    fail(code, `${name} must be an RFC 3339 date-time.`);
  }
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) fail(code, `${name} must be a valid date-time.`);
  return milliseconds;
}

function schemaMessage(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function uniqueReasonCodes(values) {
  return [...new Set(values.filter((value) => (
    typeof value === "string" && new RegExp(REASON_CODE_PATTERN).test(value)
  )))].sort((left, right) => left.localeCompare(right));
}

function reasonCodesOrFallback(values, fallback) {
  const codes = uniqueReasonCodes(values);
  return codes.length > 0 ? codes : [fallback];
}

function candidateId(candidate, fallback = null) {
  return typeof candidate?.identityKey === "string" && candidate.identityKey.trim()
    ? candidate.identityKey.trim()
    : fallback;
}

function galleryId(candidate) {
  return typeof candidate?.metadata?.galleryId === "string" && candidate.metadata.galleryId.trim()
    ? candidate.metadata.galleryId.trim()
    : null;
}

function retiredRecordEntries(retired) {
  return requireArray(requireObject(retired, "retired").entries, "retired.entries");
}

function evidenceTimestamps(input) {
  const timestamps = [];
  const visit = (value, location) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [name, child] of Object.entries(value)) {
      const childLocation = `${location}.${name}`;
      if (
        (EVIDENCE_TIMESTAMP_FIELDS.has(name) || name.endsWith("At")) &&
        child !== null &&
        child !== undefined
      ) {
        timestamps.push({
          location: childLocation,
          milliseconds: timestampMilliseconds(child, childLocation, "EVIDENCE_TIMESTAMP_INVALID"),
        });
      }
      if (typeof child === "object" && child !== null) visit(child, childLocation);
    }
  };
  for (const name of ["discovery", "candidateGates", "modelAnalysis", "health", "freshness"]) {
    visit(input[name], name);
  }
  return timestamps;
}

function validateRunTimestamps(input, now) {
  if (input.generatedAt === null || input.generatedAt === undefined || input.generatedAt === "") {
    fail("GENERATED_AT_REQUIRED", "generatedAt must be the explicit proposal execution timestamp.");
  }
  const generatedAtMs = timestampMilliseconds(
    input.generatedAt,
    "generatedAt",
    "GENERATED_AT_INVALID",
    true,
  );
  const workflowStartedAtMs = timestampMilliseconds(
    input.workflowStartedAt,
    "workflowStartedAt",
    "WORKFLOW_STARTED_AT_INVALID",
    true,
  );
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) fail("INPUT_INVALID", "The execution clock must be a valid date-time.");

  const latestEvidence = evidenceTimestamps(input)
    .sort((left, right) => right.milliseconds - left.milliseconds)[0];
  if (latestEvidence && generatedAtMs < latestEvidence.milliseconds) {
    fail(
      "GENERATED_AT_BEFORE_EVIDENCE",
      `generatedAt must not precede ${latestEvidence.location}.`,
      { latestEvidence: latestEvidence.location },
    );
  }
  if (
    generatedAtMs < workflowStartedAtMs ||
    generatedAtMs - workflowStartedAtMs > MAX_WORKFLOW_RUN_DURATION_MS
  ) {
    fail("GENERATED_AT_OUTSIDE_RUN", "generatedAt is outside the allowed workflow run window.");
  }
  if (generatedAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    fail("GENERATED_AT_IN_FUTURE", "generatedAt is later than the execution clock allows.");
  }
  if (nowMs - generatedAtMs > MAX_GENERATED_AT_AGE_MS) {
    fail("GENERATED_AT_STALE", "generatedAt is stale for the current proposal execution.");
  }
  return {
    generatedAt: new Date(generatedAtMs).toISOString(),
    workflowStartedAt: new Date(workflowStartedAtMs).toISOString(),
  };
}

function invalidUpstreamArtifacts(message, details = {}) {
  fail("UPSTREAM_ARTIFACTS_INVALID", message, details);
}

function validateUpstreamArtifacts(input, modelRequired) {
  const repository = typeof input.trustedRepository === "string" ? input.trustedRepository.trim() : "";
  const trustedRef = typeof input.trustedRef === "string" ? input.trustedRef.trim() : "";
  const trustedSha = typeof input.trustedSha === "string" ? input.trustedSha.trim() : "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    invalidUpstreamArtifacts("trustedRepository must be an owner/name repository identity.");
  }
  if (!new RegExp(TRUSTED_REF_PATTERN).test(trustedRef)) {
    invalidUpstreamArtifacts("trustedRef must identify the checked-out branch.");
  }
  if (!new RegExp(GIT_SHA_PATTERN).test(trustedSha)) {
    invalidUpstreamArtifacts("trustedSha must be the full checked-out commit SHA.");
  }
  if (!Array.isArray(input.upstreamArtifacts)) {
    invalidUpstreamArtifacts("upstreamArtifacts must be an array.");
  }
  const expectedNames = modelRequired
    ? [...BASE_UPSTREAM_ARTIFACT_NAMES, "modelAnalysis"]
    : [...BASE_UPSTREAM_ARTIFACT_NAMES];
  if (input.upstreamArtifacts.length !== expectedNames.length) {
    invalidUpstreamArtifacts("Exactly one artifact from each expected producer is required.");
  }

  const seenNames = new Set();
  const seenRunIds = new Set();
  const seenArtifactIds = new Set();
  for (const artifact of input.upstreamArtifacts) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      invalidUpstreamArtifacts("Every upstream artifact entry must be an object.");
    }
    const spec = UPSTREAM_ARTIFACT_SPECS[artifact.name];
    if (!spec || seenNames.has(artifact.name)) {
      invalidUpstreamArtifacts("Upstream producer names must be expected and unique.");
    }
    seenNames.add(artifact.name);
    for (const [field, pattern] of [
      ["workflowId", POSITIVE_ID_PATTERN],
      ["runId", POSITIVE_ID_PATTERN],
      ["artifactId", POSITIVE_ID_PATTERN],
      ["sourceSha", GIT_SHA_PATTERN],
      ["digest", SHA256_DIGEST_PATTERN],
    ]) {
      if (typeof artifact[field] !== "string" || !new RegExp(pattern).test(artifact[field])) {
        invalidUpstreamArtifacts(`${artifact.name}.${field} is invalid.`);
      }
    }
    if (!Number.isSafeInteger(artifact.runAttempt) || artifact.runAttempt < 1) {
      invalidUpstreamArtifacts(`${artifact.name}.runAttempt must be a positive integer.`);
    }
    const expectedArtifactName = `${spec.artifactPrefix}${artifact.runId}-${artifact.runAttempt}`;
    if (
      artifact.repository !== repository ||
      artifact.workflowPath !== spec.workflowPath ||
      artifact.sourceRef !== trustedRef ||
      artifact.sourceSha !== trustedSha ||
      artifact.artifactName !== expectedArtifactName
    ) {
      invalidUpstreamArtifacts(`${artifact.name} is not bound to the trusted producer context.`);
    }
    if (seenRunIds.has(artifact.runId) || seenArtifactIds.has(artifact.artifactId)) {
      invalidUpstreamArtifacts("Upstream run IDs and artifact IDs must be unique.");
    }
    seenRunIds.add(artifact.runId);
    seenArtifactIds.add(artifact.artifactId);
  }
  if (expectedNames.some((name) => !seenNames.has(name))) {
    invalidUpstreamArtifacts("Exactly one artifact from each expected producer is required.");
  }
}

function verifyHealthArtifact({ activeCatalog, health, report, receipt, upstreamArtifacts, now }) {
  const producer = Array.isArray(upstreamArtifacts?.data)
    ? upstreamArtifacts.data.find((artifact) => artifact?.name === "health")
    : null;
  if (!producer) {
    fail("HEALTH_ARTIFACT_INVALID", "The verified health producer artifact is missing.");
  }
  try {
    replayHealthPersistenceProposal({
      currentHealthBytes: health.bytes,
      catalogBytes: activeCatalog.bytes,
      reportBytes: report.bytes,
      proposedHealthBytes: health.bytes,
      receiptBytes: receipt.bytes,
      expectedRun: {
        repository: producer.repository,
        runId: producer.runId,
        runAttempt: producer.runAttempt,
        sourceRef: producer.sourceRef,
        sourceSha: producer.sourceSha,
        observedAt: receipt.data?.observedAt,
      },
      now,
    });
  } catch (error) {
    fail(
      "HEALTH_ARTIFACT_INVALID",
      `Health artifact verification failed: ${error instanceof Error ? error.message : String(error)}`,
      { causeCode: typeof error?.code === "string" ? error.code : null },
    );
  }
  return Object.fromEntries(Object.entries({
    report,
    proposedHealth: health,
    receipt,
  }).map(([name, snapshot]) => [name, {
    path: HEALTH_ARTIFACT_FILES[name],
    sha256: hashHealthBytes(snapshot.bytes),
  }]));
}

function inputFingerprintFor(input) {
  return hashCanonicalValue({
    discovery: input.discovery,
    candidateGates: input.candidateGates,
    modelAnalysis: input.modelAnalysis ?? null,
    modelAnalysisReceipt: input.modelAnalysisReceipt ?? null,
    modelAnalysisVerification: input.modelAnalysisVerification ?? null,
    health: input.health,
    freshness: input.freshness,
    activeCatalog: input.activeCatalog,
    retired: input.retired,
    audit: input.audit ?? emptyAuditLog(),
    exemptions: input.exemptions,
    policy: input.policy,
    analysisSchema: input.analysisSchema ?? null,
    retirementProvenance: input.retirementProvenance ?? null,
    trustedRepository: input.trustedRepository ?? null,
    trustedRef: input.trustedRef ?? null,
    trustedSha: input.trustedSha ?? null,
    upstreamArtifacts: input.upstreamArtifacts ?? null,
    healthArtifact: input.healthArtifact ?? null,
  });
}

function policyBlockReasons(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return ["POLICY_INVALID"];
  const reasons = [];
  if (policy.automation?.emergencyDisable !== false) reasons.push("POLICY_EMERGENCY_DISABLED");
  if (policy.automation?.mutationMode !== "dry-run") reasons.push("MUTATION_MODE_INVALID");
  const aiFlags = policy.automation?.ai;
  if (!aiFlags || Object.values(aiFlags).length === 0 || Object.values(aiFlags).some((value) => value !== true)) {
    reasons.push("AI_AUTOMATION_DISABLED");
  }
  const mutationFlags = policy.automation?.mutation;
  const requiredMutationFlags = [
    "catalogPublication",
    "metadataUpdate",
    "quarantine",
    "retirement",
    "restoration",
  ];
  if (!mutationFlags || requiredMutationFlags.some((name) => mutationFlags[name] !== true)) {
    reasons.push("MUTATION_AUTOMATION_DISABLED");
  }
  const maximum = policy.batching?.maxEntriesPerPullRequest;
  if (!Number.isSafeInteger(maximum) || maximum < 1) reasons.push("BATCH_POLICY_INVALID");
  return uniqueReasonCodes(reasons);
}

function candidateCoverageStatus(candidateGates) {
  if (candidateGates.schemaVersion !== CANDIDATE_GATE_VERSION) {
    fail("INPUT_INVALID", `candidateGates.schemaVersion must be ${CANDIDATE_GATE_VERSION}.`);
  }
  if (!["complete", "partial"].includes(candidateGates.coverageStatus)) {
    fail("INPUT_INVALID", "candidateGates.coverageStatus must be complete or partial.");
  }
  if (!["complete", "incomplete"].includes(candidateGates.status)) {
    fail("INPUT_INVALID", "candidateGates.status must be complete or incomplete.");
  }
  const summary = requireObject(candidateGates.summary, "candidateGates.summary");
  const candidates = requireNonNegativeInteger(summary.candidates, "candidateGates.summary.candidates");
  const selectedCandidates = requireNonNegativeInteger(
    summary.selectedCandidates,
    "candidateGates.summary.selectedCandidates",
  );
  const executedCandidateChecks = requireNonNegativeInteger(
    summary.executedCandidateChecks,
    "candidateGates.summary.executedCandidateChecks",
  );
  const availabilityChecks = requireNonNegativeInteger(
    summary.availabilityChecks,
    "candidateGates.summary.availabilityChecks",
  );
  const executedAvailabilityChecks = requireNonNegativeInteger(
    summary.executedAvailabilityChecks,
    "candidateGates.summary.executedAvailabilityChecks",
  );
  const indeterminateAvailabilityChecks = requireNonNegativeInteger(
    summary.indeterminateAvailabilityChecks,
    "candidateGates.summary.indeterminateAvailabilityChecks",
  );
  const deadlineExceededAvailabilityChecks = requireNonNegativeInteger(
    summary.deadlineExceededAvailabilityChecks,
    "candidateGates.summary.deadlineExceededAvailabilityChecks",
  );
  const eligible = requireNonNegativeInteger(summary.eligible, "candidateGates.summary.eligible");
  const rejected = requireNonNegativeInteger(summary.rejected, "candidateGates.summary.rejected");
  if (
    selectedCandidates > candidates ||
    executedCandidateChecks > selectedCandidates ||
    executedAvailabilityChecks > availabilityChecks ||
    indeterminateAvailabilityChecks > availabilityChecks ||
    deadlineExceededAvailabilityChecks > availabilityChecks ||
    eligible !== candidateGates.eligible.length ||
    rejected !== candidateGates.rejected.length ||
    eligible + rejected !== candidates
  ) {
    fail("INPUT_INVALID", "candidateGates summary counters are inconsistent.");
  }
  if (candidateGates.status === "complete" && (
    executedCandidateChecks !== selectedCandidates ||
    executedAvailabilityChecks !== availabilityChecks ||
    deadlineExceededAvailabilityChecks !== 0
  )) {
    fail("INPUT_INVALID", "complete candidateGates must have complete execution coverage.");
  }
  if (candidateGates.status === "incomplete" && (
    executedCandidateChecks === selectedCandidates &&
    executedAvailabilityChecks === availabilityChecks &&
    deadlineExceededAvailabilityChecks === 0
  )) {
    fail("INPUT_INVALID", "incomplete candidateGates must identify unfinished execution.");
  }
  const expected = (
    selectedCandidates === candidates && indeterminateAvailabilityChecks === 0
  ) ? "complete" : "partial";
  if (candidateGates.coverageStatus !== expected) {
    fail("INPUT_INVALID", "candidateGates.coverageStatus is inconsistent with its summary.");
  }
  return candidateGates.coverageStatus;
}

function aiPolicyEnabled(policy) {
  const flags = policy?.automation?.ai;
  return Boolean(
    flags &&
    Object.values(flags).length > 0 &&
    Object.values(flags).every((value) => value === true)
  );
}

function reportStatus(value) {
  return ["complete", "incomplete", "partial", "indeterminate"].includes(value)
    ? value
    : "missing";
}

function healthStatus(health) {
  if (!health) return "missing";
  if (["incomplete", "partial", "indeterminate"].includes(health.status)) return health.status;
  return (health.entries ?? []).some((entry) => (
    entry?.status === "indeterminate" || entry?.sourceState?.availability === "indeterminate"
  )) ? "indeterminate" : "complete";
}

function freshnessStatus(freshness) {
  if (!freshness) return "missing";
  if (["incomplete", "partial", "indeterminate"].includes(freshness.status)) return freshness.status;
  return (freshness.entries ?? []).some((entry) => (
    entry?.health?.status === "indeterminate" ||
    entry?.health?.sourceState?.availability === "indeterminate"
  )) ? "indeterminate" : "complete";
}

function modelAnalysisStatus(modelAnalysis, required) {
  if (!required && !modelAnalysis) return "not-required";
  if (!modelAnalysis) return "missing";
  return reportStatus(modelAnalysis.status ?? "complete");
}

function upstreamState(input, modelRequired) {
  return {
    discovery: reportStatus(input.discovery?.status),
    candidateGates: reportStatus(input.candidateGates?.status),
    modelAnalysis: modelAnalysisStatus(input.modelAnalysis, modelRequired),
    health: healthStatus(input.health),
    freshness: freshnessStatus(input.freshness),
  };
}

function upstreamBlock(upstream) {
  const required = [upstream.discovery, upstream.candidateGates, upstream.modelAnalysis];
  if (required.includes("incomplete")) {
    return { status: "incomplete", reasons: ["UPSTREAM_EXECUTION_INCOMPLETE"] };
  }
  if (required.includes("indeterminate")) {
    return { status: "indeterminate", reasons: ["UPSTREAM_INDETERMINATE"] };
  }
  if (required.includes("partial")) {
    return { status: "partial", reasons: ["UPSTREAM_PARTIAL"] };
  }
  if (required.includes("missing") || [upstream.health, upstream.freshness].includes("missing")) {
    const reasons = upstream.modelAnalysis === "missing"
      ? ["MODEL_ANALYSIS_MISSING"]
      : ["UPSTREAM_REPORT_MISSING"];
    return { status: "blocked", reasons };
  }
  return null;
}

function analysisValues(modelAnalysis) {
  if (!modelAnalysis) return [];
  const values = modelAnalysis.analyses ?? modelAnalysis.results;
  return requireArray(values, "modelAnalysis.analyses").map((value) => value?.analysis ?? value);
}

function analysisIndex(modelAnalysis) {
  const index = new Map();
  const duplicates = new Set();
  for (const analysis of analysisValues(modelAnalysis)) {
    const id = typeof analysis?.candidateId === "string" ? analysis.candidateId : null;
    if (!id) continue;
    if (index.has(id)) duplicates.add(id);
    else index.set(id, analysis);
  }
  return { index, duplicates };
}

function prefixedCanonicalHash(value) {
  return `sha256:${hashCanonicalValue(value)}`;
}

function expectedRejectedLedger(candidateGates) {
  const entries = clone(candidateGates.rejected);
  return {
    count: entries.length,
    entries,
    hash: prefixedCanonicalHash(entries),
  };
}

function prettyJsonHash(value) {
  return `sha256:${createHash("sha256")
    .update(`${JSON.stringify(value, null, 2)}\n`)
    .digest("hex")}`;
}

function bytesHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function expectedModelAnalysisConfigurationHashes(input) {
  return {
    promptHash: prefixedCanonicalHash({
      analysis: ANALYSIS_SYSTEM_INSTRUCTIONS,
      grounding: GROUNDING_SYSTEM_INSTRUCTIONS,
    }),
    schemaHash: prefixedCanonicalHash(input.analysisSchema),
    policyHash: prefixedCanonicalHash(input.policy),
    catalogHash: prefixedCanonicalHash({
      active: input.activeCatalog,
      retired: input.retired,
    }),
  };
}

export function createModelAnalysisVerification({
  modelAnalysis,
  discovery,
  candidateGates,
  activeCatalog,
  retiredCatalog,
  policy,
  analysisSchema,
  sourceDiscoveryArtifact,
}) {
  return {
    reportFileHash: bytesHash(modelAnalysis),
    fileHashes: {
      discovery: bytesHash(discovery),
      candidateGates: bytesHash(candidateGates),
      activeCatalog: bytesHash(activeCatalog),
      retiredCatalog: bytesHash(retiredCatalog),
      policy: bytesHash(policy),
      analysisSchema: bytesHash(analysisSchema),
      sourceDiscoveryArtifact: bytesHash(sourceDiscoveryArtifact),
    },
  };
}

function validateModelAnalysisReceipt(modelAnalysis, receipt, input) {
  if (!receipt) return ["MODEL_ANALYSIS_RECEIPT_MISSING"];
  try {
    const analyses = analysisValues(modelAnalysis);
    const analysisIds = analyses.map((analysis) => requireString(
      analysis?.candidateId,
      "model analysis candidateId",
    ));
    const eligibleIds = input.candidateGates.eligible
      .map((entry) => requireString(entry?.candidate?.identityKey, "eligible candidate ID"))
      .sort((left, right) => left.localeCompare(right));
    const expectedEligibleSet = {
      count: eligibleIds.length,
      candidateIds: eligibleIds,
      hash: prefixedCanonicalHash(eligibleIds),
    };
    const rejectedLedger = expectedRejectedLedger(input.candidateGates);
    const expectedReceiptKeys = [
      "analysisCount",
      "configuration",
      "eligibleSet",
      "fileHashes",
      "provenance",
      "rejectedLedger",
      "reportFile",
      "reportFileHash",
      "reportFingerprint",
      "schemaVersion",
    ].sort();
    const actualReceiptKeys = Object.keys(requireObject(receipt, "model analysis receipt")).sort();
    const artifacts = new Map(input.upstreamArtifacts.map((artifact) => [artifact.name, artifact]));
    const discoveryArtifact = artifacts.get("discovery");
    const modelArtifact = artifacts.get("modelAnalysis");
    const provenance = requireObject(modelAnalysis.provenance, "model analysis provenance");
    const producerFields = [
      ["repository", "repository"],
      ["workflowId", "workflowId"],
      ["workflowPath", "workflowPath"],
      ["runId", "runId"],
      ["runAttempt", "runAttempt"],
      ["sourceRef", "sourceRef"],
      ["sourceSha", "sourceSha"],
    ];
    const configuration = requireObject(modelAnalysis.configuration, "model analysis configuration");
    const requiredConfigurationKeys = [
      "apiMode",
      "apiVersion",
      "catalogHash",
      "deploymentId",
      "endpointOriginHash",
      "policyHash",
      "promptHash",
      "schemaHash",
    ].sort();
    const fileHashes = requireObject(modelAnalysis.fileHashes, "model analysis fileHashes");
    const verification = requireObject(
      input.modelAnalysisVerification,
      "model analysis verification",
    );
    const expectedFileHashes = requireObject(
      verification.fileHashes,
      "model analysis verification fileHashes",
    );
    const expectedConfigurationHashes = expectedModelAnalysisConfigurationHashes(input);
    const validHashes = Object.values(expectedFileHashes).every((hash) => (
      typeof hash === "string" && new RegExp(SHA256_DIGEST_PATTERN).test(hash)
    ));
    if (
      modelAnalysis.schemaVersion !== MODEL_ANALYSIS_VERSION ||
      modelAnalysis.mode !== "live-candidate-analysis" ||
      modelAnalysis.mutationPerformed !== false ||
      modelAnalysis.status !== "complete" ||
      !isDeepStrictEqual(analysisIds, eligibleIds) ||
      new Set(analysisIds).size !== analysisIds.length ||
      !isDeepStrictEqual(modelAnalysis.eligibleSet, expectedEligibleSet) ||
      !isDeepStrictEqual(modelAnalysis.rejectedLedger, rejectedLedger) ||
      !isDeepStrictEqual(actualReceiptKeys, expectedReceiptKeys) ||
      receipt.schemaVersion !== MODEL_ANALYSIS_VERSION ||
      receipt.reportFile !== "model-analysis.json" ||
      typeof verification.reportFileHash !== "string" ||
      !new RegExp(SHA256_DIGEST_PATTERN).test(verification.reportFileHash) ||
      receipt.reportFileHash !== verification.reportFileHash ||
      receipt.reportFingerprint !== prefixedCanonicalHash(modelAnalysis) ||
      receipt.analysisCount !== analyses.length ||
      !isDeepStrictEqual(receipt.eligibleSet, expectedEligibleSet) ||
      !isDeepStrictEqual(receipt.rejectedLedger, rejectedLedger) ||
      !modelArtifact ||
      !isDeepStrictEqual(provenance.sourceDiscoveryArtifact, discoveryArtifact) ||
      producerFields.some(([reportField, artifactField]) => (
        provenance[reportField] !== modelArtifact[artifactField]
      )) ||
      !isDeepStrictEqual(receipt.provenance, provenance) ||
      !isDeepStrictEqual(Object.keys(configuration).sort(), requiredConfigurationKeys) ||
      !["responses", "chat"].includes(configuration.apiMode) ||
      typeof configuration.apiVersion !== "string" ||
      configuration.apiVersion.trim() === "" ||
      typeof configuration.deploymentId !== "string" ||
      configuration.deploymentId.trim() === "" ||
      [
        configuration.endpointOriginHash,
        configuration.promptHash,
        configuration.schemaHash,
        configuration.policyHash,
        configuration.catalogHash,
      ].some((hash) => typeof hash !== "string" || !new RegExp(SHA256_DIGEST_PATTERN).test(hash)) ||
      Object.entries(expectedConfigurationHashes).some(([name, hash]) => (
        configuration[name] !== hash
      )) ||
      !isDeepStrictEqual(receipt.configuration, configuration) ||
      !isDeepStrictEqual(Object.keys(fileHashes).sort(), MODEL_ANALYSIS_FILE_HASH_NAMES) ||
      !isDeepStrictEqual(Object.keys(expectedFileHashes).sort(), MODEL_ANALYSIS_FILE_HASH_NAMES) ||
      !validHashes ||
      !isDeepStrictEqual(fileHashes, expectedFileHashes) ||
      !isDeepStrictEqual(receipt.fileHashes, fileHashes)
    ) {
      return ["MODEL_ANALYSIS_RECEIPT_INVALID"];
    }
  } catch {
    return ["MODEL_ANALYSIS_RECEIPT_INVALID"];
  }
  return [];
}

function initialLedger(discovery, candidateGates) {
  const ledger = new Map();
  const discoveryCandidates = requireArray(discovery.candidates, "discovery.candidates");
  for (const [index, candidate] of discoveryCandidates.entries()) {
    const id = candidateId(candidate, `candidate-${index + 1}`);
    ledger.set(`candidate:${id}`, {
      subjectType: "candidate",
      subjectId: id,
      disposition: "rejected",
      reasonCodes: ["CANDIDATE_GATE_RESULT_MISSING"],
    });
  }
  for (const [index, rejection] of requireArray(candidateGates.rejected, "candidateGates.rejected").entries()) {
    const id = typeof rejection?.candidateId === "string" && rejection.candidateId.trim()
      ? rejection.candidateId.trim()
      : `rejected-candidate-${index + 1}`;
    ledger.set(`candidate:${id}`, {
      subjectType: "candidate",
      subjectId: id,
      disposition: "rejected",
      reasonCodes: reasonCodesOrFallback(rejection?.reasonCodes ?? [], "CANDIDATE_GATE_REJECTED"),
    });
  }
  return ledger;
}

function setLedger(ledger, subjectType, subjectId, disposition, reasonCodes, message) {
  const entry = {
    subjectType,
    subjectId,
    disposition,
    reasonCodes: reasonCodesOrFallback(reasonCodes, "PROPOSAL_REJECTED"),
  };
  if (typeof message === "string" && message.trim()) entry.message = message.trim();
  ledger.set(`${subjectType}:${subjectId}`, entry);
}

function sortedLedger(ledger) {
  return [...ledger.values()].sort((left, right) => (
    left.subjectType.localeCompare(right.subjectType) || left.subjectId.localeCompare(right.subjectId)
  ));
}

function candidateBindings(discovery) {
  const bindings = new Map();
  for (const candidate of requireArray(discovery.candidates, "discovery.candidates")) {
    const id = candidateId(candidate);
    if (!id) continue;
    const values = bindings.get(id) ?? [];
    values.push(candidate);
    bindings.set(id, values);
  }
  return bindings;
}

function validPublicationTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && !Number.isNaN(new Date(value).valueOf());
}

function normalizedCandidateEvidenceTimestamp(value) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function candidateGateEvidenceReasons(entry, candidate, candidateGates, gateCatalog) {
  const reasons = [];
  try {
    validateDeterministicGate({
      candidate,
      catalog: gateCatalog,
      deterministicGate: entry?.deterministicGate,
    });
  } catch {
    reasons.push("CANDIDATE_DETERMINISTIC_GATE_INVALID");
  }

  const availability = entry?.availability;
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    reasons.push("CANDIDATE_AVAILABILITY_MISSING");
    return reasons;
  }
  if (Object.keys(availability).some((name) => /score|components/i.test(name))) {
    reasons.push("CANDIDATE_AVAILABILITY_SCORE_UNSUPPORTED");
  }
  if (availability.classification === "indeterminate") {
    reasons.push("CANDIDATE_AVAILABILITY_INDETERMINATE");
  } else if (
    availability.classification !== "healthy" ||
    !Number.isInteger(availability.statusCode) ||
    availability.statusCode < 200 ||
    availability.statusCode >= 300 ||
    availability.statusCode === 206 ||
    availability.reasonCode !== null
  ) {
    reasons.push("CANDIDATE_AVAILABILITY_UNHEALTHY");
  }
  const checkedAt = normalizedCandidateEvidenceTimestamp(availability.checkedAt);
  const startedAt = normalizedCandidateEvidenceTimestamp(candidateGates?.startedAt);
  const completedAt = normalizedCandidateEvidenceTimestamp(candidateGates?.completedAt);
  if (!checkedAt || !startedAt || !completedAt || checkedAt !== startedAt || checkedAt !== completedAt) {
    reasons.push("CANDIDATE_AVAILABILITY_TIMESTAMP_MISMATCH");
  }
  return reasons;
}

function candidatePrecheckReasons({
  candidate,
  gateEntry,
  candidateGates,
  gateCatalog,
  boundCandidates,
  analyses,
  duplicateAnalyses,
  existingTarget,
  healthById,
  freshnessById,
  existingChangesAllowed,
  existingChangeBlockReasons,
}) {
  const reasons = [];
  const id = candidateId(candidate);
  const targetId = galleryId(candidate);
  if (!id || boundCandidates.length !== 1 || !isDeepStrictEqual(candidate, boundCandidates[0])) {
    reasons.push("DISCOVERY_BINDING_INVALID");
  }
  if (!targetId) reasons.push("GALLERY_ID_MISSING");
  if (!validPublicationTimestamp(candidate?.publishedAt)) reasons.push("PUBLISHED_AT_MISSING");
  if (duplicateAnalyses.has(id)) reasons.push("MODEL_ANALYSIS_DUPLICATE");
  else if (!analyses.has(id)) reasons.push("MODEL_ANALYSIS_MISSING");
  reasons.push(...candidateGateEvidenceReasons(gateEntry, candidate, candidateGates, gateCatalog));
  if (targetId && existingTarget) {
    if (!existingChangesAllowed) {
      reasons.push(...existingChangeBlockReasons);
      return uniqueReasonCodes(reasons);
    }
    const health = healthById.get(targetId);
    const freshness = freshnessById.get(targetId);
    if (!health) reasons.push("HEALTH_DECISION_MISSING");
    else if (health.canonicalSource !== existingTarget.canonicalSource) {
      reasons.push("HEALTH_DECISION_TARGET_MISMATCH");
    }
    if (!freshness) reasons.push("FRESHNESS_DECISION_MISSING");
    else if (freshness.canonicalSource !== existingTarget.canonicalSource) {
      reasons.push("FRESHNESS_DECISION_TARGET_MISMATCH");
    }
  }
  return uniqueReasonCodes(reasons);
}

function mapById(values, key) {
  const index = new Map();
  for (const value of values ?? []) {
    const id = value?.[key];
    if (typeof id === "string" && id.trim() && !index.has(id)) index.set(id, value);
  }
  return index;
}

function lifecycleIntent(health, freshness) {
  const intents = new Set();
  if (health?.status === "retired" || freshness?.recommendation === "retire" || freshness?.health?.status === "retired") {
    intents.add("retire");
  }
  if (
    health?.status === "quarantined" ||
    freshness?.recommendation === "quarantine" ||
    freshness?.health?.status === "quarantined"
  ) {
    intents.add("quarantine");
  }
  return intents.size === 1 ? [...intents][0] : (intents.size > 1 ? "conflict" : null);
}

function retirementProvenanceReasons(provenance) {
  return RETIREMENT_PROVENANCE_FIELDS.every((field) => (
    typeof provenance?.[field] === "string" && provenance[field].trim() !== ""
  )) ? [] : ["RETIREMENT_PROVENANCE_MISSING"];
}

function expectedStateIds(state) {
  return new Set([
    ...state.activeCatalog.map((record) => record.id),
    ...state.retired.entries.map((entry) => entry.record.id),
  ]);
}

function scopedDecisionReports(health, freshness, state, { includeExistingDecisions }) {
  const ids = includeExistingDecisions ? expectedStateIds(state) : new Set();
  const scopedHealth = {
    ...clone(health),
    entries: health.entries.filter((entry) => ids.has(entry.galleryId)).map(clone),
  };
  const scopedFreshness = {
    ...clone(freshness),
    entries: freshness.entries.filter((entry) => ids.has(entry.galleryId)).map(clone),
    healthSnapshot: {
      ...clone(freshness.healthSnapshot),
      entries: freshness.healthSnapshot.entries
        .filter((entry) => ids.has(entry.galleryId))
        .map(clone),
    },
  };
  delete scopedHealth.status;
  delete scopedFreshness.status;
  delete scopedFreshness.healthSnapshot.status;
  return { health: scopedHealth, freshness: scopedFreshness };
}

function operationFingerprintPayload(operation) {
  const payload = clone(operation);
  delete payload.operationId;
  delete payload.runId;
  delete payload.plannedAt;
  return payload;
}

function planPath(batchNumber) {
  return `plans/catalog-change-plan-${String(batchNumber).padStart(3, "0")}.json`;
}

function inputReceiptEntries(input) {
  const entries = {
    discovery: input.discovery,
    candidateGates: input.candidateGates,
    modelAnalysis: input.modelAnalysis,
    modelAnalysisReceipt: input.modelAnalysisReceipt,
    modelAnalysisVerification: input.modelAnalysisVerification,
    health: input.health,
    freshness: input.freshness,
    activeCatalog: input.activeCatalog,
    retired: input.retired,
    audit: input.audit,
    exemptions: input.exemptions,
    policy: input.policy,
    analysisSchema: input.analysisSchema,
    retirementProvenance: input.retirementProvenance,
    upstreamArtifacts: input.upstreamArtifacts,
  };
  return Object.entries(entries).map(([name, value]) => ({
    name,
    provided: value !== null && value !== undefined,
    fingerprint: hashCanonicalValue(value ?? null),
  }));
}

function reportSummary(ledger, candidateCount, eligibleCount, planCount, operationCount) {
  const entries = [...ledger.values()];
  const candidates = entries.filter((entry) => entry.subjectType === "candidate");
  return {
    candidates: candidateCount,
    eligibleCandidates: eligibleCount,
    plannedCandidates: candidates.filter((entry) => entry.disposition === "planned").length,
    rejectedCandidates: candidates.filter((entry) => entry.disposition === "rejected").length,
    noChangeCandidates: candidates.filter((entry) => entry.disposition === "no-change").length,
    rejectedCatalogTargets: entries.filter((entry) => (
      entry.subjectType === "catalog" && entry.disposition === "rejected"
    )).length,
    plans: planCount,
    operations: operationCount,
  };
}

function finalizeResult({
  input,
  inputFingerprint,
  runId,
  generatedAt,
  status,
  stageReasons,
  upstream,
  ledger,
  plans,
  proposedState,
}) {
  const manifests = plans.map((plan, index) => ({
    batchNumber: index + 1,
    path: planPath(index + 1),
    runId: plan.runId,
    inputFingerprint: plan.inputFingerprint,
    operationCount: plan.operations.length,
    operationIds: plan.operations.map((operation) => operation.operationId),
  }));
  const report = {
    schemaVersion: REPORT_VERSION,
    mode: "report-only",
    mutationPerformed: false,
    status,
    runId,
    generatedAt,
    inputFingerprint,
    stage: {
      status: status === "complete" ? "completed" : "blocked",
      reasonCodes: uniqueReasonCodes(stageReasons),
    },
    upstream,
    summary: reportSummary(
      ledger,
      input.discovery.candidates.length,
      input.candidateGates.eligible.length,
      plans.length,
      plans.reduce((total, plan) => total + plan.operations.length, 0),
    ),
    reasonLedger: sortedLedger(ledger),
    plans: manifests,
    outputs: { ...ARTIFACT_PATHS },
  };
  if (!validateReportSchema(report)) {
    fail("REPORT_SCHEMA_INVALID", `Proposal report is invalid: ${schemaMessage(validateReportSchema)}`);
  }
  const outputValues = [
    [ARTIFACT_PATHS.report, report],
    ...plans.map((plan, index) => [planPath(index + 1), plan]),
    [ARTIFACT_PATHS.activeCatalog, proposedState.activeCatalog],
    [ARTIFACT_PATHS.health, proposedState.health],
    [ARTIFACT_PATHS.retired, proposedState.retired],
    [ARTIFACT_PATHS.audit, proposedState.audit],
  ];
  const receipt = {
    schemaVersion: REPORT_VERSION,
    mode: "report-only",
    mutationPerformed: false,
    runId,
    generatedAt,
    workflowStartedAt: normalizeTimestamp(input.workflowStartedAt, "workflowStartedAt"),
    trustedRepository: input.trustedRepository,
    trustedRef: input.trustedRef,
    trustedSha: input.trustedSha,
    upstreamArtifacts: clone(input.upstreamArtifacts),
    healthArtifact: clone(input.healthArtifact ?? null),
    inputFingerprint,
    reportFingerprint: hashCanonicalValue(report),
    inputs: inputReceiptEntries(input),
    outputs: outputValues.map(([artifactPath, value]) => ({
      path: artifactPath,
      fingerprint: hashCanonicalValue(value),
    })),
  };
  if (!validateReceiptSchema(receipt)) {
    fail("RECEIPT_SCHEMA_INVALID", `Proposal receipt is invalid: ${schemaMessage(validateReceiptSchema)}`);
  }
  return { report, receipt, plans, proposedState };
}

function rejectPendingCandidates(ledger, candidateGates, reasons) {
  for (const [index, eligible] of candidateGates.eligible.entries()) {
    const id = candidateId(eligible?.candidate, `eligible-candidate-${index + 1}`);
    setLedger(ledger, "candidate", id, "rejected", reasons);
  }
}

function baseProposedState(input) {
  return {
    activeCatalog: clone(input.activeCatalog),
    health: clone(input.health),
    retired: clone(input.retired),
    audit: clone(input.audit ?? emptyAuditLog()),
  };
}

function projectValidatedOperations(initialState, operations, {
  runId,
  generatedAt,
  policy,
  trustedRepository,
}) {
  let projectedState = clone(initialState);
  for (const [index, operation] of operations.entries()) {
    const projectionPlan = composeCatalogChangePlan({
      runId: `${runId}-projection-${String(index + 1).padStart(3, "0")}`,
      generatedAt,
      operations: [operation],
      fingerprintInput: {
        operation: operationFingerprintPayload(operation),
        projection: index + 1,
      },
      trustedRepository,
    });
    if (operation.healthAfter === null) {
      validateCatalogChangePlanPolicy(projectionPlan, policy, { trustedRepository });
      const replayed = replayCatalogChangePlan(projectionPlan, {
        activeRecords: projectedState.activeCatalog,
        retiredRecords: projectedState.retired.entries.map((entry) => entry.record),
      }, { trustedRepository });
      projectedState = {
        ...projectedState,
        activeCatalog: replayed.activeRecords,
      };
      continue;
    }
    const audit = projectedState.audit;
    projectedState = applyCatalogPlan({
      plan: projectionPlan,
      activeCatalog: projectedState.activeCatalog,
      health: projectedState.health,
      retired: projectedState.retired,
      audit,
      policy,
      trustedRepository,
    });
    projectedState.audit = audit;
  }
  return projectedState;
}

export function validateCatalogProposalReport(report) {
  if (!validateReportSchema(report)) {
    fail("REPORT_SCHEMA_INVALID", `Proposal report is invalid: ${schemaMessage(validateReportSchema)}`);
  }
  return report;
}

export function validateCatalogProposalReceipt(receipt) {
  if (!validateReceiptSchema(receipt)) {
    fail("RECEIPT_SCHEMA_INVALID", `Proposal receipt is invalid: ${schemaMessage(validateReceiptSchema)}`);
  }
  return receipt;
}

export function createModelAnalysisReceipt(modelAnalysis) {
  return {
    schemaVersion: MODEL_ANALYSIS_VERSION,
    reportFile: "model-analysis.json",
    reportFileHash: prettyJsonHash(modelAnalysis),
    reportFingerprint: prefixedCanonicalHash(modelAnalysis),
    analysisCount: analysisValues(modelAnalysis).length,
    eligibleSet: clone(modelAnalysis.eligibleSet),
    rejectedLedger: clone(modelAnalysis.rejectedLedger),
    provenance: clone(modelAnalysis.provenance),
    configuration: clone(modelAnalysis.configuration),
    fileHashes: clone(modelAnalysis.fileHashes),
  };
}

export function proposeCatalogChanges(input = {}, { now = new Date() } = {}) {
  requireObject(input, "input");
  requireObject(input.discovery, "discovery");
  requireObject(input.candidateGates, "candidateGates");
  requireArray(input.discovery.candidates, "discovery.candidates");
  requireArray(input.candidateGates.eligible, "candidateGates.eligible");
  requireArray(input.candidateGates.rejected, "candidateGates.rejected");
  requireArray(input.activeCatalog, "activeCatalog");
  requireObject(input.health, "health");
  requireArray(input.health.entries, "health.entries");
  if (input.freshness !== null && input.freshness !== undefined) {
    requireObject(input.freshness, "freshness");
    requireArray(input.freshness.entries, "freshness.entries");
    requireObject(input.freshness.healthSnapshot, "freshness.healthSnapshot");
    requireArray(input.freshness.healthSnapshot.entries, "freshness.healthSnapshot.entries");
  }
  retiredRecordEntries(input.retired);
  requireObject(input.exemptions, "exemptions");
  requireObject(input.policy, "policy");
  const coverageStatus = candidateCoverageStatus(input.candidateGates);

  const policyReasons = policyBlockReasons(input.policy);
  const modelRequired = aiPolicyEnabled(input.policy);
  validateUpstreamArtifacts(input, modelRequired);
  const inputFingerprint = inputFingerprintFor(input);
  const { generatedAt } = validateRunTimestamps(input, now);
  const runId = input.runId
    ? requireString(input.runId, "runId")
    : `proposal-${inputFingerprint.slice(0, 24)}`;
  const ledger = initialLedger(input.discovery, input.candidateGates);
  const upstream = upstreamState(input, modelRequired);
  const upstreamFailure = upstreamBlock(upstream);
  const initialState = baseProposedState(input);

  if (upstreamFailure || policyReasons.length > 0) {
    const reasons = uniqueReasonCodes([
      ...(upstreamFailure?.reasons ?? []),
      ...policyReasons,
    ]);
    rejectPendingCandidates(ledger, input.candidateGates, reasons);
    return finalizeResult({
      input,
      inputFingerprint,
      runId,
      generatedAt,
      status: upstreamFailure?.status ?? "blocked",
      stageReasons: reasons,
      upstream,
      ledger,
      plans: [],
      proposedState: initialState,
    });
  }

  requireObject(input.freshness, "freshness");
  requireArray(input.freshness.entries, "freshness.entries");
  requireObject(input.freshness.healthSnapshot, "freshness.healthSnapshot");
  requireArray(input.freshness.healthSnapshot.entries, "freshness.healthSnapshot.entries");

  const existingChangeBlockReasons = uniqueReasonCodes([
    ...(coverageStatus === "partial"
      ? ["CANDIDATE_COVERAGE_PARTIAL_PUBLISH_ONLY"]
      : []),
    ...([upstream.health, upstream.freshness].every((status) => status === "complete")
      ? []
      : ["HEALTH_FRESHNESS_INCOMPLETE_PUBLISH_ONLY"]),
  ]);
  const existingChangesAllowed = existingChangeBlockReasons.length === 0;

  const receiptReasons = validateModelAnalysisReceipt(
    input.modelAnalysis,
    input.modelAnalysisReceipt,
    input,
  );
  if (receiptReasons.length > 0) {
    rejectPendingCandidates(ledger, input.candidateGates, receiptReasons);
    return finalizeResult({
      input,
      inputFingerprint,
      runId,
      generatedAt,
      status: "blocked",
      stageReasons: receiptReasons,
      upstream,
      ledger,
      plans: [],
      proposedState: initialState,
    });
  }

  const bindings = candidateBindings(input.discovery);
  const { index: analyses, duplicates: duplicateAnalyses } = analysisIndex(input.modelAnalysis);
  const healthById = mapById(input.health.entries, "galleryId");
  const freshnessById = mapById(input.freshness.entries, "galleryId");
  const retiredRecords = retiredRecordEntries(input.retired).map((entry) => entry.record);
  const gateCatalog = [...input.activeCatalog, ...retiredRecords];
  const catalogById = new Map(gateCatalog.map((record) => [record.id, record]));
  const candidateByTarget = new Map();
  const candidateGateByTarget = new Map();
  const eligibleCandidates = [...input.candidateGates.eligible]
    .map((entry, index) => ({ entry, candidate: entry?.candidate, index }))
    .sort((left, right) => (
      (candidateId(left.candidate, `candidate-${left.index + 1}`))
        .localeCompare(candidateId(right.candidate, `candidate-${right.index + 1}`))
    ));

  for (const { entry, candidate, index } of eligibleCandidates) {
    const id = candidateId(candidate, `eligible-candidate-${index + 1}`);
    const targetId = galleryId(candidate);
    const existingTarget = targetId ? catalogById.get(targetId) ?? null : null;
    const reasons = candidatePrecheckReasons({
      candidate,
      gateEntry: entry,
      candidateGates: input.candidateGates,
      gateCatalog,
      boundCandidates: bindings.get(id) ?? [],
      analyses,
      duplicateAnalyses,
      existingTarget,
      healthById,
      freshnessById,
      existingChangesAllowed,
      existingChangeBlockReasons,
    });
    if (targetId && candidateByTarget.has(targetId)) reasons.push("GALLERY_ID_DUPLICATE");
    if (reasons.length > 0) {
      setLedger(ledger, "candidate", id, "rejected", reasons);
      continue;
    }
    candidateByTarget.set(targetId, candidate);
    candidateGateByTarget.set(targetId, entry);
    setLedger(ledger, "candidate", id, "no-change", ["NO_CHANGE"]);
  }

  const targets = new Set(candidateByTarget.keys());
  for (const record of existingChangesAllowed
    ? [...input.activeCatalog].sort((left, right) => left.id.localeCompare(right.id))
    : []) {
    const intent = lifecycleIntent(healthById.get(record.id), freshnessById.get(record.id));
    if (intent === "conflict") {
      setLedger(ledger, "catalog", record.id, "rejected", ["CONFLICTING_OPERATIONS"]);
      continue;
    }
    if (!intent) continue;
    if (intent === "retire") {
      const reasons = retirementProvenanceReasons(input.retirementProvenance);
      if (reasons.length > 0) {
        setLedger(ledger, "catalog", record.id, "rejected", reasons);
        continue;
      }
    }
    targets.add(record.id);
    if (!candidateByTarget.has(record.id)) {
      setLedger(ledger, "catalog", record.id, "no-change", ["NO_CHANGE"]);
    }
  }

  const rawOperations = [];
  const sortedTargets = [...targets].sort((left, right) => left.localeCompare(right));
  for (const [index, targetId] of sortedTargets.entries()) {
    const candidate = candidateByTarget.get(targetId) ?? null;
    const subjectType = candidate ? "candidate" : "catalog";
    const subjectId = candidate ? candidate.identityKey : targetId;
    const decisions = scopedDecisionReports(
      input.health,
      input.freshness,
      initialState,
      { includeExistingDecisions: existingChangesAllowed },
    );
    const targetInput = {
      runId: `${runId}-target-${String(index + 1).padStart(3, "0")}`,
      generatedAt,
      trustedRepository: input.trustedRepository,
      candidates: candidate ? [candidate] : [],
      analyses: candidate ? [analyses.get(candidate.identityKey)] : [],
      candidateGates: candidate ? [candidateGateByTarget.get(targetId)] : [],
      health: decisions.health,
      freshness: decisions.freshness,
      activeRecords: initialState.activeCatalog,
      retiredRecords: initialState.retired,
      policy: input.policy,
      exemptions: input.exemptions,
      ...(input.retirementProvenance ?? {}),
    };
    try {
      const targetPlan = buildCatalogChangePlanForTargets(targetInput, [targetId]);
      if (targetPlan.operations.length === 0) {
        setLedger(ledger, subjectType, subjectId, "no-change", ["NO_CHANGE"]);
        continue;
      }
      if (targetPlan.operations.length !== 1) {
        fail("TARGET_SCOPE_INVALID", `Target ${targetId} produced more than one operation.`);
      }
      if (
        !existingChangesAllowed &&
        (targetPlan.operations[0].type !== "publish" || targetPlan.operations[0].before !== null)
      ) {
        fail(
          "PUBLISH_ONLY_MODE_VIOLATION",
          `Target ${targetId} attempted an existing-record operation in publish-only mode.`,
        );
      }
      rawOperations.push(clone(targetPlan.operations[0]));
      setLedger(ledger, subjectType, subjectId, "planned", ["OPERATION_PLANNED"]);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "PROPOSAL_REJECTED";
      setLedger(
        ledger,
        subjectType,
        subjectId,
        "rejected",
        [code],
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const maximum = Math.min(input.policy.batching.maxEntriesPerPullRequest, MAX_OPERATIONS_PER_PLAN);
  const orderedOperations = rawOperations.sort(compareCatalogOperations);
  const plans = [];
  let proposedState = clone(initialState);
  try {
    proposedState = projectValidatedOperations(initialState, orderedOperations, {
      runId,
      generatedAt,
      policy: input.policy,
      trustedRepository: input.trustedRepository,
    });
    let replayedRecords = {
      activeRecords: clone(initialState.activeCatalog),
      retiredRecords: initialState.retired.entries.map((entry) => clone(entry.record)),
    };
    let proposedAudit = clone(initialState.audit);
    for (let offset = 0; offset < orderedOperations.length; offset += maximum) {
      const batchNumber = plans.length + 1;
      const batchOperations = orderedOperations.slice(offset, offset + maximum);
      const plan = composeCatalogChangePlan({
        runId: `${runId}-batch-${String(batchNumber).padStart(3, "0")}`,
        generatedAt,
        operations: batchOperations,
        fingerprintInput: {
          proposalInputFingerprint: inputFingerprint,
          batchNumber,
          operations: batchOperations.map(operationFingerprintPayload),
        },
        trustedRepository: input.trustedRepository,
      });
      validateCatalogChangePlanPolicy(plan, input.policy, {
        trustedRepository: input.trustedRepository,
      });
      replayedRecords = replayCatalogChangePlan(plan, replayedRecords, {
        trustedRepository: input.trustedRepository,
      });
      proposedAudit = appendAuditPlan(proposedAudit, plan, {
        trustedRepository: input.trustedRepository,
      });
      plans.push(plan);
    }
    if (
      !isDeepStrictEqual(replayedRecords.activeRecords, proposedState.activeCatalog) ||
      !isDeepStrictEqual(
        replayedRecords.retiredRecords,
        proposedState.retired.entries.map((entry) => entry.record),
      )
    ) {
      fail("PROPOSAL_REPLAY_FAILED", "Projected proposal state does not match plan replay.");
    }
    proposedState.audit = proposedAudit;
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "PROPOSAL_REPLAY_FAILED";
    for (const entry of ledger.values()) {
      if (entry.disposition === "planned") {
        setLedger(ledger, entry.subjectType, entry.subjectId, "rejected", [code]);
      }
    }
    return finalizeResult({
      input,
      inputFingerprint,
      runId,
      generatedAt,
      status: "blocked",
      stageReasons: [code],
      upstream,
      ledger,
      plans: [],
      proposedState: initialState,
    });
  }

  return finalizeResult({
    input,
    inputFingerprint,
    runId,
    generatedAt,
    status: "complete",
    stageReasons: existingChangeBlockReasons,
    upstream,
    ledger,
    plans,
    proposedState,
  });
}

export async function writeCatalogProposalArtifacts(reportDirectory, result) {
  const root = path.resolve(requireString(reportDirectory, "reportDirectory"));
  await mkdir(root, { recursive: true });
  await Promise.all([
    rm(path.join(root, "plans"), { recursive: true, force: true }),
    rm(path.join(root, "proposed"), { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(path.join(root, "plans"), { recursive: true }),
    mkdir(path.join(root, "proposed"), { recursive: true }),
  ]);
  const artifacts = [
    [ARTIFACT_PATHS.report, result.report],
    [ARTIFACT_PATHS.receipt, result.receipt],
    ...result.plans.map((plan, index) => [planPath(index + 1), plan]),
    [ARTIFACT_PATHS.activeCatalog, result.proposedState.activeCatalog],
    [ARTIFACT_PATHS.health, result.proposedState.health],
    [ARTIFACT_PATHS.retired, result.proposedState.retired],
    [ARTIFACT_PATHS.audit, result.proposedState.audit],
  ];
  await Promise.all(artifacts.map(([artifactPath, value]) => (
    writeFile(path.join(root, ...artifactPath.split("/")), `${JSON.stringify(value, null, 2)}\n`)
  )));
  return artifacts.map(([artifactPath]) => artifactPath);
}

function usage() {
  return [
    "Usage: node scripts/gallery-pipeline/propose-catalog-changes.mjs --report-directory directory [options]",
    "",
    "Creates report-only catalog plans, receipts, and proposed state snapshots.",
    "The command has no catalog write or AI invocation mode.",
    "",
    "Options:",
    "  --fixtures                         Use the deterministic enabled-policy fixture",
    "  --discovery path                  Discovery report JSON",
    "  --candidate-gates path            Candidate-gate report JSON",
    "  --model-analysis path             Precomputed model-analysis report JSON",
    "  --model-analysis-receipt path     Receipt binding the model-analysis report",
    "  --health path                     Proposed health snapshot JSON",
    "  --health-report path              Health producer report JSON",
    "  --health-receipt path             Receipt binding the health artifact files",
    "  --freshness path                  Freshness report JSON",
    "  --active path                     Current active catalog JSON",
    "  --retired path                    Current retired catalog JSON",
    "  --audit path                      Current audit JSON (empty when absent)",
    "  --exemptions path                 Current exemptions JSON",
    "  --policy path                     Current policy JSON",
    "  --analysis-schema path            Candidate-analysis output schema JSON",
    "  --upstream-artifacts path         Verified producer artifact provenance JSON",
    "  --retirement-provenance path      Existing retirement PR provenance JSON",
    "  --run-id value                    Deterministic proposal run ID",
    "  --generated-at date-time          Actual proposal execution timestamp (required)",
    "  --workflow-started-at date-time   GitHub workflow run start timestamp (required)",
    "  --trusted-repository owner/name   Repository identity for provenance checks",
    "  --trusted-ref ref                 Checked-out branch ref for provenance checks",
    "  --trusted-sha sha                 Checked-out commit SHA for provenance checks",
  ].join("\n");
}

function argumentValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) fail("ARGUMENT_INVALID", `${option} requires a value.`);
  return value;
}

function parseArguments(arguments_) {
  const options = { fixture: false, reportDirectory: null, paths: {} };
  const pathOptions = new Map([
    ["--discovery", "discovery"],
    ["--candidate-gates", "candidateGates"],
    ["--model-analysis", "modelAnalysis"],
    ["--model-analysis-receipt", "modelAnalysisReceipt"],
    ["--health", "health"],
    ["--health-report", "healthReport"],
    ["--health-receipt", "healthReceipt"],
    ["--freshness", "freshness"],
    ["--active", "activeCatalog"],
    ["--retired", "retired"],
    ["--audit", "audit"],
    ["--exemptions", "exemptions"],
    ["--policy", "policy"],
    ["--analysis-schema", "analysisSchema"],
    ["--upstream-artifacts", "upstreamArtifacts"],
    ["--retirement-provenance", "retirementProvenance"],
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") continue;
    if (["--write", "--apply", "--mutate"].includes(argument)) {
      fail("WRITE_MODE_DISABLED", `${argument} is not supported; proposal generation is report-only.`);
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--fixtures") {
      if (options.fixture) fail("ARGUMENT_INVALID", "--fixtures may only be specified once.");
      options.fixture = true;
      continue;
    }
    if (argument === "--report-directory") {
      if (options.reportDirectory !== null) fail("ARGUMENT_INVALID", "--report-directory may only be specified once.");
      options.reportDirectory = argumentValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--report-directory=")) {
      if (options.reportDirectory !== null) fail("ARGUMENT_INVALID", "--report-directory may only be specified once.");
      options.reportDirectory = argument.slice("--report-directory=".length);
      if (!options.reportDirectory) fail("ARGUMENT_INVALID", "--report-directory requires a value.");
      continue;
    }
    if ([
      "--run-id",
      "--generated-at",
      "--workflow-started-at",
      "--trusted-repository",
      "--trusted-ref",
      "--trusted-sha",
    ].includes(argument)) {
      const name = {
        "--run-id": "runId",
        "--generated-at": "generatedAt",
        "--workflow-started-at": "workflowStartedAt",
        "--trusted-repository": "trustedRepository",
        "--trusted-ref": "trustedRef",
        "--trusted-sha": "trustedSha",
      }[argument];
      if (options[name] !== undefined) fail("ARGUMENT_INVALID", `${argument} may only be specified once.`);
      options[name] = argumentValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (pathOptions.has(argument)) {
      const name = pathOptions.get(argument);
      if (options.paths[name] !== undefined) fail("ARGUMENT_INVALID", `${argument} may only be specified once.`);
      options.paths[name] = argumentValue(arguments_, index, argument);
      index += 1;
      continue;
    }
    fail("ARGUMENT_INVALID", `Unknown argument: ${argument}`);
  }
  if (!options.help && !options.reportDirectory) {
    fail("ARGUMENT_INVALID", "--report-directory is required.");
  }
  if (options.fixture && Object.keys(options.paths).length > 0) {
    fail("ARGUMENT_INVALID", "--fixtures cannot be combined with input path overrides.");
  }
  return options;
}

async function readJsonSnapshot(filePath) {
  const bytes = await readFile(path.resolve(filePath));
  return {
    bytes,
    data: JSON.parse(bytes.toString("utf8")),
  };
}

async function readOptionalJsonSnapshot(filePath) {
  try {
    return await readJsonSnapshot(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readHealthArtifactSnapshot(filePath, name) {
  try {
    return await readJsonSnapshot(filePath);
  } catch (error) {
    fail(
      "HEALTH_ARTIFACT_INVALID",
      `${name} is missing or malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadFileInputs(options, env, now) {
  const resolveInput = (name) => path.resolve(REPOSITORY_ROOT, options.paths[name] ?? DEFAULT_INPUT_PATHS[name]);
  const [
    discovery,
    candidateGates,
    modelAnalysis,
    modelAnalysisReceipt,
    health,
    healthReport,
    healthReceipt,
    freshness,
    activeCatalog,
    retired,
    audit,
    exemptions,
    policy,
    analysisSchema,
    upstreamArtifacts,
    retirementProvenance,
  ] = await Promise.all([
    readJsonSnapshot(resolveInput("discovery")),
    readJsonSnapshot(resolveInput("candidateGates")),
    options.paths.modelAnalysis ? readJsonSnapshot(resolveInput("modelAnalysis")) : null,
    options.paths.modelAnalysisReceipt ? readJsonSnapshot(resolveInput("modelAnalysisReceipt")) : null,
    readHealthArtifactSnapshot(resolveInput("health"), "Proposed health snapshot"),
    readHealthArtifactSnapshot(resolveInput("healthReport"), "Health report"),
    readHealthArtifactSnapshot(resolveInput("healthReceipt"), "Health receipt"),
    readOptionalJsonSnapshot(resolveInput("freshness")),
    readJsonSnapshot(resolveInput("activeCatalog")),
    readJsonSnapshot(resolveInput("retired")),
    readOptionalJsonSnapshot(resolveInput("audit")),
    readJsonSnapshot(resolveInput("exemptions")),
    readJsonSnapshot(resolveInput("policy")),
    readJsonSnapshot(resolveInput("analysisSchema")),
    options.paths.upstreamArtifacts ? readJsonSnapshot(resolveInput("upstreamArtifacts")) : null,
    options.paths.retirementProvenance ? readJsonSnapshot(resolveInput("retirementProvenance")) : null,
  ]);
  const sourceDiscoveryArtifact = upstreamArtifacts?.data
    .find((artifact) => artifact?.name === "discovery");
  const healthArtifact = verifyHealthArtifact({
    activeCatalog,
    health,
    report: healthReport,
    receipt: healthReceipt,
    upstreamArtifacts,
    now,
  });
  const modelAnalysisVerification = modelAnalysis && sourceDiscoveryArtifact
    ? createModelAnalysisVerification({
      modelAnalysis: modelAnalysis.bytes,
      discovery: discovery.bytes,
      candidateGates: candidateGates.bytes,
      activeCatalog: activeCatalog.bytes,
      retiredCatalog: retired.bytes,
      policy: policy.bytes,
      analysisSchema: analysisSchema.bytes,
      sourceDiscoveryArtifact: Buffer.from(`${JSON.stringify(sourceDiscoveryArtifact, null, 2)}\n`),
    })
    : null;
  return {
    runId: options.runId ?? (env.GITHUB_RUN_ID ? `proposal-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}` : undefined),
    generatedAt: options.generatedAt,
    workflowStartedAt: options.workflowStartedAt,
    trustedRepository: options.trustedRepository ?? env.GITHUB_REPOSITORY,
    trustedRef: options.trustedRef,
    trustedSha: options.trustedSha,
    discovery: discovery.data,
    candidateGates: candidateGates.data,
    modelAnalysis: modelAnalysis?.data ?? null,
    modelAnalysisReceipt: modelAnalysisReceipt?.data ?? null,
    modelAnalysisVerification,
    health: health.data,
    freshness: freshness?.data ?? null,
    activeCatalog: activeCatalog.data,
    retired: retired.data,
    audit: audit?.data ?? emptyAuditLog(),
    exemptions: exemptions.data,
    policy: policy.data,
    analysisSchema: analysisSchema.data,
    upstreamArtifacts: upstreamArtifacts?.data ?? null,
    healthArtifact,
    retirementProvenance: retirementProvenance?.data ?? null,
  };
}

function prettyJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function bindFixtureModelAnalysis(input) {
  if (!input.analysisSchema) {
    input.analysisSchema = (await readJsonSnapshot(
      path.join(REPOSITORY_ROOT, DEFAULT_INPUT_PATHS.analysisSchema),
    )).data;
  }
  if (!input.modelAnalysis) {
    input.modelAnalysisVerification = null;
    return input;
  }
  Object.assign(
    input.modelAnalysis.configuration,
    expectedModelAnalysisConfigurationHashes(input),
  );
  const sourceDiscoveryArtifact = input.upstreamArtifacts
    .find((artifact) => artifact?.name === "discovery");
  const verificationInputs = {
    discovery: prettyJsonBytes(input.discovery),
    candidateGates: prettyJsonBytes(input.candidateGates),
    activeCatalog: prettyJsonBytes(input.activeCatalog),
    retiredCatalog: prettyJsonBytes(input.retired),
    policy: prettyJsonBytes(input.policy),
    analysisSchema: prettyJsonBytes(input.analysisSchema),
    sourceDiscoveryArtifact: prettyJsonBytes(sourceDiscoveryArtifact),
  };
  input.modelAnalysis.fileHashes = createModelAnalysisVerification({
    modelAnalysis: prettyJsonBytes(input.modelAnalysis),
    ...verificationInputs,
  }).fileHashes;
  input.modelAnalysisReceipt = createModelAnalysisReceipt(input.modelAnalysis);
  input.modelAnalysisVerification = createModelAnalysisVerification({
    modelAnalysis: prettyJsonBytes(input.modelAnalysis),
    ...verificationInputs,
  });
  return input;
}

export function catalogProposalExitCode(report) {
  return ["incomplete", "partial", "indeterminate"].includes(report.status) ? 2 : 0;
}

export async function main(
  arguments_ = process.argv.slice(2),
  { stdout = process.stdout, env = process.env, loadFixture, now = new Date() } = {},
) {
  const options = parseArguments(arguments_);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0, result: null };
  }
  let input;
  if (options.fixture) {
    const fixtureLoader = loadFixture ?? (async () => {
      const fixtureModule = await import("./propose-catalog-changes.fixtures.mjs");
      return fixtureModule.makeProposalFixture({ candidateCount: 146 });
    });
    input = await bindFixtureModelAnalysis(clone(await fixtureLoader()));
    if (options.runId) input.runId = options.runId;
    if (options.generatedAt) input.generatedAt = options.generatedAt;
    if (options.workflowStartedAt) input.workflowStartedAt = options.workflowStartedAt;
    if (options.trustedRepository) input.trustedRepository = options.trustedRepository;
    if (options.trustedRef) input.trustedRef = options.trustedRef;
    if (options.trustedSha) input.trustedSha = options.trustedSha;
  } else {
    input = await loadFileInputs(options, env, now);
  }
  const result = proposeCatalogChanges(input, { now });
  await writeCatalogProposalArtifacts(options.reportDirectory, result);
  stdout.write(`${JSON.stringify({
    status: result.report.status,
    plans: result.report.summary.plans,
    operations: result.report.summary.operations,
    reportDirectory: path.resolve(options.reportDirectory),
  })}\n`);
  return { exitCode: catalogProposalExitCode(result.report), result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode } = await main();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}