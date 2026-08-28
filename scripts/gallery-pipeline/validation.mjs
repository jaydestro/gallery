import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const PIPELINE_DIRECTORY = path.join(".github", "gallery-pipeline");
const ANALYSIS_SCHEMA_ID = "urn:gallery-pipeline:schema:analysis:1.0.0";
const EVALUATION_SET_SCHEMA_ID = "urn:gallery-pipeline:schema:evaluation-set:1.0.0";
const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);
const HTTPS_FIELDS = new Set([
  "canonicalSource",
  "decisionPullRequestUrl",
  "decisionRunUrl",
  "endpoint",
  "launchUrl",
  "source",
  "url",
  "video",
  "website",
]);

const CONFIG_SPECS = Object.freeze([
  {
    key: "trustedSources",
    file: "trusted-sources.json",
    schemaFile: "trusted-sources.schema.json",
    schemaDeclaration: "./trusted-sources.schema.json",
  },
  {
    key: "policy",
    file: "policy.json",
    schemaFile: "policy.schema.json",
    schemaDeclaration: "./policy.schema.json",
  },
  {
    key: "deprecations",
    file: "deprecations.json",
    schemaFile: "deprecations.schema.json",
    schemaDeclaration: "./deprecations.schema.json",
  },
  {
    key: "exemptions",
    file: "exemptions.json",
    schemaFile: "exemptions.schema.json",
    schemaDeclaration: "./exemptions.schema.json",
  },
  {
    key: "evaluationSet",
    file: "evaluation-set.json",
    schemaId: EVALUATION_SET_SCHEMA_ID,
  },
]);

const EVALUATION_SET_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: EVALUATION_SET_SCHEMA_ID,
  title: "Gallery labeled evaluation set",
  type: "object",
  additionalProperties: false,
  required: ["version", "enabled", "seed"],
  properties: {
    version: {
      type: "string",
      pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$",
    },
    enabled: {
      type: "boolean",
    },
    seed: {
      type: "array",
      items: {
        $ref: ANALYSIS_SCHEMA_ID,
      },
    },
  },
});

export const NON_WAIVABLE_RULE_IDS = Object.freeze([
  "catalog.active-retired-id-disjoint",
  "catalog.canonical-source-unique",
  "catalog.declared-tags",
  "catalog.https-urls",
  "catalog.schema",
  "catalog.source-type",
  "catalog.title-unique",
  "catalog.trimmed-strings",
  "catalog.unique-tags",
  "policy.deprecation-regex",
  "policy.schema",
]);

const NON_WAIVABLE_RULE_ID_SET = new Set(NON_WAIVABLE_RULE_IDS);

export const SOURCE_SHARING_POLICY = Object.freeze([
  Object.freeze({
    id: "cosmic-food-rag-repository",
    canonicalSource: "https://github.com/azure-samples/cosmic-food-rag-app",
    members: Object.freeze([
      "Cosmic RAG Food app with Langchain, Azure OpenAI and Azure Cosmos DB for MongoDB",
      "Cosmic Food with Azure OpenAI and Azure Cosmos DB for MongoDB",
    ]),
    rationale: "Two current gallery cards intentionally present distinct scenarios from one repository.",
  }),
  Object.freeze({
    id: "build-2024-semantic-search-video",
    canonicalSource: "https://www.youtube.com/watch?v=3T0K61VbnFw",
    members: Object.freeze([
      "Microsoft Mechanics: Build AI Semantic Search for your website with Azure Cosmos DB",
      "BUILD 2024: Scalable RAG with Azure Cosmos DB and DiskANN | Studio15",
    ]),
    rationale: "Two current gallery cards intentionally present distinct session contexts for one video.",
  }),
  Object.freeze({
    id: "cosmic-works-repository",
    canonicalSource: "https://github.com/azurecosmosdb/cosmicworks",
    members: Object.freeze([
      "Cosmic Works: How to Model and Partition data for Azure Cosmos DB",
      "Cosmic Works: How to for Azure Cosmos DB Data Modeling and Partitioning (C#)",
    ]),
    rationale: "Two current gallery cards intentionally present distinct learning paths from one repository.",
  }),
]);

export class GalleryValidationError extends Error {
  constructor(label, issues) {
    super(`${label} failed with ${issues.length} validation issue${issues.length === 1 ? "" : "s"}.`);
    this.name = "GalleryValidationError";
    this.issues = issues;
  }
}

function addIssue(issues, code, issuePath, message) {
  issues.push({ code, path: issuePath, message });
}

function arrayItems(value) {
  return Array.isArray(value) ? value : [];
}

function sortedIssues(issues) {
  const uniqueIssues = new Map();
  for (const issue of issues) {
    uniqueIssues.set(`${issue.code}\u0000${issue.path}\u0000${issue.message}`, issue);
  }

  return [...uniqueIssues.values()].sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message),
  );
}

function syntheticSchemaId(fileName) {
  const name = fileName.replace(/\.schema\.json$/, "");
  return `urn:gallery-pipeline:schema:${name}:1.0.0`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function compileSchemas(rootDir) {
  const schemaDirectory = path.join(rootDir, PIPELINE_DIRECTORY);
  const schemaFiles = (await readdir(schemaDirectory))
    .filter((fileName) => fileName.endsWith(".schema.json"))
    .sort((left, right) => {
      if (left === "catalog.schema.json") return -1;
      if (right === "catalog.schema.json") return 1;
      return left.localeCompare(right);
    });
  const schemas = await Promise.all(
    schemaFiles.map(async (fileName) => ({
      fileName,
      schema: await readJson(path.join(schemaDirectory, fileName)),
    })),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);
  const schemaIds = new Map();

  for (const entry of schemas) {
    const schema = { ...entry.schema };
    if (!schema.$id) {
      schema.$id = entry.fileName === "analysis.schema.json"
        ? ANALYSIS_SCHEMA_ID
        : syntheticSchemaId(entry.fileName);
    }
    ajv.addSchema(schema);
    schemaIds.set(entry.fileName, schema.$id);
  }

  ajv.addSchema(EVALUATION_SET_SCHEMA);

  const validators = new Map();
  for (const [fileName, schemaId] of schemaIds) {
    const validator = ajv.getSchema(schemaId);
    if (!validator) {
      throw new Error(`Schema ${fileName} did not compile.`);
    }
    validators.set(fileName, validator);
  }

  const evaluationSetValidator = ajv.getSchema(EVALUATION_SET_SCHEMA_ID);
  if (!evaluationSetValidator) {
    throw new Error("The evaluation-set schema did not compile.");
  }

  return {
    ajv,
    evaluationSetValidator,
    schemaFiles,
    schemaIds,
    validators,
  };
}

export function extractDeclaredTags(sourceText) {
  const declaration = sourceText.match(/export\s+type\s+TagType\s*=([\s\S]*?);/);
  if (!declaration) {
    throw new Error("Could not find the TagType declaration in src/data/tags.tsx.");
  }

  const tags = [...declaration[1].matchAll(/\|\s*["']([^"']+)["']/g)].map((match) => match[1]);
  if (tags.length === 0) {
    throw new Error("The TagType declaration does not contain any string literal tags.");
  }
  if (new Set(tags).size !== tags.length) {
    throw new Error("The TagType declaration contains duplicate tags.");
  }

  const aliases = new Map();
  for (const tag of tags) {
    const normalizedTag = tag.toLocaleLowerCase("en-US");
    if (aliases.has(normalizedTag)) {
      throw new Error(`The TagType declaration contains the case aliases ${aliases.get(normalizedTag)} and ${tag}.`);
    }
    aliases.set(normalizedTag, tag);
  }

  return Object.freeze(tags);
}

export async function loadValidationContext(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const pipelineDirectory = path.join(resolvedRoot, PIPELINE_DIRECTORY);
  const schemas = await compileSchemas(resolvedRoot);
  const [configEntries, catalog, health, retired, tagSource] = await Promise.all([
    Promise.all(
      CONFIG_SPECS.map(async (spec) => [spec.key, await readJson(path.join(pipelineDirectory, spec.file))]),
    ),
    readJson(path.join(resolvedRoot, "static", "templates.json")),
    readJson(path.join(resolvedRoot, "static", "gallery-health.json")),
    readJson(path.join(resolvedRoot, "static", "retired-templates.json")),
    readFile(path.join(resolvedRoot, "src", "data", "tags.tsx"), "utf8"),
  ]);

  return {
    rootDir: resolvedRoot,
    schemas,
    configs: Object.fromEntries(configEntries),
    catalog,
    health,
    retired,
    declaredTags: extractDeclaredTags(tagSource),
  };
}

function appendSchemaIssues(issues, validate, value, issuePath) {
  if (validate(value)) return;

  for (const error of validate.errors ?? []) {
    const suffix = error.instancePath || "";
    addIssue(
      issues,
      "SCHEMA_VALIDATION",
      `${issuePath}${suffix}`,
      `${error.keyword}: ${error.message ?? "schema validation failed"}`,
    );
  }
}

function collectTrimmedStringIssues(value, issuePath, issues) {
  if (typeof value === "string") {
    if (value !== value.trim()) {
      addIssue(issues, "STRING_NOT_TRIMMED", issuePath, "String values must not have leading or trailing whitespace.");
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTrimmedStringIssues(item, `${issuePath}[${index}]`, issues));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectTrimmedStringIssues(item, `${issuePath}.${key}`, issues);
    }
  }
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function collectHttpsIssues(value, issuePath, issues) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectHttpsIssues(item, `${issuePath}[${index}]`, issues));
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${issuePath}.${key}`;
    if (HTTPS_FIELDS.has(key) && item !== null && typeof item === "string" && !isHttpsUrl(item)) {
      addIssue(issues, "HTTPS_URL_REQUIRED", itemPath, "URL values must be valid HTTPS URLs without credentials.");
    }
    collectHttpsIssues(item, itemPath, issues);
  }
}

export function canonicalizeUrl(value) {
  if (!isHttpsUrl(value)) return null;

  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLocaleLowerCase("en-US");

  for (const parameter of [...url.searchParams.keys()]) {
    const normalizedParameter = parameter.toLocaleLowerCase("en-US");
    if (normalizedParameter.startsWith("utm_") || TRACKING_PARAMETERS.has(normalizedParameter)) {
      url.searchParams.delete(parameter);
    }
  }

  if (url.hostname === "youtu.be") {
    const videoId = url.pathname.split("/").filter(Boolean)[0];
    url.hostname = "www.youtube.com";
    url.pathname = "/watch";
    url.search = videoId ? `?v=${videoId}` : "";
  } else if (["m.youtube.com", "youtube.com", "www.youtube.com"].includes(url.hostname)) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    const videoId = url.pathname === "/watch"
      ? url.searchParams.get("v")
      : (["embed", "shorts"].includes(pathParts[0]) ? pathParts[1] : null);
    url.hostname = "www.youtube.com";
    if (videoId) {
      url.pathname = "/watch";
      url.search = `?v=${videoId}`;
    }
  }

  if (url.hostname === "github.com") {
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length >= 2) {
      pathParts[0] = pathParts[0].toLocaleLowerCase("en-US");
      pathParts[1] = pathParts[1].replace(/\.git$/i, "").toLocaleLowerCase("en-US");
      url.pathname = `/${pathParts.join("/")}`;
    }
  }

  if (url.hostname === "learn.microsoft.com") {
    url.pathname = url.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "");
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.searchParams.sort();
  return url.toString();
}

export function inferSourceType(value, tags = []) {
  const canonicalUrl = canonicalizeUrl(value);
  if (!canonicalUrl) return null;

  const url = new URL(canonicalUrl);
  if (url.hostname === "github.com") {
    return url.pathname.split("/").filter(Boolean).length > 2 ? "github-path" : "github-repository";
  }
  if (url.hostname === "learn.microsoft.com") return "learn-document";
  if (["vimeo.com", "www.youtube.com"].includes(url.hostname)) return "video";
  if (url.hostname.includes("blog") || url.pathname.split("/").includes("blog") || tags.includes("blog")) {
    return "blog-post";
  }
  if (tags.includes("tools")) return "tool";
  return "other";
}

function canonicalSourceForRecord(record) {
  return canonicalizeUrl(record.canonicalSource ?? record.source ?? record.website);
}

function validateTags(record, issuePath, declaredTags, issues) {
  const declaredTagSet = new Set(declaredTags);
  const declaredAliases = new Map(
    declaredTags.map((tag) => [tag.toLocaleLowerCase("en-US"), tag]),
  );

  for (const property of ["tags", "previewTags"]) {
    const tags = record[property];
    if (!Array.isArray(tags)) continue;

    const seenTags = new Set();
    tags.forEach((tag, index) => {
      const tagPath = `${issuePath}.${property}[${index}]`;
      if (seenTags.has(tag)) {
        addIssue(issues, "TAG_DUPLICATE", tagPath, `Tag ${JSON.stringify(tag)} appears more than once.`);
      }
      seenTags.add(tag);

      if (typeof tag !== "string" || declaredTagSet.has(tag)) return;
      const declaredAlias = declaredAliases.get(tag.toLocaleLowerCase("en-US"));
      if (declaredAlias) {
        addIssue(issues, "TAG_CASE_ALIAS", tagPath, `Use declared tag ${JSON.stringify(declaredAlias)} instead of case alias ${JSON.stringify(tag)}.`);
      } else {
        addIssue(issues, "TAG_UNDECLARED", tagPath, `Tag ${JSON.stringify(tag)} is not declared by TagType.`);
      }
    });
  }
}

function validateRecord(record, issuePath, declaredTags, issues) {
  if (!record || typeof record !== "object") return;
  validateTags(record, issuePath, declaredTags, issues);

  if ("sourceType" in record && typeof record.sourceType === "string") {
    const inferredSourceType = inferSourceType(record.canonicalSource, record.tags);
    if (inferredSourceType && inferredSourceType !== record.sourceType) {
      addIssue(
        issues,
        "SOURCE_TYPE_MISMATCH",
        `${issuePath}.sourceType`,
        `Declared source type ${record.sourceType} does not match inferred type ${inferredSourceType}.`,
      );
    }
  }
}

function validateUniqueTitles(catalog, retired, issues) {
  const titlePaths = new Map();
  const addTitle = (record, titlePath) => {
    if (!record || typeof record.title !== "string") return;
    const firstPath = titlePaths.get(record.title);
    if (firstPath !== undefined) {
      addIssue(
        issues,
        "TITLE_DUPLICATE",
        titlePath,
        `Title duplicates ${firstPath} exactly.`,
      );
    } else {
      titlePaths.set(record.title, titlePath);
    }
  };

  catalog.forEach((record, index) => addTitle(record, `catalog[${index}].title`));
  for (const [index, entry] of arrayItems(retired?.entries).entries()) {
    addTitle(entry?.record, `retired.entries[${index}].record.title`);
  }
}

function validateIds(catalog, retired, issues) {
  const activeIds = new Map();
  catalog.forEach((record, index) => {
    if (!record || typeof record.id !== "string") return;
    if (activeIds.has(record.id)) {
      addIssue(issues, "ACTIVE_ID_DUPLICATE", `catalog[${index}].id`, `ID duplicates catalog[${activeIds.get(record.id)}].id.`);
    } else {
      activeIds.set(record.id, index);
    }
  });

  const retiredIds = new Map();
  for (const [index, entry] of arrayItems(retired?.entries).entries()) {
    const id = entry?.record?.id;
    if (typeof id !== "string") continue;
    if (retiredIds.has(id)) {
      addIssue(issues, "RETIRED_ID_DUPLICATE", `retired.entries[${index}].record.id`, `ID duplicates retired.entries[${retiredIds.get(id)}].record.id.`);
    } else {
      retiredIds.set(id, index);
    }
    if (activeIds.has(id)) {
      addIssue(
        issues,
        "ACTIVE_RETIRED_ID_OVERLAP",
        `retired.entries[${index}].record.id`,
        `ID is also active at catalog[${activeIds.get(id)}].id.`,
      );
    }
  }
}

function sourceSharingIsAllowed(canonicalSource, records) {
  const allowance = SOURCE_SHARING_POLICY.find((entry) => entry.canonicalSource === canonicalSource);
  if (!allowance || records.some((record) => record.scope !== "active")) return false;

  const actualMembers = records.map((record) => record.title).sort();
  const allowedMembers = [...allowance.members].sort();
  return actualMembers.length === allowedMembers.length &&
    actualMembers.every((member, index) => member === allowedMembers[index]);
}

function validateCanonicalSourceUniqueness(catalog, retired, issues) {
  const sourceRecords = new Map();
  const addRecord = (record, issuePath, scope) => {
    if (!record || typeof record !== "object") return;
    const canonicalSource = canonicalSourceForRecord(record);
    if (!canonicalSource) return;
    const records = sourceRecords.get(canonicalSource) ?? [];
    records.push({ issuePath, scope, title: record.title });
    sourceRecords.set(canonicalSource, records);
  };

  catalog.forEach((record, index) => addRecord(record, `catalog[${index}]`, "active"));
  for (const [index, entry] of arrayItems(retired?.entries).entries()) {
    addRecord(entry?.record, `retired.entries[${index}].record`, "retired");
  }

  for (const [canonicalSource, records] of sourceRecords) {
    if (records.length < 2 || sourceSharingIsAllowed(canonicalSource, records)) continue;
    addIssue(
      issues,
      "CANONICAL_SOURCE_DUPLICATE",
      records[1].issuePath,
      `Canonical source ${canonicalSource} is shared without an exact SOURCE_SHARING_POLICY allowance.`,
    );
  }

  for (const allowance of SOURCE_SHARING_POLICY) {
    const records = sourceRecords.get(allowance.canonicalSource) ?? [];
    if (!sourceSharingIsAllowed(allowance.canonicalSource, records)) {
      addIssue(
        issues,
        "SOURCE_SHARING_POLICY_STALE",
        `SOURCE_SHARING_POLICY.${allowance.id}`,
        "Allowance must identify exactly two or more distinct current records at its canonical source.",
      );
    }
  }
}

function validateContractVersion(issues, policy, contractKey, value, issuePath) {
  const expectedVersion = policy?.contractVersions?.[contractKey];
  if (typeof expectedVersion === "string" && typeof value === "string" && expectedVersion !== value) {
    addIssue(
      issues,
      "CONTRACT_VERSION_MISMATCH",
      issuePath,
      `Version ${value} does not match policy contract version ${expectedVersion}.`,
    );
  }
}

function validateExemptions(exemptions, policy, now, issues) {
  const seenIds = new Map();
  const nowTimestamp = now.getTime();
  const maximumDurationDays = policy?.exemptions?.maximumDurationDays;

  for (const [index, exemption] of arrayItems(exemptions?.exemptions).entries()) {
    const issuePath = `exemptions.exemptions[${index}]`;
    if (!exemption || typeof exemption !== "object") continue;
    if (typeof exemption.id === "string") {
      if (seenIds.has(exemption.id)) {
        addIssue(issues, "EXEMPTION_ID_DUPLICATE", `${issuePath}.id`, `ID duplicates exemptions.exemptions[${seenIds.get(exemption.id)}].id.`);
      } else {
        seenIds.set(exemption.id, index);
      }
    }

    const startsAt = Date.parse(exemption.startsAt);
    const expiresAt = Date.parse(exemption.expiresAt);
    if (Number.isFinite(startsAt) && Number.isFinite(expiresAt)) {
      if (expiresAt <= startsAt) {
        addIssue(issues, "EXEMPTION_RANGE_INVALID", `${issuePath}.expiresAt`, "An exemption must expire after it starts.");
      }
      if (typeof maximumDurationDays === "number" && expiresAt - startsAt > maximumDurationDays * 86_400_000) {
        addIssue(issues, "EXEMPTION_TOO_LONG", `${issuePath}.expiresAt`, `An exemption cannot exceed ${maximumDurationDays} days.`);
      }
      if (exemption.status === "active" && expiresAt <= nowTimestamp) {
        addIssue(issues, "EXEMPTION_EXPIRED", `${issuePath}.expiresAt`, "An active exemption must not be expired.");
      }
      if (exemption.status === "active" && startsAt > nowTimestamp) {
        addIssue(issues, "EXEMPTION_NOT_STARTED", `${issuePath}.startsAt`, "An active exemption must already have started.");
      }
      if (exemption.status === "expired" && expiresAt > nowTimestamp) {
        addIssue(issues, "EXEMPTION_STATUS_INVALID", `${issuePath}.status`, "An exemption cannot be marked expired before its expiration time.");
      }
    }

    for (const [ruleIndex, ruleId] of (exemption.ruleIds ?? []).entries()) {
      if (NON_WAIVABLE_RULE_ID_SET.has(ruleId)) {
        addIssue(
          issues,
          "EXEMPTION_NON_WAIVABLE",
          `${issuePath}.ruleIds[${ruleIndex}]`,
          `Rule ${ruleId} is deterministic and cannot be waived.`,
        );
      }
    }
  }
}

function validateDeprecationRegexes(deprecations, issues) {
  const seenIds = new Map();
  for (const [index, rule] of arrayItems(deprecations?.rules).entries()) {
    const issuePath = `deprecations.rules[${index}]`;
    if (!rule || typeof rule !== "object") continue;
    if (typeof rule.id === "string") {
      if (seenIds.has(rule.id)) {
        addIssue(issues, "DEPRECATION_ID_DUPLICATE", `${issuePath}.id`, `ID duplicates deprecations.rules[${seenIds.get(rule.id)}].id.`);
      } else {
        seenIds.set(rule.id, index);
      }
    }
    if (typeof rule.pattern?.value !== "string" || typeof rule.pattern?.flags !== "string") continue;
    try {
      new RegExp(rule.pattern.value, rule.pattern.flags);
    } catch (error) {
      addIssue(issues, "DEPRECATION_REGEX_INVALID", `${issuePath}.pattern`, `Regex does not compile: ${error.message}`);
    }
  }
}

export function validatePolicyData(context, overrides = {}, options = {}) {
  const issues = [];
  const configs = { ...context.configs, ...overrides };
  const now = options.now ?? new Date();

  for (const spec of CONFIG_SPECS) {
    const value = configs[spec.key];
    const validator = spec.schemaFile
      ? context.schemas.validators.get(spec.schemaFile)
      : context.schemas.evaluationSetValidator;
    appendSchemaIssues(issues, validator, value, spec.key);
    collectTrimmedStringIssues(value, spec.key, issues);
    collectHttpsIssues(value, spec.key, issues);

    if (spec.schemaDeclaration && value?.$schema !== spec.schemaDeclaration) {
      addIssue(
        issues,
        "SCHEMA_DECLARATION_MISMATCH",
        `${spec.key}.$schema`,
        `Expected schema declaration ${spec.schemaDeclaration}.`,
      );
    }
  }

  const policy = configs.policy;
  validateContractVersion(issues, policy, "policy", policy?.version, "policy.version");
  for (const spec of CONFIG_SPECS) {
    if (spec.key === "policy") continue;
    validateContractVersion(issues, policy, spec.key, configs[spec.key]?.version, `${spec.key}.version`);
  }

  validateExemptions(configs.exemptions, policy, now, issues);
  validateDeprecationRegexes(configs.deprecations, issues);
  return sortedIssues(issues);
}

export function validateCatalogData(context, overrides = {}) {
  const issues = [];
  const overrideValue = (key, fallback) => Object.hasOwn(overrides, key) ? overrides[key] : fallback;
  const catalog = overrideValue("catalog", context.catalog);
  const health = overrideValue("health", context.health);
  const retired = overrideValue("retired", context.retired);
  const policy = overrideValue("policy", context.configs.policy);
  const catalogValidator = context.schemas.validators.get("catalog.schema.json");
  const healthValidator = context.schemas.validators.get("health.schema.json");
  const retiredValidator = context.schemas.validators.get("retired-entries.schema.json");

  appendSchemaIssues(issues, catalogValidator, catalog, "catalog");
  appendSchemaIssues(issues, healthValidator, health, "health");
  appendSchemaIssues(issues, retiredValidator, retired, "retired");

  collectTrimmedStringIssues(catalog, "catalog", issues);
  collectTrimmedStringIssues(health, "health", issues);
  collectTrimmedStringIssues(retired, "retired", issues);
  collectHttpsIssues(catalog, "catalog", issues);
  collectHttpsIssues(health, "health", issues);
  collectHttpsIssues(retired, "retired", issues);

  if (Array.isArray(catalog)) {
    catalog.forEach((record, index) => validateRecord(record, `catalog[${index}]`, context.declaredTags, issues));
    validateUniqueTitles(catalog, retired, issues);
    validateIds(catalog, retired, issues);
    validateCanonicalSourceUniqueness(catalog, retired, issues);
  }
  for (const [index, entry] of arrayItems(retired?.entries).entries()) {
    validateRecord(entry?.record, `retired.entries[${index}].record`, context.declaredTags, issues);
  }

  if (health?.$schema !== "../.github/gallery-pipeline/health.schema.json") {
    addIssue(issues, "SCHEMA_DECLARATION_MISMATCH", "health.$schema", "Health sidecar must declare the repository health schema.");
  }
  if (retired?.$schema !== "../.github/gallery-pipeline/retired-entries.schema.json") {
    addIssue(issues, "SCHEMA_DECLARATION_MISMATCH", "retired.$schema", "Retired sidecar must declare the repository retired-entry schema.");
  }
  validateContractVersion(issues, policy, "health", health?.version, "health.version");
  validateContractVersion(issues, policy, "retiredEntries", retired?.version, "retired.version");

  return sortedIssues(issues);
}

export function assertValid(label, issues) {
  if (issues.length > 0) throw new GalleryValidationError(label, issues);
}

export function formatIssues(issues) {
  return issues.map((issue) => `- [${issue.code}] ${issue.path}: ${issue.message}`).join("\n");
}