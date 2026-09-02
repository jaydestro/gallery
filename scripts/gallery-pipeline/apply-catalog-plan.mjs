import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  replayCatalogChangePlan,
  validateCatalogChangePlanPolicy,
} from "./build-catalog-change.mjs";
import {
  appendAuditPlan,
  emptyAuditLog,
  verifyAuditLog,
} from "./write-audit.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const pipelineDirectory = path.resolve(moduleDirectory, "..", "..", ".github", "gallery-pipeline");
const [catalogSchema, healthSchema, retiredEntriesSchema] = await Promise.all(
  ["catalog.schema.json", "health.schema.json", "retired-entries.schema.json"].map(
    async (fileName) => JSON.parse(await readFile(path.join(pipelineDirectory, fileName), "utf8")),
  ),
);
const schemaAjv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(schemaAjv);
schemaAjv.addSchema(catalogSchema);
const validateHealthSnapshot = schemaAjv.compile(healthSchema);
const validateRetiredEntries = schemaAjv.compile(retiredEntriesSchema);
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export class CatalogPlanApplyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CatalogPlanApplyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CatalogPlanApplyError(code, message, details);
}

function clone(value) {
  return structuredClone(value);
}

function schemaMessage(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("POLICY_INVALID", `${name} must be a positive integer.`);
  }
  return value;
}

function validateReplayPolicy(policy, plan, trustedRepository) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("POLICY_INVALID", "policy must be an object.");
  }
  requirePositiveInteger(policy.audit?.retentionDays, "policy.audit.retentionDays");
  try {
    validateCatalogChangePlanPolicy(plan, policy, { trustedRepository });
  } catch (error) {
    fail(error?.code ?? "POLICY_INVALID", error instanceof Error ? error.message : String(error), {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return { retentionDays: policy.audit.retentionDays };
}

export function retentionUntilFor(retiredAt, retentionDays) {
  const retiredTime = new Date(retiredAt).getTime();
  requirePositiveInteger(retentionDays, "retentionDays");
  if (!Number.isFinite(retiredTime)) {
    fail("RETIREMENT_INVALID", "retiredAt must be a valid date-time.");
  }
  const retainedTime = retiredTime + retentionDays * DAY_MILLISECONDS;
  const retentionUntil = new Date(retainedTime);
  if (Number.isNaN(retentionUntil.valueOf())) {
    fail("RETIREMENT_INVALID", "retentionUntil is outside the supported date range.");
  }
  return retentionUntil.toISOString().slice(0, 10);
}

function validateHealthEnvelope(health) {
  if (!validateHealthSnapshot(health)) {
    fail("HEALTH_SCHEMA_INVALID", `Health snapshot is invalid: ${schemaMessage(validateHealthSnapshot)}`);
  }
  const ids = new Set();
  for (const entry of health.entries) {
    if (ids.has(entry.galleryId)) {
      fail("HEALTH_IDENTITY_INVALID", `Health snapshot contains duplicate gallery ID ${entry.galleryId}.`);
    }
    ids.add(entry.galleryId);
  }
  return health;
}

function replayHealth(plan, health) {
  validateHealthEnvelope(health);
  const entries = clone(health.entries);
  const indexById = new Map(entries.map((entry, index) => [entry.galleryId, index]));
  for (const operation of plan.operations) {
    const replacement = clone(operation.healthAfter);
    const index = indexById.get(operation.targetId);
    if (index === undefined) {
      indexById.set(operation.targetId, entries.length);
      entries.push(replacement);
    } else {
      entries[index] = replacement;
    }
  }
  const replayed = { ...clone(health), entries };
  validateHealthEnvelope(replayed);
  return replayed;
}

function retirementEvidence(operation) {
  return operation.evidenceReferences
    .filter((reference) => (
      ["health", "freshness"].includes(reference.kind) &&
      reference.observedAt !== undefined &&
      reference.source !== undefined
    ))
    .map((reference) => ({
      observedAt: reference.observedAt,
      source: reference.source,
      reason: reference.kind,
    }));
}

function retiredEntryFor(operation, retentionDays) {
  return {
    record: clone(operation.after),
    retiredAt: operation.plannedAt,
    retentionUntil: retentionUntilFor(operation.plannedAt, retentionDays),
    reasonCodes: clone(operation.reasonCodes),
    evidence: retirementEvidence(operation),
    supersededBy: operation.after.supersededBy ?? null,
    decisionRunUrl: operation.decisionRunUrl,
    decisionPullRequestUrl: operation.decisionPullRequestUrl,
  };
}

function replayRetiredEntries(plan, retired, retentionDays) {
  if (!validateRetiredEntries(retired)) {
    fail(
      "RETIRED_SCHEMA_INVALID",
      `Retired entries are invalid: ${schemaMessage(validateRetiredEntries)}`,
    );
  }
  const entries = clone(retired.entries);
  for (const operation of plan.operations) {
    const index = entries.findIndex((entry) => entry.record.id === operation.targetId);
    if (operation.type === "retire") {
      const expected = retiredEntryFor(operation, retentionDays);
      if (index === -1) {
        entries.push(expected);
      } else if (!isDeepStrictEqual(entries[index], expected)) {
        fail("NON_IDEMPOTENT_REPLAY", `Retired entry ${operation.targetId} conflicts with the plan.`);
      }
    } else if (operation.type === "restore" && operation.before.lifecycleStatus === "retired" && index !== -1) {
      if (!isDeepStrictEqual(entries[index].record, operation.before)) {
        fail("NON_IDEMPOTENT_REPLAY", `Retired entry ${operation.targetId} does not match the restore before state.`);
      }
      entries.splice(index, 1);
    }
  }
  const replayed = { ...clone(retired), entries };
  if (!validateRetiredEntries(replayed)) {
    fail(
      "RETIRED_SCHEMA_INVALID",
      `Replayed retired entries are invalid: ${schemaMessage(validateRetiredEntries)}`,
    );
  }
  return replayed;
}

function operationsWithCatalogAfterState(plan, activeCatalog, retired) {
  const activeById = new Map(activeCatalog.map((record) => [record.id, record]));
  const retiredById = new Map(retired.entries.map((entry) => [entry.record.id, entry.record]));
  return plan.operations.filter((operation) => {
    const expected = operation.type === "retire" ? retiredById : activeById;
    const other = operation.type === "retire" ? activeById : retiredById;
    return isDeepStrictEqual(expected.get(operation.targetId), operation.after) &&
      !other.has(operation.targetId);
  });
}

export function applyCatalogPlan({
  plan,
  activeCatalog,
  health,
  retired,
  audit = emptyAuditLog(),
  policy,
  trustedRepository,
} = {}) {
  const { retentionDays } = validateReplayPolicy(policy, plan, trustedRepository);
  validateHealthEnvelope(health);
  const replayedAudit = appendAuditPlan(audit, plan, { trustedRepository });
  const sameRunAlreadyAudited = replayedAudit.entries.length === audit.entries.length;

  const replayedRecords = replayCatalogChangePlan(plan, {
    activeRecords: activeCatalog,
    retiredRecords: retired,
  }, { trustedRepository });
  const replayedRetired = replayRetiredEntries(plan, retired, retentionDays);
  if (!isDeepStrictEqual(
    replayedRetired.entries.map((entry) => entry.record),
    replayedRecords.retiredRecords,
  )) {
    fail("RETIRED_STATE_MISMATCH", "Retired envelope records do not match catalog replay state.");
  }
  const replayedHealth = replayHealth(plan, health);
  const alreadyAppliedOperations = operationsWithCatalogAfterState(plan, activeCatalog, retired);
  if (!sameRunAlreadyAudited && alreadyAppliedOperations.length > 0) {
    fail(
      "AUDIT_ONLY_DUPLICATION",
      `Run ${plan.runId} is not audited, but operation ${alreadyAppliedOperations[0].operationId} is already present in the base state.`,
    );
  }

  const replayed = {
    activeCatalog: replayedRecords.activeRecords,
    health: replayedHealth,
    retired: replayedRetired,
    audit: replayedAudit,
  };
  if (sameRunAlreadyAudited && !isDeepStrictEqual(replayed, {
    activeCatalog,
    health,
    retired,
    audit,
  })) {
    fail(
      "AUDITED_STATE_MISMATCH",
      `Audited run ${plan.runId} is not fully present in the supplied state.`,
    );
  }
  verifyAuditLog(replayed.audit, { trustedRepository });
  return replayed;
}