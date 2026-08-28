import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyCatalogPlan } from "./apply-catalog-plan.mjs";
import { emptyAuditLog } from "./write-audit.mjs";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDirectory = path.resolve(moduleDirectory, "..", "..");
const POLICY_PATH = ".github/gallery-pipeline/policy.json";
const CONFIRMED_MISSING_BASE_FILE = Symbol("confirmed-missing-base-file");

export const CATALOG_PLAN_PATH = ".github/gallery-pipeline/catalog-change-plan.json";
export const CATALOG_STATE_FILES = Object.freeze({
  activeCatalog: "static/templates.json",
  health: "static/gallery-health.json",
  retired: "static/retired-templates.json",
  audit: "static/catalog-audit.json",
});

export class CatalogDiffValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CatalogDiffValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CatalogDiffValidationError(code, message, details);
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function changedPathSet(changedPaths) {
  if (!Array.isArray(changedPaths)) {
    fail("PATHS_INVALID", "changedPaths must be an array.");
  }
  const normalized = changedPaths.map((filePath) => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      fail("PATHS_INVALID", "changedPaths must contain non-empty strings.");
    }
    return normalizePath(filePath);
  });
  return new Set(normalized);
}

function requireStateFile(files, key, label) {
  const value = files?.[key];
  if (value === undefined) {
    fail("STATE_FILE_MISSING", `${label} ${CATALOG_STATE_FILES[key]} is missing.`);
  }
  return value;
}

function stateForApply(files, label, { confirmedMissingAudit = false } = {}) {
  return {
    activeCatalog: requireStateFile(files, "activeCatalog", label),
    health: requireStateFile(files, "health", label),
    retired: requireStateFile(files, "retired", label),
    audit: files?.audit === undefined && confirmedMissingAudit
      ? emptyAuditLog()
      : requireStateFile(files, "audit", label),
  };
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactStatePaths(actualPaths, expectedPaths) {
  const actual = sorted(actualPaths);
  const expected = sorted(expectedPaths);
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      "STATE_PATH_MISMATCH",
      `Catalog state paths do not match replay output. Expected [${expected.join(", ")}], received [${actual.join(", ")}].`,
      { expected, actual },
    );
  }
}

function assertCompleteChangedPaths(providedPaths, repositoryPaths) {
  const provided = sorted(changedPathSet(providedPaths));
  const actual = sorted(changedPathSet(repositoryPaths));
  if (!isDeepStrictEqual(provided, actual)) {
    fail(
      "CHANGED_PATHS_INCOMPLETE",
      `Provided changed paths do not exactly match Git. Expected [${actual.join(", ")}], received [${provided.join(", ")}].`,
      { expected: actual, actual: provided },
    );
  }
  return provided;
}

export function validateCatalogDiff({
  changedPaths,
  plan,
  baseFiles,
  baseAuditMissing = false,
  proposedFiles,
  policy,
  trustedRepository,
} = {}) {
  const paths = changedPathSet(changedPaths);
  const statePaths = new Set(Object.values(CATALOG_STATE_FILES));
  const changedStatePaths = new Set([...paths].filter((filePath) => statePaths.has(filePath)));
  const proofChanged = paths.has(CATALOG_PLAN_PATH);

  if (changedStatePaths.size === 0) {
    if (proofChanged) {
      fail("UNEXPLAINED_PLAN", `${CATALOG_PLAN_PATH} changed without a catalog state change.`);
    }
    return {
      required: false,
      operations: 0,
      statePaths: [],
      message: "Catalog replay validation passed: no catalog state changes detected; replay proof not required.",
    };
  }
  if (!proofChanged) {
    fail(
      "REPLAY_PROOF_MISSING",
      `Catalog state changes require an updated replay proof at ${CATALOG_PLAN_PATH}.`,
    );
  }
  const allowedPaths = new Set([CATALOG_PLAN_PATH, ...statePaths]);
  const unexpectedPaths = sorted([...paths].filter((filePath) => !allowedPaths.has(filePath)));
  if (unexpectedPaths.length > 0) {
    fail(
      "UNEXPECTED_CHANGED_PATHS",
      `Catalog state changes cannot be combined with unrecognized paths: ${unexpectedPaths.join(", ")}.`,
      { unexpectedPaths },
    );
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    fail("REPLAY_PROOF_INVALID", `${CATALOG_PLAN_PATH} must contain a catalog change plan.`);
  }
  if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
    fail("REPLAY_PROOF_INVALID", "Catalog state changes require at least one planned operation.");
  }

  const base = stateForApply(baseFiles, "Base", { confirmedMissingAudit: baseAuditMissing });
  let expected;
  try {
    expected = applyCatalogPlan({ plan, ...base, policy, trustedRepository });
  } catch (error) {
    fail("REPLAY_FAILED", "Catalog plan could not be replayed from the base state.", {
      cause: error instanceof Error ? error.message : String(error),
      code: error?.code,
    });
  }

  const expectedChangedPaths = new Set();
  for (const [key, filePath] of Object.entries(CATALOG_STATE_FILES)) {
    if (!isDeepStrictEqual(base[key], expected[key])) expectedChangedPaths.add(filePath);
  }
  assertExactStatePaths(changedStatePaths, expectedChangedPaths);

  const proposed = stateForApply(proposedFiles, "Proposed");
  for (const [key, filePath] of Object.entries(CATALOG_STATE_FILES)) {
    if (!isDeepStrictEqual(proposed[key], expected[key])) {
      fail(
        "PROPOSED_FILE_MISMATCH",
        `${filePath} does not exactly match deterministic replay output.`,
        { filePath },
      );
    }
  }

  return {
    required: true,
    operations: plan.operations.length,
    statePaths: sorted(expectedChangedPaths),
    message: `Catalog replay validation passed: ${plan.operations.length} planned operations exactly reproduce ${expectedChangedPaths.size} catalog state files with an append-only audit.`,
  };
}

async function readJsonFile(rootDirectory, filePath) {
  try {
    return JSON.parse(await readFile(path.join(rootDirectory, filePath), "utf8"));
  } catch (error) {
    fail("STATE_FILE_READ_FAILED", `Could not read ${filePath}: ${error.message}`);
  }
}

async function readBaseJson(rootDirectory, baseRef, filePath, { optional = false } = {}) {
  let treeOutput;
  try {
    ({ stdout: treeOutput } = await execFileAsync(
      "git",
      ["ls-tree", "-z", "--name-only", baseRef, "--", filePath],
      { cwd: rootDirectory, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (error) {
    fail("BASE_GIT_READ_FAILED", `Could not inspect ${filePath} in ${baseRef}: ${error.message}`);
  }
  const exists = treeOutput.split("\0").filter(Boolean).map(normalizePath).includes(filePath);
  if (!exists) {
    if (optional) return CONFIRMED_MISSING_BASE_FILE;
    fail("BASE_FILE_READ_FAILED", `${filePath} is missing from ${baseRef}.`);
  }
  let contents;
  try {
    ({ stdout: contents } = await execFileAsync(
      "git",
      ["show", `${baseRef}:${filePath}`],
      { cwd: rootDirectory, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (error) {
    fail("BASE_FILE_READ_FAILED", `Could not read ${filePath} from ${baseRef}: ${error.message}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    fail("BASE_FILE_PARSE_FAILED", `Could not parse ${filePath} from ${baseRef}: ${error.message}`);
  }
}

async function repositoryChangedPaths(rootDirectory, baseRef) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "--no-renames", `${baseRef}...HEAD`, "--"],
      { cwd: rootDirectory, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout.split(/\r?\n/).filter(Boolean).map(normalizePath);
  } catch (error) {
    fail("GIT_DIFF_FAILED", `Could not compare ${baseRef} to HEAD: ${error.message}`);
  }
}

export async function validateCatalogRepositoryDiff({
  rootDirectory = defaultRootDirectory,
  baseRef = "HEAD^",
  changedPaths,
  trustedRepository = process.env.GITHUB_REPOSITORY,
} = {}) {
  const resolvedRoot = path.resolve(rootDirectory);
  const repositoryPaths = await repositoryChangedPaths(resolvedRoot, baseRef);
  const validatedPaths = changedPaths === undefined
    ? repositoryPaths
    : assertCompleteChangedPaths(changedPaths, repositoryPaths);
  const hasStateChange = validatedPaths.some((filePath) => Object.values(CATALOG_STATE_FILES).includes(filePath));
  if (!hasStateChange || !validatedPaths.includes(CATALOG_PLAN_PATH)) {
    return validateCatalogDiff({ changedPaths: validatedPaths });
  }

  const [plan, policy, activeCatalog, health, retired, audit, baseActive, baseHealth, baseRetired, baseAudit] =
    await Promise.all([
      readJsonFile(resolvedRoot, CATALOG_PLAN_PATH),
      readJsonFile(resolvedRoot, POLICY_PATH),
      readJsonFile(resolvedRoot, CATALOG_STATE_FILES.activeCatalog),
      readJsonFile(resolvedRoot, CATALOG_STATE_FILES.health),
      readJsonFile(resolvedRoot, CATALOG_STATE_FILES.retired),
      readJsonFile(resolvedRoot, CATALOG_STATE_FILES.audit),
      readBaseJson(resolvedRoot, baseRef, CATALOG_STATE_FILES.activeCatalog),
      readBaseJson(resolvedRoot, baseRef, CATALOG_STATE_FILES.health),
      readBaseJson(resolvedRoot, baseRef, CATALOG_STATE_FILES.retired),
      readBaseJson(resolvedRoot, baseRef, CATALOG_STATE_FILES.audit, { optional: true }),
    ]);
  return validateCatalogDiff({
    changedPaths: validatedPaths,
    plan,
    policy,
    trustedRepository,
    baseAuditMissing: baseAudit === CONFIRMED_MISSING_BASE_FILE,
    baseFiles: {
      activeCatalog: baseActive,
      health: baseHealth,
      retired: baseRetired,
      audit: baseAudit === CONFIRMED_MISSING_BASE_FILE ? undefined : baseAudit,
    },
    proposedFiles: { activeCatalog, health, retired, audit },
  });
}

function parseArguments(argv) {
  const options = { rootDirectory: defaultRootDirectory, baseRef: "HEAD^" };
  const changedPaths = [];
  let changedPathsComplete = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") {
      options.baseRef = argv[index + 1];
      index += 1;
    } else if (argument === "--root") {
      options.rootDirectory = argv[index + 1];
      index += 1;
    } else if (argument === "--changed-path") {
      changedPaths.push(argv[index + 1]);
      index += 1;
    } else if (argument === "--changed-paths-complete") {
      changedPathsComplete = true;
    } else {
      fail("ARGUMENT_INVALID", `Unknown argument ${argument}.`);
    }
  }
  if (!options.baseRef || !options.rootDirectory) {
    fail("ARGUMENT_INVALID", "--base and --root require non-empty values.");
  }
  if (changedPaths.some((filePath) => !filePath)) {
    fail("ARGUMENT_INVALID", "--changed-path requires a non-empty value.");
  }
  if (changedPaths.length > 0 && !changedPathsComplete) {
    fail("ARGUMENT_INVALID", "--changed-path requires --changed-paths-complete.");
  }
  if (changedPathsComplete) options.changedPaths = changedPaths;
  return options;
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    const result = await validateCatalogRepositoryDiff(parseArguments(argv));
    stdout.write(`${result.message}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Catalog replay validation failed [${error.code ?? "ERROR"}]: ${error.message}\n`);
    if (error.details?.cause) stderr.write(`Cause: ${error.details.cause}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}