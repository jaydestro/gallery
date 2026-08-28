import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  AUDIT_LOG_SCHEMA,
  AuditWriteError,
  appendAuditPlan,
  emptyAuditLog,
  verifyAuditLog,
  writeAudit,
} from "./write-audit.mjs";
import {
  CATALOG_CHANGE_PLAN_SCHEMA,
  buildCatalogChangePlan,
  hashCanonicalValue,
} from "./build-catalog-change.mjs";
import { makePlanInput } from "./build-catalog-change.fixtures.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalogSchema = JSON.parse(await readFile(
  path.join(rootDirectory, ".github", "gallery-pipeline", "catalog.schema.json"),
  "utf8",
));
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(catalogSchema);
ajv.addSchema(CATALOG_CHANGE_PLAN_SCHEMA);
const validateAuditSchema = ajv.compile(AUDIT_LOG_SCHEMA);

function clone(value) {
  return structuredClone(value);
}

function expectCode(code) {
  return (error) => error instanceof AuditWriteError && error.code === code;
}

function fixturePlan() {
  return buildCatalogChangePlan(makePlanInput());
}

function operationIdFor(operation) {
  const transition = {
    type: operation.type,
    targetId: operation.targetId,
    before: operation.before,
    after: operation.after,
  };
  return `${operation.runId}:${operation.type}:${operation.targetId}:${hashCanonicalValue(transition).slice(0, 24)}`;
}

function singleOperationPlan(operation, runId, generatedAt) {
  const runOperation = {
    ...clone(operation),
    runId,
    plannedAt: generatedAt,
  };
  runOperation.operationId = operationIdFor(runOperation);
  const summary = { publish: 0, update: 0, quarantine: 0, retire: 0, restore: 0, total: 1 };
  summary[runOperation.type] = 1;
  return {
    version: "1.0.0",
    mode: "plan-only",
    runId,
    generatedAt,
    inputFingerprint: hashCanonicalValue({ runId, generatedAt, operation: runOperation }),
    summary,
    operations: [runOperation],
  };
}

test("creates a schema-valid hash-chained audit append without mutating input", () => {
  const plan = fixturePlan();
  const auditLog = emptyAuditLog();
  const untouchedPlan = clone(plan);
  const untouchedLog = clone(auditLog);
  const appended = appendAuditPlan(auditLog, plan);

  assert.equal(validateAuditSchema(appended), true, JSON.stringify(validateAuditSchema.errors));
  assert.equal(appended.entries.length, 1);
  assert.equal(appended.entries[0].runId, plan.runId);
  assert.equal(appended.entries[0].operations.length, 5);
  assert.equal(appended.entries[0].previousHash, null);
  assert.match(appended.entries[0].entryHash, /^[a-f0-9]{64}$/);
  assert.equal(verifyAuditLog(appended), appended);
  assert.deepEqual(plan, untouchedPlan);
  assert.deepEqual(auditLog, untouchedLog);
});

test("keeps the existing prefix byte-for-byte when appending a later empty run", () => {
  const first = appendAuditPlan(emptyAuditLog(), fixturePlan());
  const previousPrefix = clone(first.entries);
  const emptyRun = {
    version: "1.0.0",
    mode: "plan-only",
    runId: "gallery-run-20260828-120000",
    generatedAt: "2026-08-28T12:00:00.000Z",
    inputFingerprint: "a".repeat(64),
    summary: { publish: 0, update: 0, quarantine: 0, retire: 0, restore: 0, total: 0 },
    operations: [],
  };
  const second = appendAuditPlan(first, emptyRun);

  assert.deepEqual(second.entries.slice(0, first.entries.length), previousPrefix);
  assert.equal(second.entries[1].previousHash, second.entries[0].entryHash);
  assert.equal(second.entries[1].sequence, 2);
  verifyAuditLog(second);
});

test("treats an identical same-run replay as an idempotent no-op", () => {
  const plan = fixturePlan();
  const once = appendAuditPlan(emptyAuditLog(), plan);
  const twice = appendAuditPlan(once, clone(plan));

  assert.deepEqual(twice, once);
});

test("rejects altered content replayed under the same run ID", () => {
  const plan = fixturePlan();
  const auditLog = appendAuditPlan(emptyAuditLog(), plan);
  const altered = clone(plan);
  altered.inputFingerprint = "b".repeat(64);

  assert.throws(() => appendAuditPlan(auditLog, altered), expectCode("NON_IDEMPOTENT_REPLAY"));
});

test("rejects an externally supplied plan with an invalid target transition", () => {
  const plan = fixturePlan();
  plan.operations[0].after.id = "different-target";

  assert.throws(
    () => appendAuditPlan(emptyAuditLog(), plan),
    (error) => error?.code === "NON_IDEMPOTENT_REPLAY",
  );
});

test("allows a later repeated transition after restoration with a distinct run-scoped operation ID", () => {
  const initialPlan = fixturePlan();
  const quarantine = initialPlan.operations.find((operation) => operation.type === "quarantine");
  const first = appendAuditPlan(emptyAuditLog(), initialPlan);

  const restoration = {
    ...clone(quarantine),
    type: "restore",
    before: clone(quarantine.after),
    after: clone(quarantine.before),
    reasonCodes: ["RESTORE_PLANNED"],
  };
  const restorationPlan = singleOperationPlan(
    restoration,
    "gallery-run-20260828-120000",
    "2026-08-28T12:00:00.000Z",
  );
  const second = appendAuditPlan(first, restorationPlan);
  const repeatedPlan = singleOperationPlan(
    quarantine,
    "gallery-run-20260829-120000",
    "2026-08-29T12:00:00.000Z",
  );
  const third = appendAuditPlan(second, repeatedPlan);

  assert.equal(third.entries.length, 3);
  assert.notEqual(
    quarantine.operationId,
    third.entries[2].operations[0].operationId,
  );
  assert.equal(
    quarantine.operationId.split(":").at(-1),
    third.entries[2].operations[0].operationId.split(":").at(-1),
  );
  verifyAuditLog(third);
});

test("detects edits to prior entries through the append-only hash chain", () => {
  const auditLog = appendAuditPlan(emptyAuditLog(), fixturePlan());
  const tampered = clone(auditLog);
  tampered.entries[0].operations[0].reasonCodes = ["TAMPERED_AUDIT_REASON"];

  assert.throws(() => verifyAuditLog(tampered), expectCode("AUDIT_CHAIN_INVALID"));
});

test("rejects hash-valid audit entries with conflicting operations for one target", () => {
  const auditLog = appendAuditPlan(emptyAuditLog(), fixturePlan());
  const forged = clone(auditLog);
  const update = forged.entries[0].operations.find((operation) => operation.type === "update");
  const quarantine = {
    ...clone(update),
    type: "quarantine",
    after: { ...clone(update.before), lifecycleStatus: "quarantined" },
    reasonCodes: ["QUARANTINE_PLANNED"],
  };
  quarantine.operationId = operationIdFor(quarantine);
  forged.entries[0].operations.splice(3, 0, quarantine);
  const { entryHash, ...entryPayload } = forged.entries[0];
  forged.entries[0].entryHash = hashCanonicalValue(entryPayload);

  assert.throws(() => verifyAuditLog(forged), expectCode("CONFLICTING_OPERATIONS"));
});

test("writeAudit defaults to a plan-only proposal and rejects write modes", () => {
  const result = writeAudit({ plan: fixturePlan() });

  assert.equal(result.mode, "plan-only");
  assert.equal(result.changed, true);
  assert.equal(result.auditLog.entries.length, 1);
  assert.throws(
    () => writeAudit({ plan: fixturePlan(), mode: "commit" }),
    expectCode("WRITE_MODE_DISABLED"),
  );
});