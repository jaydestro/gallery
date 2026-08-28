import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyHttpStatus,
  createHealthSnapshot,
  githubSourceCoordinates,
  groupCatalogSources,
  mapWithConcurrency,
} from "./health.mjs";
import { safeFetch } from "./shared/safe-fetch.mjs";
import { loadValidationContext } from "./validation.mjs";

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_FIXTURE = fileURLToPath(new URL("./fixtures/health/input.json", import.meta.url));
const HEALTH_PATH = path.join("static", "gallery-health.json");
const FALLBACK_TO_GET_STATUSES = new Set([405, 501]);
const DNS_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENODATA",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);

function argumentValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  return value;
}

export function parseArguments(argv = []) {
  const options = {
    write: false,
    fixturePath: null,
    rootDir: process.cwd(),
    checkedAt: null,
    concurrency: DEFAULT_CONCURRENCY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write") {
      options.write = true;
      continue;
    }
    if (argument === "--dry-run") continue;
    if (argument === "--fixtures") {
      const candidate = argv[index + 1];
      if (candidate && !candidate.startsWith("--")) {
        options.fixturePath = candidate;
        index += 1;
      } else {
        options.fixturePath = DEFAULT_FIXTURE;
      }
      continue;
    }
    if (argument === "--root") {
      options.rootDir = argumentValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--now") {
      options.checkedAt = argumentValue(argv, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--concurrency") {
      options.concurrency = Number(argumentValue(argv, index, argument));
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown option: ${argument}`);
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new TypeError("--concurrency must be a positive integer");
  }
  if (options.write && options.fixturePath) {
    throw new TypeError("--write cannot be combined with --fixtures");
  }
  return options;
}

function requestEvidence(kind, method, status) {
  return { kind, value: `${method} ${status}` };
}

function resultForStatus(status, { kind, method, evidence = [] } = {}) {
  const classification = classifyHttpStatus(status);
  return {
    classification,
    statusCode: status,
    reason: classification === "healthy" ? null : `SOURCE_HTTP_${status}`,
    evidence: [...evidence, requestEvidence(kind, method, status)],
  };
}

function resultForError(error, { kind, method, evidence = [] } = {}) {
  const isTimeout = error?.name === "AbortError" || /timed out/i.test(error?.message ?? "");
  const errorCode = error?.code ?? error?.cause?.code;
  const isDnsError = DNS_ERROR_CODES.has(errorCode);
  const reason = isTimeout
    ? "SOURCE_TIMEOUT"
    : (isDnsError ? "SOURCE_DNS_ERROR" : "SOURCE_REQUEST_INDETERMINATE");
  return {
    classification: "indeterminate",
    reason,
    evidence: [...evidence, {
      kind,
      value: `${method} ${reason}`,
    }],
  };
}

async function boundedRequest(url, method, {
  fetchImpl,
  lookup,
  headers = {},
  policy,
  maxBytes = 64 * 1024,
}) {
  const hostname = new URL(url).hostname;
  return safeFetch(url, {
    trustedHosts: [hostname],
    fetchImpl: (input, init) => fetchImpl(input, { ...init, method }),
    lookup,
    headers,
    maxBytes,
    timeoutMs: (policy?.http?.timeoutSeconds ?? 30) * 1000,
    maxRedirects: policy?.http?.maxRedirects ?? 5,
  });
}

export async function checkHttpSource(canonicalSource, options) {
  let head;
  try {
    head = await boundedRequest(canonicalSource, "HEAD", options);
  } catch (error) {
    return resultForError(error, { kind: "http-status", method: "HEAD" });
  }

  const headEvidence = [requestEvidence("http-status", "HEAD", head.status)];
  if (!FALLBACK_TO_GET_STATUSES.has(head.status)) {
    return resultForStatus(head.status, { kind: "http-status", method: "HEAD" });
  }

  try {
    const get = await boundedRequest(canonicalSource, "GET", options);
    return resultForStatus(get.status, {
      kind: "http-status",
      method: "GET",
      evidence: headEvidence,
    });
  } catch (error) {
    return resultForError(error, {
      kind: "http-status",
      method: "GET",
      evidence: headEvidence,
    });
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "gallery-health-scanner",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubApiRequest(url, options) {
  return boundedRequest(url, "GET", {
    ...options,
    headers: githubHeaders(options.token),
    maxBytes: 512 * 1024,
  });
}

function githubApiUrl(coordinates) {
  const owner = encodeURIComponent(coordinates.owner);
  const repository = encodeURIComponent(coordinates.repository);
  return `https://api.github.com/repos/${owner}/${repository}`;
}

function githubPathApiUrl(repositoryUrl, coordinates) {
  const encodedPath = coordinates.repositoryPath.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`${repositoryUrl}/contents/${encodedPath}`);
  url.searchParams.set("ref", coordinates.ref);
  return url.toString();
}

export async function checkGitHubSource(canonicalSource, options) {
  const coordinates = githubSourceCoordinates(canonicalSource);
  if (!coordinates) return checkHttpSource(canonicalSource, options);

  const repositoryUrl = githubApiUrl(coordinates);
  let repositoryResponse;
  try {
    repositoryResponse = await githubApiRequest(repositoryUrl, options);
  } catch (error) {
    return resultForError(error, { kind: "github-repository-status", method: "GET" });
  }
  const repositoryResult = resultForStatus(repositoryResponse.status, {
    kind: "github-repository-status",
    method: "GET",
  });
  if (repositoryResult.classification !== "healthy") return repositoryResult;

  let repository;
  try {
    repository = repositoryResponse.json();
  } catch {
    return {
      classification: "indeterminate",
      reason: "GITHUB_RESPONSE_INVALID",
      evidence: [
        ...repositoryResult.evidence,
        { kind: "github-response", value: "invalid-json" },
      ],
    };
  }
  const archived = repository?.archived === true;
  const disabled = repository?.disabled === true;
  if (archived || disabled) {
    return {
      classification: "definitive-failure",
      reason: archived ? "GITHUB_REPOSITORY_ARCHIVED" : "GITHUB_REPOSITORY_DISABLED",
      archived,
      disabled,
      evidence: [
        ...repositoryResult.evidence,
        { kind: "github-repository-archived", value: archived },
        { kind: "github-repository-disabled", value: disabled },
      ],
    };
  }

  if (!coordinates.repositoryPath) {
    return { ...repositoryResult, archived, disabled };
  }

  const pathUrl = githubPathApiUrl(repositoryUrl, coordinates);
  let pathResponse;
  try {
    pathResponse = await githubApiRequest(pathUrl, options);
  } catch (error) {
    return resultForError(error, {
      kind: "github-path-status",
      method: "GET",
      evidence: repositoryResult.evidence,
    });
  }
  return {
    ...resultForStatus(pathResponse.status, {
      kind: "github-path-status",
      method: "GET",
      evidence: repositoryResult.evidence,
    }),
    archived,
    disabled,
  };
}

export async function checkSource(canonicalSource, options) {
  const coordinates = githubSourceCoordinates(canonicalSource);
  if (coordinates && options.token) return checkGitHubSource(canonicalSource, options);
  return checkHttpSource(canonicalSource, options);
}

async function readFixture(fixturePath) {
  const resolvedPath = path.resolve(fixturePath);
  const fixtureStats = await stat(resolvedPath);
  const inputPath = fixtureStats.isDirectory() ? path.join(resolvedPath, "input.json") : resolvedPath;
  return JSON.parse(await readFile(inputPath, "utf8"));
}

function fixtureNetwork(responses) {
  const responseQueues = new Map(
    Object.entries(responses ?? {}).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );
  return {
    lookup: async () => [{ address: "20.12.34.56", family: 4 }],
    fetchImpl: async (input, init = {}) => {
      const key = `${init.method ?? "GET"} ${new URL(input).toString()}`;
      const queue = responseQueues.get(key);
      if (!queue || queue.length === 0) throw new Error(`Offline fixture has no response for ${key}`);
      const definition = queue.length > 1 ? queue.shift() : queue[0];
      if (definition.error) {
        const error = new Error(definition.message ?? definition.error);
        error.name = definition.name ?? "Error";
        error.code = definition.error;
        throw error;
      }
      const body = init.method === "HEAD" || definition.body === undefined
        ? null
        : (typeof definition.body === "string" ? definition.body : JSON.stringify(definition.body));
      return new Response(body, {
        status: definition.status,
        headers: definition.headers,
      });
    },
  };
}

function assertHealthSchema(context, healthSnapshot) {
  const validate = context.schemas.validators.get("health.schema.json");
  if (validate(healthSnapshot)) return;
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new TypeError(`Health scanner produced invalid snapshot data: ${details}`);
}

async function writeHealthSnapshot(rootDir, healthSnapshot) {
  const targetPath = path.join(path.resolve(rootDir), HEALTH_PATH);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(healthSnapshot, null, 2)}\n`, "utf8");
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return targetPath;
}

function summarize(groups, sourceResults, healthSnapshot) {
  const summary = {
    sources: groups.length,
    entries: healthSnapshot.entries.length,
    healthy: 0,
    definitiveFailures: 0,
    indeterminate: 0,
    needsReview: 0,
    quarantined: 0,
  };
  for (const result of sourceResults.values()) {
    if (result.classification === "healthy") summary.healthy += 1;
    if (result.classification === "definitive-failure") summary.definitiveFailures += 1;
    if (result.classification === "indeterminate") summary.indeterminate += 1;
  }
  for (const entry of healthSnapshot.entries) {
    if (entry.status === "needs-review") summary.needsReview += 1;
    if (entry.status === "quarantined") summary.quarantined += 1;
  }
  return summary;
}

export async function runHealthScan({
  rootDir = process.cwd(),
  fixturePath = null,
  write = false,
  checkedAt = null,
  concurrency = DEFAULT_CONCURRENCY,
  token = process.env.GITHUB_TOKEN,
  fetchImpl = globalThis.fetch,
  lookup,
  context: suppliedContext = null,
  records: suppliedRecords = null,
  policy: suppliedPolicy = null,
  previousHealth: suppliedPreviousHealth = null,
} = {}) {
  if (write && fixturePath) throw new TypeError("Fixture scans cannot write health state");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const context = suppliedContext ?? await loadValidationContext(rootDir);
  const fixture = fixturePath ? await readFixture(fixturePath) : null;
  const network = fixture ? fixtureNetwork(fixture.responses) : { fetchImpl, lookup };
  const records = fixture?.catalog ?? suppliedRecords ?? context.catalog;
  const policy = fixture?.policy ?? suppliedPolicy ?? context.configs.policy;
  const previousHealth = fixture?.previousHealth ?? suppliedPreviousHealth ?? context.health;
  const reportTime = checkedAt ?? fixture?.checkedAt ?? new Date().toISOString();
  const githubToken = fixture ? (fixture.githubToken ?? null) : token;
  const groups = groupCatalogSources(records);
  const checkedResults = await mapWithConcurrency(groups, concurrency, async (group) => [
    group.canonicalSource,
    await checkSource(group.canonicalSource, {
      token: githubToken,
      fetchImpl: network.fetchImpl,
      lookup: network.lookup,
      policy,
    }),
  ]);
  const sourceResults = new Map(checkedResults);
  const healthSnapshot = createHealthSnapshot(records, sourceResults, {
    previousHealth,
    policy,
    checkedAt: reportTime,
  });
  assertHealthSchema(context, healthSnapshot);
  const writtenPath = write ? await writeHealthSnapshot(rootDir, healthSnapshot) : null;
  return {
    dryRun: !write,
    writtenPath,
    summary: summarize(groups, sourceResults, healthSnapshot),
    sources: groups.map((group) => ({
      canonicalSource: group.canonicalSource,
      galleryIds: group.records.map((item) => item.galleryId),
      ...sourceResults.get(group.canonicalSource),
    })),
    healthSnapshot,
  };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArguments(argv);
    const report = await runHealthScan(options);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error?.message ?? error}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}