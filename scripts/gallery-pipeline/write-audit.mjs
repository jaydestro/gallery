import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  CATALOG_CHANGE_PLAN_SCHEMA,
  compareCatalogOperations,
  hashCanonicalValue,
  validateCatalogChangeOperation,
  validateCatalogChangePlan,
} from "./build-catalog-change.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const catalogSchema = JSON.parse(await readFile(
  path.resolve(moduleDirectory, "..", "..", ".github", "gallery-pipeline", "catalog.schema.json"),
  "utf8",
));
const AUDIT_VERSION = "1.0.0";

export class AuditWriteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AuditWriteError";
    this.code = code;
    this.details = details;
  }
}

export const AUDIT_LOG_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:gallery-pipeline:schema:audit-log:1.0.0",
  title: "Gallery catalog mutation audit log",
  type: "object",
  additionalProperties: false,
  required: ["version", "entries"],
  properties: {
    version: { const: AUDIT_VERSION },
    entries: {
      type: "array",
      items: { $ref: "#/$defs/auditEntry" },
    },
  },
  $defs: {
    hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    auditEntry: {
      type: "object",
      additionalProperties: false,
      required: [
        "sequence",
        "auditId",
        "runId",
        "recordedAt",
        "planFingerprint",
        "previousHash",
        "entryHash",
        "operations",
      ],
      properties: {
        sequence: { type: "integer", minimum: 1 },
        auditId: { type: "string", minLength: 1 },
        runId: { type: "string", minLength: 1 },
        recordedAt: { type: "string", format: "date-time" },
        planFingerprint: { $ref: "#/$defs/hash" },
        previousHash: {
          oneOf: [
            { type: "null" },
            { $ref: "#/$defs/hash" },
          ],
        },
        entryHash: { $ref: "#/$defs/hash" },
        operations: {
          type: "array",
          items: { $ref: "urn:gallery-pipeline:schema:catalog-change-plan:1.0.0#/$defs/operation" },
        },
      },
    },
  },
});

const schemaAjv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(schemaAjv);
schemaAjv.addSchema(catalogSchema);
schemaAjv.addSchema(CATALOG_CHANGE_PLAN_SCHEMA);
const validateAuditSchema = schemaAjv.compile(AUDIT_LOG_SCHEMA);

function fail(code, message, details = {}) {
  throw new AuditWriteError(code, message, details);
}

function schemaMessage(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

function clone(value) {
  return structuredClone(value);
}

function entryWithoutHash(entry) {
  const { entryHash, ...payload } = entry;
  return payload;
}

function entryHash(entry) {
  return hashCanonicalValue(entryWithoutHash(entry));
}

function auditEntry(plan, sequence, previousHash) {
  const planFingerprint = hashCanonicalValue(plan);
  const entry = {
    sequence,
    auditId: `audit:${plan.runId}:${planFingerprint.slice(0, 24)}`,
    runId: plan.runId,
    recordedAt: plan.generatedAt,
    planFingerprint,
    previousHash,
    operations: clone(plan.operations),
  };
  return { ...entry, entryHash: hashCanonicalValue(entry) };
}

export function emptyAuditLog() {
  return { version: AUDIT_VERSION, entries: [] };
}

export function verifyAuditLog(auditLog) {
  if (!validateAuditSchema(auditLog)) {
    fail("AUDIT_SCHEMA_INVALID", `Audit log is invalid: ${schemaMessage(validateAuditSchema)}`);
  }
  const runIds = new Set();
  const operationIds = new Set();
  let previousHash = null;
  for (let index = 0; index < auditLog.entries.length; index += 1) {
    const entry = auditLog.entries[index];
    if (entry.sequence !== index + 1) {
      fail("AUDIT_CHAIN_INVALID", `Audit sequence ${entry.sequence} is not append-only at index ${index}.`);
    }
    if (entry.previousHash !== previousHash || entry.entryHash !== entryHash(entry)) {
      fail("AUDIT_CHAIN_INVALID", `Audit hash chain is invalid at sequence ${entry.sequence}.`);
    }
    if (runIds.has(entry.runId)) {
      fail("NON_IDEMPOTENT_REPLAY", `Audit log contains duplicate run ID ${entry.runId}.`);
    }
    const targetIds = new Set();
    for (let operationIndex = 0; operationIndex < entry.operations.length; operationIndex += 1) {
      const operation = entry.operations[operationIndex];
      try {
        validateCatalogChangeOperation(operation);
      } catch (error) {
        fail("AUDIT_CHAIN_INVALID", `Audit operation ${operation.operationId} is invalid.`, {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      if (
        operationIndex > 0 &&
        compareCatalogOperations(entry.operations[operationIndex - 1], operation) > 0
      ) {
        fail("AUDIT_CHAIN_INVALID", `Audit entry ${entry.auditId} operations are not canonically ordered.`);
      }
      if (targetIds.has(operation.targetId)) {
        fail("CONFLICTING_OPERATIONS", `Audit entry ${entry.auditId} contains multiple operations for ${operation.targetId}.`);
      }
      if (operation.runId !== entry.runId || operation.plannedAt !== entry.recordedAt) {
        fail("AUDIT_CHAIN_INVALID", `Audit operation ${operation.operationId} has mismatched run metadata.`);
      }
      if (operationIds.has(operation.operationId)) {
        fail("NON_IDEMPOTENT_REPLAY", `Audit operation ${operation.operationId} is replayed more than once.`);
      }
      targetIds.add(operation.targetId);
      operationIds.add(operation.operationId);
    }
    runIds.add(entry.runId);
    previousHash = entry.entryHash;
  }
  return auditLog;
}

export function appendAuditPlan(auditLog, plan) {
  verifyAuditLog(auditLog);
  validateCatalogChangePlan(plan);
  const planFingerprint = hashCanonicalValue(plan);
  const existingRun = auditLog.entries.find((entry) => entry.runId === plan.runId);
  if (existingRun) {
    if (existingRun.planFingerprint !== planFingerprint || !isDeepStrictEqual(existingRun.operations, plan.operations)) {
      fail("NON_IDEMPOTENT_REPLAY", `Run ID ${plan.runId} was already audited with different content.`);
    }
    return clone(auditLog);
  }
  const existingOperationIds = new Set(
    auditLog.entries.flatMap((entry) => entry.operations.map((operation) => operation.operationId)),
  );
  const replayedOperation = plan.operations.find((operation) => existingOperationIds.has(operation.operationId));
  if (replayedOperation) {
    fail(
      "NON_IDEMPOTENT_REPLAY",
      `Operation ${replayedOperation.operationId} was already audited under another run.`,
    );
  }
  const entries = clone(auditLog.entries);
  const previousHash = entries.at(-1)?.entryHash ?? null;
  entries.push(auditEntry(plan, entries.length + 1, previousHash));
  const appended = { version: AUDIT_VERSION, entries };
  verifyAuditLog(appended);
  if (!isDeepStrictEqual(appended.entries.slice(0, auditLog.entries.length), auditLog.entries)) {
    fail("AUDIT_CHAIN_INVALID", "Audit append changed an existing entry.");
  }
  return appended;
}

export function writeAudit({ plan, auditLog = emptyAuditLog(), mode = "plan-only" } = {}) {
  if (mode !== "plan-only") {
    fail("WRITE_MODE_DISABLED", "Audit generation is plan-only and has no filesystem write mode.");
  }
  const proposedAuditLog = appendAuditPlan(auditLog, plan);
  return {
    mode,
    changed: proposedAuditLog.entries.length !== auditLog.entries.length,
    auditLog: proposedAuditLog,
  };
}