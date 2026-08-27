import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NON_WAIVABLE_RULE_IDS,
  loadValidationContext,
  validatePolicyData,
} from "./validation.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const context = await loadValidationContext(rootDir);
const now = new Date("2026-08-27T12:00:00.000Z");
const clone = (value) => structuredClone(value);

function issueCodes(issues) {
  return new Set(issues.map((issue) => issue.code));
}

test("compiles every pipeline schema and validates every checked-in config", () => {
  assert.deepEqual(
    [...context.schemas.schemaFiles].sort(),
    [
      "analysis.schema.json",
      "catalog.schema.json",
      "deprecations.schema.json",
      "exemptions.schema.json",
      "health.schema.json",
      "policy.schema.json",
      "retired-entries.schema.json",
      "trusted-sources.schema.json",
    ],
  );
  assert.deepEqual(validatePolicyData(context, {}, { now }), []);
});

test("rejects an invalid policy through its strict schema", () => {
  const policy = clone(context.configs.policy);
  policy.http.timeoutSeconds = 31;

  assert(issueCodes(validatePolicyData(context, { policy }, { now })).has("SCHEMA_VALIDATION"));
});

test("rejects an invalid evaluation set through its strict schema", () => {
  const evaluationSet = clone(context.configs.evaluationSet);
  evaluationSet.unexpected = true;

  assert(issueCodes(validatePolicyData(context, { evaluationSet }, { now })).has("SCHEMA_VALIDATION"));
});

test("reports malformed config roots without throwing", () => {
  assert(issueCodes(validatePolicyData(context, { deprecations: null }, { now })).has("SCHEMA_VALIDATION"));
  assert(issueCodes(validatePolicyData(context, { exemptions: null }, { now })).has("SCHEMA_VALIDATION"));
});

test("reports malformed config collections and members without throwing", () => {
  const deprecations = clone(context.configs.deprecations);
  deprecations.rules = [null];
  const exemptions = clone(context.configs.exemptions);
  exemptions.exemptions = {};

  assert(issueCodes(validatePolicyData(context, { deprecations }, { now })).has("SCHEMA_VALIDATION"));
  assert(issueCodes(validatePolicyData(context, { exemptions }, { now })).has("SCHEMA_VALIDATION"));
});

test("rejects expired active exemptions", () => {
  const exemptions = clone(context.configs.exemptions);
  exemptions.exemptions.push({
    id: "expired-test-exemption",
    galleryId: "example",
    ruleIds: ["lifecycle.retirement"],
    owner: "Gallery maintainers",
    rationale: "Exercise deterministic expiry validation.",
    startsAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-26T00:00:00.000Z",
    status: "active",
  });

  assert(issueCodes(validatePolicyData(context, { exemptions }, { now })).has("EXEMPTION_EXPIRED"));
});

test("rejects exemptions for non-waivable deterministic rules", () => {
  const exemptions = clone(context.configs.exemptions);
  exemptions.exemptions.push({
    id: "non-waivable-test-exemption",
    galleryId: "example",
    ruleIds: [NON_WAIVABLE_RULE_IDS[0]],
    owner: "Gallery maintainers",
    rationale: "Exercise deterministic non-waivable validation.",
    startsAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    status: "active",
  });

  assert(issueCodes(validatePolicyData(context, { exemptions }, { now })).has("EXEMPTION_NON_WAIVABLE"));
});

test("rejects deprecation patterns that do not compile", () => {
  const deprecations = clone(context.configs.deprecations);
  deprecations.rules[0].pattern.value = "[";

  assert(issueCodes(validatePolicyData(context, { deprecations }, { now })).has("DEPRECATION_REGEX_INVALID"));
});