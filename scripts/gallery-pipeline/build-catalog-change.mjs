import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { normalizeCandidate } from "./normalize.mjs";
import { canonicalizeUrl } from "./shared/canonicalize.mjs";
import { NON_WAIVABLE_RULE_IDS, SOURCE_SHARING_POLICY } from "./validation.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const pipelineDirectory = path.resolve(moduleDirectory, "..", "..", ".github", "gallery-pipeline");

const [catalogSchema, analysisSchema, healthSchema, retiredEntriesSchema, exemptionsSchema] = await Promise.all([
  readJson(path.join(pipelineDirectory, "catalog.schema.json")),
  readJson(path.join(pipelineDirectory, "analysis.schema.json")),
  readJson(path.join(pipelineDirectory, "health.schema.json")),
  readJson(path.join(pipelineDirectory, "retired-entries.schema.json")),
  readJson(path.join(pipelineDirectory, "exemptions.schema.json")),
]);

const PLAN_VERSION = "1.0.0";
const FRESHNESS_VERSION = "1.0.0";
const SUPPORTED_POLICY_VERSION = "1.0.0";
const SUPPORTED_CONTRACT_VERSIONS = Object.freeze({
  policy: "1.0.0",
  catalog: "2.0.0",
  analysis: "1.0.0",
  health: "1.0.0",
  retiredEntries: "1.0.0",
  exemptions: "1.0.0",
});
const OPERATION_ORDER = new Map([
  ["publish", 0],
  ["update", 1],
  ["quarantine", 2],
  ["retire", 3],
  ["restore", 4],
]);
const MUTATION_FLAGS = Object.freeze({
  publish: "catalogPublication",
  update: "metadataUpdate",
  quarantine: "quarantine",
  retire: "retirement",
  restore: "restoration",
});
const AI_FLAGS = Object.freeze({
  publish: ["relevanceClassification", "summaryGeneration", "summaryGroundingVerification", "semanticDuplicateDetection", "freshnessAnalysis"],
  update: ["relevanceClassification", "summaryGeneration", "summaryGroundingVerification", "semanticDuplicateDetection", "freshnessAnalysis"],
  quarantine: ["freshnessAnalysis"],
  retire: ["freshnessAnalysis"],
  restore: ["relevanceClassification", "summaryGeneration", "summaryGroundingVerification", "semanticDuplicateDetection", "freshnessAnalysis"],
});
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RECORD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SEMANTIC_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const FRESHNESS_RECOMMENDATION_BY_STATUS = Object.freeze({
  healthy: "keep",
  "needs-review": "keep-visible",
  quarantined: "quarantine",
  retired: "retire",
});

export class CatalogChangePlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CatalogChangePlanError";
    this.code = code;
    this.details = details;
  }
}

export const CATALOG_CHANGE_PLAN_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:gallery-pipeline:schema:catalog-change-plan:1.0.0",
  title: "Gallery catalog change plan",
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "mode",
    "runId",
    "generatedAt",
    "inputFingerprint",
    "summary",
    "operations",
  ],
  properties: {
    version: { const: PLAN_VERSION },
    mode: { const: "plan-only" },
    runId: { type: "string", minLength: 1 },
    generatedAt: { type: "string", format: "date-time" },
    inputFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["publish", "update", "quarantine", "retire", "restore", "total"],
      properties: Object.fromEntries(
        [...OPERATION_ORDER.keys(), "total"].map((name) => [name, { type: "integer", minimum: 0 }]),
      ),
    },
    operations: {
      type: "array",
      items: { $ref: "#/$defs/operation" },
    },
  },
  $defs: {
    recordOrNull: {
      oneOf: [
        { type: "null" },
        { $ref: "urn:gallery-pipeline:schema:catalog:2.0.0#/$defs/v2Record" },
      ],
    },
    evidenceReference: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id"],
      properties: {
        kind: {
          enum: ["active-record", "analysis", "candidate", "freshness", "health", "policy", "retired-record"],
        },
        id: { type: "string", minLength: 1 },
        observedAt: { type: "string", format: "date-time" },
        source: { type: "string", format: "uri" },
      },
    },
    operation: {
      type: "object",
      additionalProperties: false,
      required: [
        "operationId",
        "type",
        "targetId",
        "runId",
        "plannedAt",
        "before",
        "after",
        "reasonCodes",
        "evidenceReferences",
      ],
      properties: {
        operationId: { type: "string", minLength: 1 },
        type: { enum: [...OPERATION_ORDER.keys()] },
        targetId: { type: "string", pattern: RECORD_ID_PATTERN.source },
        runId: { type: "string", minLength: 1 },
        plannedAt: { type: "string", format: "date-time" },
        before: { $ref: "#/$defs/recordOrNull" },
        after: { $ref: "urn:gallery-pipeline:schema:catalog:2.0.0#/$defs/v2Record" },
        reasonCodes: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: REASON_CODE_PATTERN.source },
        },
        evidenceReferences: {
          type: "array",
          minItems: 1,
          items: { $ref: "#/$defs/evidenceReference" },
        },
      },
    },
  },
});

const schemaAjv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(schemaAjv);
schemaAjv.addSchema(catalogSchema);
schemaAjv.addSchema(healthSchema, "gallery-health-schema");
const validateV2Record = schemaAjv.compile({
  $ref: "urn:gallery-pipeline:schema:catalog:2.0.0#/$defs/v2Record",
});
const validateAnalysis = schemaAjv.compile(analysisSchema);
const validateHealthSnapshot = schemaAjv.compile(healthSchema);
const validateHealthEntry = schemaAjv.compile({ $ref: "gallery-health-schema#/$defs/healthEntry" });
const validateRetiredEntries = schemaAjv.compile(retiredEntriesSchema);
const validateExemptions = schemaAjv.compile(exemptionsSchema);
const validatePlan = schemaAjv.compile(CATALOG_CHANGE_PLAN_SCHEMA);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function schemaMessage(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function fail(code, message, details = {}) {
  throw new CatalogChangePlanError(code, message, details);
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("MISSING_GATE", `${name} must be an object.`);
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    fail("MISSING_GATE", `${name} must be an array.`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("MISSING_GATE", `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeTimestamp(value, name) {
  const timestamp = new Date(requireString(value, name));
  if (Number.isNaN(timestamp.valueOf())) {
    fail("MISSING_GATE", `${name} must be a valid date-time.`);
  }
  return timestamp.toISOString();
}

function requireHttpsUrl(value, name) {
  const input = requireString(value, name);
  let url;
  try {
    url = new URL(input);
  } catch {
    fail("SCHEMA_INVALID", `${name} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    fail("SCHEMA_INVALID", `${name} must be a valid HTTPS URL without credentials.`);
  }
  return input;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") fail("MISSING_GATE", `${name} must be a boolean.`);
  return value;
}

function requireUnitInterval(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("MISSING_GATE", `${name} must be a finite number from 0 through 1.`);
  }
  return value;
}

function validatePolicyInput(policy) {
  requireObject(policy, "policy");
  const policyVersion = requireString(policy.version, "policy.version");
  if (!SEMANTIC_VERSION_PATTERN.test(policyVersion) || policyVersion !== SUPPORTED_POLICY_VERSION) {
    fail("MISSING_GATE", `Catalog planning requires policy version ${SUPPORTED_POLICY_VERSION}.`);
  }
  const contractVersions = requireObject(policy.contractVersions, "policy.contractVersions");
  for (const [name, supportedVersion] of Object.entries(SUPPORTED_CONTRACT_VERSIONS)) {
    const version = requireString(contractVersions[name], `policy.contractVersions.${name}`);
    if (!SEMANTIC_VERSION_PATTERN.test(version) || version !== supportedVersion) {
      fail("MISSING_GATE", `Catalog planning requires ${name} contract version ${supportedVersion}.`);
    }
  }
  if (contractVersions.policy !== policyVersion) {
    fail("MISSING_GATE", "Policy version does not match policy.contractVersions.policy.");
  }
  const thresholds = requireObject(policy.thresholds, "policy.thresholds");
  requireUnitInterval(thresholds.materialRelevance, "policy.thresholds.materialRelevance");
  requireUnitInterval(thresholds.summaryGrounding, "policy.thresholds.summaryGrounding");
  const batching = requireObject(policy.batching, "policy.batching");
  if (!Number.isSafeInteger(batching.maxEntriesPerPullRequest) || batching.maxEntriesPerPullRequest < 1) {
    fail("MISSING_GATE", "policy.batching.maxEntriesPerPullRequest must be a positive integer.");
  }
  const lifecycle = requireObject(policy.lifecycle, "policy.lifecycle");
  if (!Number.isSafeInteger(lifecycle.requiredConfirmations) || lifecycle.requiredConfirmations < 1) {
    fail("MISSING_GATE", "policy.lifecycle.requiredConfirmations must be a positive integer.");
  }
  if (!Number.isSafeInteger(lifecycle.retirementGraceDays) || lifecycle.retirementGraceDays < 0) {
    fail("MISSING_GATE", "policy.lifecycle.retirementGraceDays must be a non-negative integer.");
  }
  const http = requireObject(policy.http, "policy.http");
  const retryDelaySeconds = requireArray(http.retryDelaySeconds, "policy.http.retryDelaySeconds");
  if (
    retryDelaySeconds.length === 0 ||
    retryDelaySeconds.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
  ) {
    fail("MISSING_GATE", "policy.http.retryDelaySeconds must contain non-negative integers.");
  }
  if (!Number.isSafeInteger(http.timeoutSeconds) || http.timeoutSeconds < 1) {
    fail("MISSING_GATE", "policy.http.timeoutSeconds must be a positive integer.");
  }
  const exemptionPolicy = requireObject(policy.exemptions, "policy.exemptions");
  if (!Number.isSafeInteger(exemptionPolicy.maximumDurationDays) || exemptionPolicy.maximumDurationDays < 1) {
    fail("MISSING_GATE", "policy.exemptions.maximumDurationDays must be a positive integer.");
  }
  const automation = requireObject(policy.automation, "policy.automation");
  requireBoolean(automation.emergencyDisable, "policy.automation.emergencyDisable");
  if (automation.mutationMode !== "dry-run") {
    fail("MUTATION_MODE_INVALID", "Catalog planning requires policy automation.mutationMode to be dry-run.");
  }
  const mutation = requireObject(automation.mutation, "policy.automation.mutation");
  for (const flag of [...new Set(Object.values(MUTATION_FLAGS))]) {
    requireBoolean(mutation[flag], `policy.automation.mutation.${flag}`);
  }
  const ai = requireObject(automation.ai, "policy.automation.ai");
  for (const flag of [...new Set(Object.values(AI_FLAGS).flat())]) {
    requireBoolean(ai[flag], `policy.automation.ai.${flag}`);
  }
  return policy;
}

function decisionEvidenceWindowMilliseconds(policy) {
  const retryDelays = policy.http.retryDelaySeconds;
  const httpEnvelope = (
    retryDelays.reduce((total, delay) => total + delay, 0) +
    retryDelays.length * policy.http.timeoutSeconds
  ) * 1000;
  // A decision may use evidence from the current lifecycle grace period. A zero-day
  // grace still permits one complete configured HTTP retry envelope.
  return Math.max(policy.lifecycle.retirementGraceDays * DAY_MILLISECONDS, httpEnvelope);
}

function requireCurrentRunTimestamp(value, name, plannedAt, maximumAgeMilliseconds) {
  const timestamp = normalizeTimestamp(value, name);
  const observedTime = new Date(timestamp).getTime();
  const runTime = new Date(plannedAt).getTime();
  if (observedTime > runTime || runTime - observedTime > maximumAgeMilliseconds) {
    fail("MISSING_GATE", `${name} is outside the current run evidence window.`);
  }
  return timestamp;
}

function requireEmbeddedObservationTimestamp(
  value,
  name,
  envelopeGeneratedAt,
  plannedAt,
  maximumAgeMilliseconds,
) {
  const timestamp = requireCurrentRunTimestamp(value, name, plannedAt, maximumAgeMilliseconds);
  if (new Date(timestamp).getTime() > new Date(envelopeGeneratedAt).getTime()) {
    fail("MISSING_GATE", `${name} occurs after its envelope generatedAt.`);
  }
  return timestamp;
}

function validateHealthObservation(entry, scope, envelopeGeneratedAt, plannedAt, maximumAgeMilliseconds) {
  requireEmbeddedObservationTimestamp(
    entry.checkedAt,
    `${scope}.checkedAt`,
    envelopeGeneratedAt,
    plannedAt,
    maximumAgeMilliseconds,
  );
  for (const [index, evidence] of entry.evidence.entries()) {
    requireEmbeddedObservationTimestamp(
      evidence.observedAt,
      `${scope}.evidence[${index}].observedAt`,
      envelopeGeneratedAt,
      plannedAt,
      maximumAgeMilliseconds,
    );
    let evidenceSource;
    try {
      evidenceSource = canonicalizeUrl(evidence.source);
    } catch {
      fail("SCHEMA_INVALID", `${scope}.evidence[${index}].source is invalid.`);
    }
    if (evidenceSource !== entry.canonicalSource) {
      fail("CONFLICTING_OPERATIONS", `${scope}.evidence[${index}] does not match its health source.`);
    }
  }
}

function validateExemptionsInput(exemptions, policy, plannedAt) {
  requireObject(exemptions, "exemptions");
  if (!validateExemptions(exemptions)) {
    fail("SCHEMA_INVALID", `Exemptions are invalid: ${schemaMessage(validateExemptions)}`);
  }
  if (exemptions.$schema !== "./exemptions.schema.json") {
    fail("SCHEMA_INVALID", "Exemptions must declare ./exemptions.schema.json.");
  }
  if (exemptions.version !== policy.contractVersions.exemptions) {
    fail("MISSING_GATE", "Exemptions do not match the policy exemptions contract.");
  }
  const runTime = new Date(plannedAt).getTime();
  const maximumDuration = policy.exemptions.maximumDurationDays * DAY_MILLISECONDS;
  const seenIds = new Set();
  const activeRuleCodesByGalleryId = new Map();
  for (const exemption of exemptions.exemptions) {
    if (seenIds.has(exemption.id)) {
      fail("DUPLICATE_IDENTITY", `Exemptions contain duplicate ID ${exemption.id}.`);
    }
    seenIds.add(exemption.id);
    const startsAt = new Date(exemption.startsAt).getTime();
    const expiresAt = new Date(exemption.expiresAt).getTime();
    if (expiresAt <= startsAt || expiresAt - startsAt > maximumDuration) {
      fail("MISSING_GATE", `Exemption ${exemption.id} has an invalid active range.`);
    }
    if (exemption.ruleIds.some((ruleId) => NON_WAIVABLE_RULE_IDS.includes(ruleId))) {
      fail("MISSING_GATE", `Exemption ${exemption.id} attempts to waive a deterministic rule.`);
    }
    if (exemption.status === "active") {
      if (startsAt > runTime || expiresAt <= runTime) {
        fail("MISSING_GATE", `Active exemption ${exemption.id} is not in effect for this run.`);
      }
      const ruleCodes = activeRuleCodesByGalleryId.get(exemption.galleryId) ?? new Set();
      exemption.ruleIds.forEach((ruleCode) => ruleCodes.add(ruleCode));
      activeRuleCodesByGalleryId.set(exemption.galleryId, ruleCodes);
    } else if (exemption.status === "expired" && expiresAt > runTime) {
      fail("MISSING_GATE", `Expired exemption ${exemption.id} has not reached its expiration time.`);
    }
  }
  return {
    value: {
      ...clone(exemptions),
      exemptions: [...exemptions.exemptions].sort((left, right) => left.id.localeCompare(right.id)),
    },
    activeRuleCodesByGalleryId,
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

export function hashCanonicalValue(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function sortedRecords(records) {
  return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

function validateRecord(record, scope) {
  if (!validateV2Record(record)) {
    fail("SCHEMA_INVALID", `${scope} is not a valid catalog v2 record: ${schemaMessage(validateV2Record)}`);
  }
  let canonicalSource;
  try {
    canonicalSource = canonicalizeUrl(record.canonicalSource);
  } catch (error) {
    fail("SCHEMA_INVALID", `${scope} has an invalid canonical source.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (canonicalSource !== record.canonicalSource) {
    fail("SCHEMA_INVALID", `${scope}.canonicalSource must already be canonical.`);
  }
  requireHttpsUrl(record.launchUrl, `${scope}.launchUrl`);
  requireHttpsUrl(record.website, `${scope}.website`);
  return clone(record);
}

function retiredRecordArray(value, expectedVersion = SUPPORTED_CONTRACT_VERSIONS.retiredEntries) {
  if (!Array.isArray(value)) {
    if (!validateRetiredEntries(value)) {
      fail("SCHEMA_INVALID", `Retired entries are invalid: ${schemaMessage(validateRetiredEntries)}`);
    }
    if (value.version !== expectedVersion) {
      fail("MISSING_GATE", `Retired entries must use contract version ${expectedVersion}.`);
    }
  }
  const entries = Array.isArray(value) ? value : value.entries;
  requireArray(entries, "retiredRecords");
  return entries.map((entry) => entry?.record ?? entry);
}

function sourceSharingIsAllowed(canonicalSource, records) {
  const allowance = SOURCE_SHARING_POLICY.find((entry) => entry.canonicalSource === canonicalSource);
  if (!allowance || records.some((entry) => entry.scope !== "active")) return false;
  const actualMembers = records.map((entry) => entry.record.title).sort();
  const allowedMembers = [...allowance.members].sort();
  return actualMembers.length === allowedMembers.length &&
    actualMembers.every((member, index) => member === allowedMembers[index]);
}

function indexRecords(activeRecords, retiredRecords) {
  const byId = new Map();
  const byUrl = new Map();
  const add = (record, scope) => {
    const existingId = byId.get(record.id);
    if (existingId) {
      fail("DUPLICATE_IDENTITY", `Catalog ID ${record.id} appears in both ${existingId.scope} and ${scope}.`);
    }
    const indexed = { record, scope };
    byId.set(record.id, indexed);
    const sourceRecords = byUrl.get(record.canonicalSource) ?? [];
    sourceRecords.push(indexed);
    byUrl.set(record.canonicalSource, sourceRecords);
  };
  activeRecords.forEach((record) => add(record, "active"));
  retiredRecords.forEach((record) => add(record, "retired"));
  for (const [canonicalSource, records] of byUrl) {
    const hasAllowance = SOURCE_SHARING_POLICY.some((entry) => entry.canonicalSource === canonicalSource);
    if (records.length > 1 && !hasAllowance) {
      fail("DUPLICATE_CANONICAL_URL", `Canonical URL ${canonicalSource} is shared without an exact policy allowance.`);
    }
  }
  for (const allowance of SOURCE_SHARING_POLICY) {
    const records = byUrl.get(allowance.canonicalSource) ?? [];
    if (!sourceSharingIsAllowed(allowance.canonicalSource, records)) {
      fail(
        "SOURCE_SHARING_POLICY_STALE",
        `Source-sharing allowance ${allowance.id} does not match its complete active member set.`,
      );
    }
  }
  return { byId, byUrl };
}

function validateSupersededReferences(activeRecords, retiredRecords) {
  const records = [...activeRecords, ...retiredRecords];
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    if (record.supersededBy === undefined || record.supersededBy === null) continue;
    const replacement = byId.get(record.supersededBy);
    if (record.supersededBy === record.id || !replacement) {
      fail("UNKNOWN_ID", `Record ${record.id} references unknown superseding ID ${record.supersededBy}.`);
    }
    if (replacement.lifecycleStatus !== "active") {
      fail("CONFLICTING_OPERATIONS", `Record ${record.id} is superseded by non-active record ${replacement.id}.`);
    }
    const visited = new Set([record.id]);
    let current = record;
    while (current.supersededBy !== undefined && current.supersededBy !== null) {
      if (visited.has(current.supersededBy)) {
        fail("CONFLICTING_OPERATIONS", `Supersession graph contains a cycle at ${current.supersededBy}.`);
      }
      visited.add(current.supersededBy);
      current = byId.get(current.supersededBy);
      if (!current) break;
    }
  }
}

function validateCandidates(candidates) {
  const byIdentity = new Map();
  const byUrl = new Map();
  const byGalleryId = new Map();
  return requireArray(candidates, "candidates").map((candidate, index) => {
    let normalized;
    try {
      normalized = normalizeCandidate(candidate);
    } catch (error) {
      fail("SCHEMA_INVALID", `Candidate at index ${index} is invalid.`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isDeepStrictEqual(candidate, normalized)) {
      fail("SCHEMA_INVALID", `Candidate ${normalized.identityKey} is not an exact normalized candidate.`);
    }
    const galleryId = requireString(normalized.metadata?.galleryId, `Candidate ${normalized.identityKey} metadata.galleryId`);
    if (!RECORD_ID_PATTERN.test(galleryId)) {
      fail("SCHEMA_INVALID", `Candidate ${normalized.identityKey} has an invalid gallery ID.`);
    }
    const duplicates = [
      [byIdentity, normalized.identityKey, "DUPLICATE_IDENTITY", "identity"],
      [byUrl, normalized.canonicalUrl, "DUPLICATE_CANONICAL_URL", "canonical URL"],
      [byGalleryId, galleryId, "DUPLICATE_IDENTITY", "gallery ID"],
    ];
    for (const [indexMap, key, code, label] of duplicates) {
      if (indexMap.has(key)) {
        fail(code, `Incoming candidates contain a duplicate ${label}: ${key}.`);
      }
      indexMap.set(key, normalized.identityKey);
    }
    return { candidate: normalized, galleryId };
  }).sort((left, right) => left.candidate.identityKey.localeCompare(right.candidate.identityKey));
}

function validateAnalyses(analyses, candidatesByIdentity, knownCatalogIds, policy) {
  const byCandidateId = new Map();
  for (const value of requireArray(analyses, "analyses")) {
    const analysis = value?.analysis ?? value;
    if (!validateAnalysis(analysis)) {
      fail("SCHEMA_INVALID", `AI analysis is invalid: ${schemaMessage(validateAnalysis)}`);
    }
    if (analysis.version !== policy.contractVersions.analysis) {
      fail("MISSING_GATE", `AI analysis ${analysis.candidateId} does not match the policy analysis contract.`);
    }
    if (!candidatesByIdentity.has(analysis.candidateId)) {
      fail("UNKNOWN_ID", `AI analysis references unknown candidate ID ${analysis.candidateId}.`);
    }
    if (byCandidateId.has(analysis.candidateId)) {
      fail("DUPLICATE_IDENTITY", `Candidate ${analysis.candidateId} has multiple AI analyses.`);
    }
    const matchedEntryId = analysis.duplicate.matchedEntryId;
    if (analysis.duplicate.classification === "duplicate") {
      if (!matchedEntryId || !knownCatalogIds.has(matchedEntryId)) {
        fail("UNKNOWN_ID", `AI duplicate result references unknown catalog ID ${matchedEntryId ?? "null"}.`);
      }
    } else if (matchedEntryId !== null) {
      fail("CONFLICTING_OPERATIONS", `Non-duplicate analysis for ${analysis.candidateId} contains a matched entry ID.`);
    }
    if (analysis.duplicate.classification === "indeterminate") {
      fail("INDETERMINATE_GATE", `Duplicate analysis for ${analysis.candidateId} is indeterminate.`);
    }
    byCandidateId.set(analysis.candidateId, clone(analysis));
  }
  for (const candidateId of candidatesByIdentity.keys()) {
    if (!byCandidateId.has(candidateId)) {
      fail("MISSING_GATE", `Candidate ${candidateId} is missing its AI analysis.`);
    }
  }
  return byCandidateId;
}

function validateHealth(health, policy, expectedIds, plannedAt, maximumAgeMilliseconds) {
  requireObject(health, "health");
  if (!validateHealthSnapshot(health)) {
    fail("SCHEMA_INVALID", `Health snapshot is invalid: ${schemaMessage(validateHealthSnapshot)}`);
  }
  if (health.version !== policy.contractVersions?.health) {
    fail("MISSING_GATE", "Health snapshot version does not match policy.contractVersions.health.");
  }
  const byId = new Map();
  for (const entry of health.entries) {
    if (!expectedIds.has(entry.galleryId)) {
      fail("UNKNOWN_ID", `Health snapshot references unknown gallery ID ${entry.galleryId}.`);
    }
    if (byId.has(entry.galleryId)) {
      fail("DUPLICATE_IDENTITY", `Health snapshot contains duplicate gallery ID ${entry.galleryId}.`);
    }
    if (entry.status === "indeterminate" || entry.sourceState.availability === "indeterminate") {
      fail("INDETERMINATE_HEALTH", `Health result for ${entry.galleryId} is indeterminate.`);
    }
    validateHealthObservation(
      entry,
      `Health result ${entry.galleryId}`,
      plannedAt,
      plannedAt,
      maximumAgeMilliseconds,
    );
    byId.set(entry.galleryId, clone(entry));
  }
  for (const id of expectedIds) {
    if (!byId.has(id)) fail("MISSING_GATE", `Gallery ID ${id} is missing a health decision.`);
  }
  return byId;
}

function validateFreshness(freshness, expectedIds, policy, plannedAt, maximumAgeMilliseconds) {
  requireObject(freshness, "freshness");
  if (freshness.version !== FRESHNESS_VERSION) {
    fail("MISSING_GATE", `Freshness report version must be ${FRESHNESS_VERSION}.`);
  }
  if (freshness.mode !== "dry-run") {
    fail("MISSING_GATE", "Freshness input must be a dry-run report.");
  }
  const generatedAt = requireCurrentRunTimestamp(
    freshness.generatedAt,
    "freshness.generatedAt",
    plannedAt,
    maximumAgeMilliseconds,
  );
  requireObject(freshness.healthSnapshot, "freshness.healthSnapshot");
  if (!validateHealthSnapshot(freshness.healthSnapshot)) {
    fail("SCHEMA_INVALID", `Freshness health snapshot is invalid: ${schemaMessage(validateHealthSnapshot)}`);
  }
  if (freshness.healthSnapshot.version !== policy.contractVersions.health) {
    fail("MISSING_GATE", "Freshness health snapshot does not match the policy health contract.");
  }
  const byId = new Map();
  for (const entry of requireArray(freshness.entries, "freshness.entries")) {
    const galleryId = requireString(entry?.galleryId, "freshness.entries[].galleryId");
    if (!expectedIds.has(galleryId)) {
      fail("UNKNOWN_ID", `Freshness report references unknown gallery ID ${galleryId}.`);
    }
    if (byId.has(galleryId)) {
      fail("DUPLICATE_IDENTITY", `Freshness report contains duplicate gallery ID ${galleryId}.`);
    }
    requireString(entry.canonicalSource, `Freshness result ${galleryId} canonicalSource`);
    if (entry.mutation !== "none") {
      fail("MISSING_GATE", `Freshness result for ${galleryId} must remain non-mutating.`);
    }
    if (entry.applicability === "applicable") {
      if (!validateHealthEntry(entry.health)) {
        fail("SCHEMA_INVALID", `Freshness health for ${galleryId} is invalid: ${schemaMessage(validateHealthEntry)}`);
      }
      if (entry.health.status === "indeterminate" || entry.health.sourceState.availability === "indeterminate") {
        fail("INDETERMINATE_HEALTH", `Freshness result for ${galleryId} is indeterminate.`);
      }
      if (entry.health.galleryId !== galleryId || entry.health.canonicalSource !== entry.canonicalSource) {
        fail("CONFLICTING_OPERATIONS", `Freshness health identity does not match report entry ${galleryId}.`);
      }
      validateHealthObservation(
        entry.health,
        `Freshness result ${galleryId}.health`,
        generatedAt,
        plannedAt,
        maximumAgeMilliseconds,
      );
      const expectedRecommendation = FRESHNESS_RECOMMENDATION_BY_STATUS[entry.health.status];
      if (entry.recommendation !== expectedRecommendation) {
        fail(
          "CONFLICTING_OPERATIONS",
          `Freshness result for ${galleryId} pairs ${entry.health.status} with ${entry.recommendation}.`,
        );
      }
    } else if (
      entry.applicability !== "not-applicable" ||
      entry.health !== null ||
      entry.recommendation !== "no-action"
    ) {
      fail("SCHEMA_INVALID", `Freshness result for ${galleryId} has an invalid applicability decision.`);
    }
    if (!["keep", "keep-visible", "no-action", "quarantine", "retire"].includes(entry.recommendation)) {
      fail("SCHEMA_INVALID", `Freshness result for ${galleryId} has an invalid recommendation.`);
    }
    byId.set(galleryId, { ...clone(entry), reportGeneratedAt: generatedAt });
  }
  for (const id of expectedIds) {
    if (!byId.has(id)) fail("MISSING_GATE", `Gallery ID ${id} is missing a freshness decision.`);
  }
  const expectedHealthEntries = [...byId.values()]
    .flatMap((entry) => entry.health ? [entry.health] : [])
    .sort((left, right) => left.galleryId.localeCompare(right.galleryId));
  const snapshotEntries = [...freshness.healthSnapshot.entries]
    .sort((left, right) => left.galleryId.localeCompare(right.galleryId));
  if (!isDeepStrictEqual(snapshotEntries, expectedHealthEntries)) {
    fail("MISSING_GATE", "Freshness health snapshot does not match the report decisions.");
  }
  return byId;
}

function expectedSource(id, candidateByGalleryId, catalogById, analysesByCandidate) {
  const candidateInfo = candidateByGalleryId.get(id);
  const catalogEntry = catalogById.get(id);
  if (!candidateInfo) return catalogEntry?.record.canonicalSource;
  if (!catalogEntry) return candidateInfo.candidate.canonicalUrl;
  const recommendation = analysesByCandidate.get(candidateInfo.candidate.identityKey)?.recommendation;
  return ["publish", "update"].includes(recommendation)
    ? candidateInfo.candidate.canonicalUrl
    : catalogEntry.record.canonicalSource;
}

function validateDecisionSources(
  expectedIds,
  candidateByGalleryId,
  catalogById,
  analysesByCandidate,
  healthById,
  freshnessById,
) {
  for (const id of expectedIds) {
    const expected = expectedSource(id, candidateByGalleryId, catalogById, analysesByCandidate);
    const health = healthById.get(id);
    const freshness = freshnessById.get(id);
    for (const [gate, source] of [
      ["health", health.canonicalSource],
      ["freshness", freshness.canonicalSource],
    ]) {
      let canonicalSource;
      try {
        canonicalSource = canonicalizeUrl(source);
      } catch {
        fail("SCHEMA_INVALID", `${gate} result for ${id} has an invalid canonical source.`);
      }
      if (canonicalSource !== source || canonicalSource !== expected) {
        fail("CONFLICTING_OPERATIONS", `${gate} result for ${id} does not match its candidate or catalog source.`);
      }
    }
    if (health.canonicalSource !== freshness.canonicalSource) {
      fail("CONFLICTING_OPERATIONS", `Health and freshness sources do not match for ${id}.`);
    }
    if (
      ["quarantined", "retired"].includes(health.status) &&
      (
        freshness.applicability !== "applicable" ||
        freshness.health.status !== health.status ||
        freshness.recommendation !== FRESHNESS_RECOMMENDATION_BY_STATUS[health.status]
      )
    ) {
      fail("CONFLICTING_OPERATIONS", `Health and freshness lifecycle decisions do not match for ${id}.`);
    }
  }
}

function analysisEvidenceMatchesCandidate(analysis, candidate) {
  const evidenceLists = [
    analysis.relevance.evidence,
    ...analysis.grounding.claims.map((claim) => claim.evidence),
  ];
  if (
    analysis.relevance.evidence.length === 0 ||
    analysis.grounding.claims.length === 0 ||
    evidenceLists.some((evidence) => evidence.length === 0)
  ) {
    return false;
  }
  return evidenceLists.flat().every((evidence) => {
    try {
      return canonicalizeUrl(evidence.url) === candidate.canonicalUrl;
    } catch {
      return false;
    }
  });
}

function positivePublicationGates({ analysis, health, freshness, policy, candidate }) {
  const threshold = policy.thresholds ?? {};
  const failures = [];
  if (!analysis.relevance.material || analysis.relevance.score < threshold.materialRelevance) {
    failures.push("material relevance");
  }
  if (
    analysis.generatedSummary === null ||
    analysis.grounding.score < threshold.summaryGrounding ||
    analysis.grounding.claims.some((claim) => claim.entailed !== true)
  ) {
    failures.push("summary grounding");
  }
  if (!analysisEvidenceMatchesCandidate(analysis, candidate)) failures.push("candidate-bound evidence");
  if (!analysis.quality.passes) failures.push("quality");
  if (analysis.duplicate.classification === "indeterminate") failures.push("duplicate determination");
  if (health.status !== "healthy" || health.sourceState.availability !== "available") {
    failures.push("health");
  }
  const freshnessPassed = freshness.applicability === "not-applicable"
    ? freshness.recommendation === "no-action"
    : freshness.health.status === "healthy" && freshness.recommendation === "keep";
  if (!freshnessPassed) failures.push("freshness");
  if (failures.length > 0) {
    fail("GATE_REJECTED", `Candidate ${candidate.identityKey} did not pass: ${failures.join(", ")}.`, { failures });
  }
}

function catalogRecordFromCandidate(candidate, analysis, id, generatedAt, health, previous = null) {
  const metadata = candidate.metadata ?? {};
  const preview = requireString(metadata.preview, `Candidate ${candidate.identityKey} metadata.preview`);
  const launchUrl = requireHttpsUrl(metadata.launchUrl, `Candidate ${candidate.identityKey} metadata.launchUrl`);
  const website = requireHttpsUrl(metadata.website, `Candidate ${candidate.identityKey} metadata.website`);
  let canonicalLaunchUrl;
  try {
    canonicalLaunchUrl = canonicalizeUrl(launchUrl);
  } catch {
    fail("SCHEMA_INVALID", `Candidate ${candidate.identityKey} metadata.launchUrl is invalid.`);
  }
  if (
    health.status !== "healthy" ||
    health.sourceState.availability !== "available" ||
    canonicalLaunchUrl !== candidate.canonicalUrl ||
    health.canonicalSource !== candidate.canonicalUrl
  ) {
    fail("GATE_REJECTED", `Candidate ${candidate.identityKey} launch URL lacks a matching healthy source check.`);
  }
  const tags = requireArray(metadata.tags, `Candidate ${candidate.identityKey} metadata.tags`)
    .map((tag, index) => requireString(tag, `Candidate ${candidate.identityKey} metadata.tags[${index}]`));
  if (tags.length === 0 || new Set(tags).size !== tags.length) {
    fail("SCHEMA_INVALID", `Candidate ${candidate.identityKey} must have unique non-empty tags.`);
  }
  const sourceOwner = metadata.sourceOwner === null || metadata.sourceOwner === undefined
    ? null
    : requireString(metadata.sourceOwner, `Candidate ${candidate.identityKey} source owner`);
  const author = requireString(metadata.author ?? candidate.publisher, `Candidate ${candidate.identityKey} author`);
  const record = {
    id,
    title: candidate.title,
    summary: requireString(analysis.generatedSummary, `Analysis ${analysis.candidateId} generatedSummary`),
    preview,
    launchUrl,
    canonicalSource: candidate.canonicalUrl,
    sourceType: candidate.sourceType,
    author,
    sourceOwner,
    website,
    tags,
    publishedAt: normalizeTimestamp(candidate.publishedAt, `Candidate ${candidate.identityKey} publishedAt`),
    dateAdded: previous === null ? generatedAt.slice(0, 10) : previous.dateAdded,
    lastVerified: health.checkedAt,
    lifecycleStatus: "active",
  };
  const supersededBy = metadata.supersededBy !== undefined ? metadata.supersededBy : previous?.supersededBy;
  if (supersededBy !== undefined) record.supersededBy = supersededBy;
  return validateRecord(record, `Planned record ${id}`);
}

function reasonCodes(type, ...sources) {
  const values = [`${type.toUpperCase()}_PLANNED`];
  for (const source of sources) {
    for (const value of source ?? []) {
      if (REASON_CODE_PATTERN.test(value)) values.push(value);
    }
  }
  return [...new Set(values)].sort();
}

function evidenceReferences({ id, candidate, analysis, health, freshness, policy, catalogScope }) {
  const references = [];
  if (catalogScope) references.push({ kind: `${catalogScope}-record`, id });
  if (candidate) references.push({ kind: "candidate", id: candidate.identityKey, source: candidate.canonicalUrl });
  if (analysis) references.push({ kind: "analysis", id: analysis.candidateId });
  references.push({ kind: "health", id, observedAt: health.checkedAt, source: health.canonicalSource });
  references.push({
    kind: "freshness",
    id,
    observedAt: freshness.reportGeneratedAt,
    source: freshness.canonicalSource,
  });
  references.push({ kind: "policy", id: policy.version });
  return references;
}

function makeOperation({ type, targetId, runId, plannedAt, before, after, reasons, references }) {
  const transition = { type, targetId, before, after };
  return {
    operationId: `${runId}:${type}:${targetId}:${hashCanonicalValue(transition).slice(0, 24)}`,
    type,
    targetId,
    runId,
    plannedAt,
    before: before === null ? null : clone(before),
    after: clone(after),
    reasonCodes: reasons,
    evidenceReferences: references,
  };
}

function lifecycleDecision(id, health, freshness) {
  const decisions = new Set();
  if (health.status === "quarantined") decisions.add("quarantine");
  if (health.status === "retired") decisions.add("retire");
  if (freshness.recommendation === "quarantine" || freshness.health?.status === "quarantined") {
    decisions.add("quarantine");
  }
  if (freshness.recommendation === "retire" || freshness.health?.status === "retired") {
    decisions.add("retire");
  }
  if (decisions.size > 1) {
    fail("CONFLICTING_OPERATIONS", `Health and freshness propose conflicting lifecycle operations for ${id}.`);
  }
  return [...decisions][0] ?? null;
}

function resolveCandidateTarget(candidateInfo, analysis, catalogIndex) {
  const matches = new Set();
  const idMatch = catalogIndex.byId.get(candidateInfo.galleryId);
  const urlMatches = catalogIndex.byUrl.get(candidateInfo.candidate.canonicalUrl) ?? [];
  if (idMatch) matches.add(idMatch.record.id);
  if (urlMatches.length === 1) {
    matches.add(urlMatches[0].record.id);
  } else if (urlMatches.length > 1) {
    const selected = urlMatches.find((entry) => (
      entry.record.id === candidateInfo.galleryId || entry.record.id === analysis.duplicate.matchedEntryId
    ));
    if (!selected) {
      fail(
        "DUPLICATE_CANONICAL_URL",
        `Candidate ${candidateInfo.candidate.identityKey} ambiguously matches a shared canonical URL.`,
      );
    }
    matches.add(selected.record.id);
  }
  if (analysis.duplicate.matchedEntryId) matches.add(analysis.duplicate.matchedEntryId);
  if (matches.size > 1) {
    fail(
      "CONFLICTING_OPERATIONS",
      `Candidate ${candidateInfo.candidate.identityKey} resolves to multiple catalog IDs: ${[...matches].join(", ")}.`,
    );
  }
  const targetId = [...matches][0] ?? null;
  if (targetId && targetId !== candidateInfo.galleryId) {
    fail(
      "CONFLICTING_OPERATIONS",
      `Candidate ${candidateInfo.candidate.identityKey} gallery ID does not match catalog target ${targetId}.`,
    );
  }
  if (analysis.duplicate.classification === "duplicate" && !targetId) {
    fail("UNKNOWN_ID", `Duplicate candidate ${candidateInfo.candidate.identityKey} has no known catalog target.`);
  }
  return targetId ? catalogIndex.byId.get(targetId) : null;
}

function validatePolicyForOperations(policy, operations) {
  requireObject(policy, "policy");
  requireString(policy.version, "policy.version");
  if (policy.automation?.mutationMode !== "dry-run") {
    fail("MUTATION_MODE_INVALID", "Catalog planning requires policy automation.mutationMode to be dry-run.");
  }
  if (operations.length > 0 && policy.automation.emergencyDisable !== false) {
    fail("POLICY_EMERGENCY_DISABLED", "Catalog mutation planning is disabled by policy automation.emergencyDisable.");
  }
  for (const operation of operations) {
    const flag = MUTATION_FLAGS[operation.type];
    if (policy.automation?.mutation?.[flag] !== true) {
      fail("MUTATION_DISABLED", `Policy mutation flag ${flag} is not enabled for ${operation.type}.`, {
        operation: operation.type,
        flag,
      });
    }
    for (const aiFlag of AI_FLAGS[operation.type]) {
      if (policy.automation.ai[aiFlag] !== true) {
        fail("AI_GATE_DISABLED", `Policy AI flag ${aiFlag} is not enabled for ${operation.type}.`, {
          operation: operation.type,
          flag: aiFlag,
        });
      }
    }
  }
  const maximum = policy.batching?.maxEntriesPerPullRequest;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    fail("MISSING_GATE", "Policy maxEntriesPerPullRequest must be a positive integer.");
  }
  if (operations.length > maximum) {
    fail("BATCH_LIMIT_EXCEEDED", `Plan contains ${operations.length} operations; policy permits ${maximum}.`);
  }
}

function planSummary(operations) {
  const summary = { publish: 0, update: 0, quarantine: 0, retire: 0, restore: 0, total: operations.length };
  for (const operation of operations) summary[operation.type] += 1;
  return summary;
}

export function compareCatalogOperations(left, right) {
  return (
    OPERATION_ORDER.get(left.type) - OPERATION_ORDER.get(right.type) ||
    left.targetId.localeCompare(right.targetId)
  );
}

export function validateCatalogChangePlan(plan) {
  if (!validatePlan(plan)) {
    fail("PLAN_SCHEMA_INVALID", `Catalog change plan is invalid: ${schemaMessage(validatePlan)}`);
  }
  const operationIds = new Set();
  const targetIds = new Set();
  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];
    validateCatalogChangeOperation(operation);
    if (index > 0 && compareCatalogOperations(plan.operations[index - 1], operation) > 0) {
      fail("PLAN_SCHEMA_INVALID", "Plan operations are not in canonical type and target order.");
    }
    if (operationIds.has(operation.operationId)) {
      fail("CONFLICTING_OPERATIONS", `Plan contains duplicate operation ID ${operation.operationId}.`);
    }
    if (targetIds.has(operation.targetId)) {
      fail("CONFLICTING_OPERATIONS", `Plan contains multiple operations for ${operation.targetId}.`);
    }
    if (operation.runId !== plan.runId || operation.plannedAt !== plan.generatedAt) {
      fail("PLAN_SCHEMA_INVALID", `Operation ${operation.operationId} does not match its plan run metadata.`);
    }
    operationIds.add(operation.operationId);
    targetIds.add(operation.targetId);
  }
  if (!isDeepStrictEqual(plan.summary, planSummary(plan.operations))) {
    fail("PLAN_SCHEMA_INVALID", "Plan summary does not match its operations.");
  }
  return plan;
}

function stateRecords({ activeRecords, retiredRecords }) {
  const active = requireArray(activeRecords, "activeRecords").map((record, index) => (
    validateRecord(record, `activeRecords[${index}]`)
  ));
  const retired = retiredRecordArray(retiredRecords).map((record, index) => (
    validateRecord(record, `retiredRecords[${index}]`)
  ));
  indexRecords(active, retired);
  validateSupersededReferences(active, retired);
  return { active, retired };
}

function expectedAfterLocation(type) {
  return type === "retire" ? "retired" : "active";
}

function expectedBeforeLocation(operation) {
  return operation.type === "restore" && operation.before?.lifecycleStatus === "retired"
    ? "retired"
    : "active";
}

function validateTransition(operation) {
  validateRecord(operation.after, `Operation ${operation.operationId} after`);
  if (operation.before !== null) validateRecord(operation.before, `Operation ${operation.operationId} before`);
  if (operation.after.id !== operation.targetId || (operation.before && operation.before.id !== operation.targetId)) {
    fail("NON_IDEMPOTENT_REPLAY", `Operation ${operation.operationId} changes its target ID.`);
  }
  const expectedStatus = {
    publish: "active",
    update: "active",
    quarantine: "quarantined",
    retire: "retired",
    restore: "active",
  }[operation.type];
  if (operation.after.lifecycleStatus !== expectedStatus) {
    fail("NON_IDEMPOTENT_REPLAY", `Operation ${operation.operationId} has an invalid after lifecycle status.`);
  }
  if (operation.type === "publish" && operation.before !== null) {
    fail("NON_IDEMPOTENT_REPLAY", `Publish operation ${operation.operationId} must have a null before value.`);
  }
  if (operation.type !== "publish" && operation.before === null) {
    fail("NON_IDEMPOTENT_REPLAY", `Operation ${operation.operationId} is missing its before value.`);
  }
  if (operation.before !== null && isDeepStrictEqual(operation.before, operation.after)) {
    fail("NON_IDEMPOTENT_REPLAY", `Operation ${operation.operationId} has no state delta.`);
  }
  const allowedBeforeStatuses = {
    publish: new Set(),
    update: new Set(["active", "needs-review"]),
    quarantine: new Set(["active", "needs-review"]),
    retire: new Set(["active", "needs-review", "quarantined"]),
    restore: new Set(["quarantined", "retired"]),
  }[operation.type];
  if (operation.before !== null && !allowedBeforeStatuses?.has(operation.before.lifecycleStatus)) {
    fail(
      "NON_IDEMPOTENT_REPLAY",
      `Operation ${operation.operationId} cannot transition from ${operation.before.lifecycleStatus}.`,
    );
  }
  const requiredReason = `${operation.type.toUpperCase()}_PLANNED`;
  if (!operation.reasonCodes.includes(requiredReason)) {
    fail("NON_IDEMPOTENT_REPLAY", `Operation ${operation.operationId} is missing reason ${requiredReason}.`);
  }
  if (["quarantine", "retire"].includes(operation.type)) {
    const beforeWithoutLifecycle = { ...operation.before };
    const afterWithoutLifecycle = { ...operation.after };
    delete beforeWithoutLifecycle.lifecycleStatus;
    delete afterWithoutLifecycle.lifecycleStatus;
    if (!isDeepStrictEqual(beforeWithoutLifecycle, afterWithoutLifecycle)) {
      fail(
        "NON_IDEMPOTENT_REPLAY",
        `Operation ${operation.operationId} changes fields outside lifecycleStatus.`,
      );
    }
  }
}

function assertRetirementEligible(id, decisionHealth, decisionFreshness, policy, plannedAt) {
  const retirementEntries = [decisionHealth, decisionFreshness.health]
    .filter((entry) => entry?.status === "retired");
  if (retirementEntries.length === 0) {
    fail("MISSING_GATE", `Retirement for ${id} lacks a retired health/freshness decision.`);
  }
  for (const entry of retirementEntries) {
    if (entry.consecutiveFindings < policy.lifecycle.requiredConfirmations) {
      fail("MISSING_GATE", `Retirement for ${id} lacks the required confirmations.`);
    }
    if (entry.gracePeriodStartedAt === null) {
      fail("MISSING_GATE", `Retirement for ${id} lacks a grace-period timestamp.`);
    }
    const graceStartedAt = new Date(entry.gracePeriodStartedAt);
    const decisionAt = new Date(plannedAt);
    if (
      Number.isNaN(graceStartedAt.valueOf()) ||
      decisionAt.getTime() - graceStartedAt.getTime() < policy.lifecycle.retirementGraceDays * DAY_MILLISECONDS
    ) {
      fail("MISSING_GATE", `Retirement grace period has not elapsed for ${id}.`);
    }
  }
}

export function validateCatalogChangeOperation(operation) {
  validateTransition(operation);
  const transition = {
    type: operation.type,
    targetId: operation.targetId,
    before: operation.before,
    after: operation.after,
  };
  const expectedOperationId = `${operation.runId}:${operation.type}:${operation.targetId}:${hashCanonicalValue(transition).slice(0, 24)}`;
  if (operation.operationId !== expectedOperationId) {
    fail("NON_IDEMPOTENT_REPLAY", `Operation ${operation.operationId} does not match its transition content.`);
  }
  return operation;
}

export function replayCatalogChangePlan(plan, state) {
  validateCatalogChangePlan(plan);
  const records = stateRecords(state);
  const active = new Map(records.active.map((record) => [record.id, clone(record)]));
  const retired = new Map(records.retired.map((record) => [record.id, clone(record)]));
  for (const operation of plan.operations) {
    validateTransition(operation);
    const afterLocation = expectedAfterLocation(operation.type);
    const afterMap = afterLocation === "active" ? active : retired;
    const otherAfterMap = afterLocation === "active" ? retired : active;
    if (isDeepStrictEqual(afterMap.get(operation.targetId), operation.after) && !otherAfterMap.has(operation.targetId)) {
      continue;
    }
    if (operation.type === "publish") {
      if (active.has(operation.targetId) || retired.has(operation.targetId)) {
        fail("NON_IDEMPOTENT_REPLAY", `Publish target ${operation.targetId} already exists with different state.`);
      }
    } else {
      const beforeLocation = expectedBeforeLocation(operation);
      const beforeMap = beforeLocation === "active" ? active : retired;
      const otherBeforeMap = beforeLocation === "active" ? retired : active;
      if (!isDeepStrictEqual(beforeMap.get(operation.targetId), operation.before) || otherBeforeMap.has(operation.targetId)) {
        fail("NON_IDEMPOTENT_REPLAY", `Before state for ${operation.targetId} does not match the plan.`);
      }
    }
    active.delete(operation.targetId);
    retired.delete(operation.targetId);
    afterMap.set(operation.targetId, clone(operation.after));
  }
  const replayed = {
    activeRecords: sortedRecords([...active.values()]),
    retiredRecords: sortedRecords([...retired.values()]),
  };
  indexRecords(replayed.activeRecords, replayed.retiredRecords);
  validateSupersededReferences(replayed.activeRecords, replayed.retiredRecords);
  return replayed;
}

export function buildCatalogChangePlan({
  runId,
  generatedAt,
  candidates,
  analyses,
  health,
  freshness,
  activeRecords,
  retiredRecords,
  policy,
  exemptions,
}) {
  const normalizedRunId = requireString(runId, "runId");
  const plannedAt = normalizeTimestamp(generatedAt, "generatedAt");
  validatePolicyInput(policy);
  const exemptionState = validateExemptionsInput(exemptions, policy, plannedAt);
  const maximumEvidenceAge = decisionEvidenceWindowMilliseconds(policy);
  const active = requireArray(activeRecords, "activeRecords").map((record, index) => {
    const validated = validateRecord(record, `activeRecords[${index}]`);
    if (validated.lifecycleStatus === "retired") {
      fail("SCHEMA_INVALID", `Active record ${validated.id} cannot have retired lifecycle status.`);
    }
    return validated;
  });
  const retired = retiredRecordArray(retiredRecords, policy.contractVersions.retiredEntries).map((record, index) => {
    const validated = validateRecord(record, `retiredRecords[${index}]`);
    if (validated.lifecycleStatus !== "retired") {
      fail("SCHEMA_INVALID", `Retired record ${validated.id} must have retired lifecycle status.`);
    }
    return validated;
  });
  const catalogIndex = indexRecords(active, retired);
  validateSupersededReferences(active, retired);
  const candidateInfos = validateCandidates(candidates);
  const candidatesByIdentity = new Map(
    candidateInfos.map((info) => [info.candidate.identityKey, info]),
  );
  const candidateByGalleryId = new Map(candidateInfos.map((info) => [info.galleryId, info]));
  const analysesByCandidate = validateAnalyses(
    analyses,
    candidatesByIdentity,
    new Set(catalogIndex.byId.keys()),
    policy,
  );
  const expectedIds = new Set([...catalogIndex.byId.keys(), ...candidateByGalleryId.keys()]);
  const healthById = validateHealth(health, policy, expectedIds, plannedAt, maximumEvidenceAge);
  const freshnessById = validateFreshness(freshness, expectedIds, policy, plannedAt, maximumEvidenceAge);
  validateDecisionSources(
    expectedIds,
    candidateByGalleryId,
    catalogIndex.byId,
    analysesByCandidate,
    healthById,
    freshnessById,
  );

  const operationsByTarget = new Map();
  const aiLifecycleIntents = new Map();
  const addOperation = (operation) => {
    if (operationsByTarget.has(operation.targetId)) {
      fail("CONFLICTING_OPERATIONS", `Multiple operations were proposed for ${operation.targetId}.`);
    }
    operationsByTarget.set(operation.targetId, operation);
  };

  for (const candidateInfo of candidateInfos) {
    const { candidate, galleryId } = candidateInfo;
    const analysis = analysesByCandidate.get(candidate.identityKey);
    const target = resolveCandidateTarget(candidateInfo, analysis, catalogIndex);
    const decisionHealth = healthById.get(galleryId);
    const decisionFreshness = freshnessById.get(galleryId);
    const recommendation = analysis.recommendation;
    if (["reject", "keep"].includes(recommendation)) continue;
    if (["quarantine", "retire"].includes(recommendation)) {
      if (!target || target.scope !== "active") {
        fail("UNKNOWN_ID", `AI lifecycle recommendation for ${candidate.identityKey} has no active catalog target.`);
      }
      aiLifecycleIntents.set(galleryId, recommendation);
      continue;
    }
    if (!["publish", "update"].includes(recommendation)) {
      fail("CONFLICTING_OPERATIONS", `Unsupported AI recommendation ${recommendation} for ${candidate.identityKey}.`);
    }
    positivePublicationGates({
      analysis,
      health: decisionHealth,
      freshness: decisionFreshness,
      policy,
      candidate,
    });
    const common = (type) => ({
      targetId: galleryId,
      runId: normalizedRunId,
      plannedAt,
      reasons: reasonCodes(type, analysis.reasonCodes, decisionHealth.healthReasons),
      references: evidenceReferences({
        id: galleryId,
        candidate,
        analysis,
        health: decisionHealth,
        freshness: decisionFreshness,
        policy,
        catalogScope: target?.scope,
      }),
    });
    if (!target) {
      if (recommendation !== "publish" || analysis.duplicate.classification !== "unique") {
        fail("UNKNOWN_ID", `Candidate ${candidate.identityKey} cannot update an unknown catalog record.`);
      }
      addOperation(makeOperation({
        ...common("publish"),
        type: "publish",
        before: null,
        after: catalogRecordFromCandidate(candidate, analysis, galleryId, plannedAt, decisionHealth),
      }));
      continue;
    }
    const before = target.record;
    if (target.scope === "active" && before.lifecycleStatus !== "quarantined") {
      if (recommendation !== "update") {
        fail("DUPLICATE_CANONICAL_URL", `Publish candidate ${candidate.identityKey} already exists as ${before.id}.`);
      }
      const after = catalogRecordFromCandidate(candidate, analysis, galleryId, plannedAt, decisionHealth, before);
      if (!isDeepStrictEqual(before, after)) {
        addOperation(makeOperation({ ...common("update"), type: "update", before, after }));
      }
      continue;
    }
    if (recommendation !== "update") {
      fail("DUPLICATE_CANONICAL_URL", `Publish candidate ${candidate.identityKey} already exists as ${before.id}.`);
    }
    const after = catalogRecordFromCandidate(candidate, analysis, galleryId, plannedAt, decisionHealth, before);
    addOperation(makeOperation({ ...common("restore"), type: "restore", before, after }));
  }

  for (const record of sortedRecords(active)) {
    const decisionHealth = healthById.get(record.id);
    const decisionFreshness = freshnessById.get(record.id);
    const decision = lifecycleDecision(record.id, decisionHealth, decisionFreshness);
    const aiIntent = aiLifecycleIntents.get(record.id);
    if (aiIntent && aiIntent !== decision) {
      fail("CONFLICTING_OPERATIONS", `AI and lifecycle gates disagree for ${record.id}.`);
    }
    if (aiIntent && !decision) {
      fail("MISSING_GATE", `AI lifecycle recommendation for ${record.id} lacks health/freshness confirmation.`);
    }
    if (!decision || (decision === "quarantine" && record.lifecycleStatus === "quarantined")) continue;
    if (exemptionState.activeRuleCodesByGalleryId.get(record.id)?.has(`lifecycle.${decision}`)) continue;
    if (operationsByTarget.has(record.id)) {
      fail("CONFLICTING_OPERATIONS", `Candidate and lifecycle gates propose different operations for ${record.id}.`);
    }
    if (decision === "retire") {
      assertRetirementEligible(record.id, decisionHealth, decisionFreshness, policy, plannedAt);
    }
    const after = validateRecord({
      ...record,
      lifecycleStatus: decision === "retire" ? "retired" : "quarantined",
    }, `Planned record ${record.id}`);
    addOperation(makeOperation({
      type: decision,
      targetId: record.id,
      runId: normalizedRunId,
      plannedAt,
      before: record,
      after,
      reasons: reasonCodes(decision, decisionHealth.healthReasons, decisionFreshness.health?.healthReasons),
      references: evidenceReferences({
        id: record.id,
        health: decisionHealth,
        freshness: decisionFreshness,
        policy,
        catalogScope: "active",
      }),
    }));
  }

  for (const record of retired) {
    const decision = lifecycleDecision(record.id, healthById.get(record.id), freshnessById.get(record.id));
    if (decision === "quarantine") {
      fail("CONFLICTING_OPERATIONS", `Retired record ${record.id} cannot transition back to quarantine.`);
    }
  }

  const operations = [...operationsByTarget.values()].sort(compareCatalogOperations);
  validatePolicyForOperations(policy, operations);
  const fingerprintInput = {
    candidates: candidateInfos.map((info) => info.candidate),
    analyses: [...analysesByCandidate.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    health: { ...health, entries: [...health.entries].sort((left, right) => left.galleryId.localeCompare(right.galleryId)) },
    freshness: {
      ...freshness,
      entries: [...freshness.entries].sort((left, right) => left.galleryId.localeCompare(right.galleryId)),
      healthSnapshot: {
        ...freshness.healthSnapshot,
        entries: [...freshness.healthSnapshot.entries]
          .sort((left, right) => left.galleryId.localeCompare(right.galleryId)),
      },
    },
    activeRecords: sortedRecords(active),
    retiredRecords: sortedRecords(retired),
    policy,
    exemptions: exemptionState.value,
  };
  const plan = validateCatalogChangePlan({
    version: PLAN_VERSION,
    mode: "plan-only",
    runId: normalizedRunId,
    generatedAt: plannedAt,
    inputFingerprint: hashCanonicalValue(fingerprintInput),
    summary: planSummary(operations),
    operations,
  });
  const initialState = { activeRecords: active, retiredRecords: retired };
  const firstReplay = replayCatalogChangePlan(plan, initialState);
  const secondReplay = replayCatalogChangePlan(plan, firstReplay);
  if (!isDeepStrictEqual(firstReplay, secondReplay)) {
    fail("NON_IDEMPOTENT_REPLAY", "Catalog change plan did not produce an idempotent replay.");
  }
  return plan;
}