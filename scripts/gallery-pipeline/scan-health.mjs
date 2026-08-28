import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyHttpStatus,
  createHealthSnapshot,
  githubSourceCoordinates,
  groupCatalogSources,
} from "./health.mjs";
import {
  HEALTH_ARTIFACT_FILES,
  createHealthPersistenceArtifacts,
  writeHealthScanArtifacts,
} from "./persist-health.mjs";
import { safeFetch } from "./shared/safe-fetch.mjs";
import { loadValidationContext } from "./validation.mjs";

const DEFAULT_CONCURRENCY = 6;
const LEARN_HOSTNAME = "learn.microsoft.com";
const LEARN_INTER_REQUEST_DELAY_MILLISECONDS = 200;
const HOST_CONCURRENCY_LIMITS = new Map([
  [LEARN_HOSTNAME, 1],
]);
const HOST_INTER_REQUEST_DELAYS_MILLISECONDS = new Map([
  [LEARN_HOSTNAME, LEARN_INTER_REQUEST_DELAY_MILLISECONDS],
]);
const DEFAULT_FIXTURE = fileURLToPath(new URL("./fixtures/health/input.json", import.meta.url));
const CATALOG_PATH = path.join("static", "templates.json");
const HEALTH_PATH = path.join("static", "gallery-health.json");
const FALLBACK_TO_GET_STATUSES = new Set([405, 501]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DNS_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENODATA",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);

class RequestAttemptsExhaustedError extends Error {
  constructor(cause, retryEvents) {
    super("Availability request attempts exhausted");
    this.name = "RequestAttemptsExhaustedError";
    this.cause = cause;
    this.retryEvents = retryEvents;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retrySchedule(policy) {
  const schedule = policy?.http?.retryDelaySeconds ?? [0];
  if (
    !Array.isArray(schedule) ||
    schedule.length === 0 ||
    schedule.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
  ) {
    throw new TypeError("policy.http.retryDelaySeconds must contain non-negative integers");
  }
  return schedule;
}

function retryAfterSeconds(response, maximumDelaySeconds, now) {
  const value = response?.headers?.get?.("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    return Math.min(Number(value), maximumDelaySeconds);
  }
  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return null;
  const delay = Math.max(0, Math.ceil((retryAt - now()) / 1000));
  return Math.min(delay, maximumDelaySeconds);
}

function sourceErrorReason(error) {
  const isTimeout = error?.name === "AbortError" || /timed out/i.test(error?.message ?? "");
  const errorCode = error?.code ?? error?.cause?.code;
  const isDnsError = DNS_ERROR_CODES.has(errorCode);
  return isTimeout
    ? "SOURCE_TIMEOUT"
    : (isDnsError ? "SOURCE_DNS_ERROR" : "SOURCE_REQUEST_INDETERMINATE");
}

function retryEvidence(retryEvents) {
  return retryEvents.map(({ reason, delaySeconds }, index) => ({
    kind: "availability-retry",
    value: `retry ${index + 1} after ${reason}; delay ${delaySeconds}s`,
  }));
}

function retryMetadata(retryEvents) {
  return {
    retryAttempts: retryEvents.length,
    retryReasons: retryEvents.map(({ reason }) => reason),
  };
}

function argumentValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  return value;
}

export function parseArguments(argv = []) {
  const options = {
    fixturePath: null,
    rootDir: process.cwd(),
    checkedAt: null,
    concurrency: DEFAULT_CONCURRENCY,
    outputDirectory: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
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
    if (argument === "--output-directory") {
      options.outputDirectory = argumentValue(argv, index, argument);
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown option: ${argument}`);
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new TypeError("--concurrency must be a positive integer");
  }
  return options;
}

function requestEvidence(kind, method, status) {
  return { kind, value: `${method} ${status}` };
}

function resultForStatus(status, { kind, method, evidence = [], retryEvents = [] } = {}) {
  const malformed = !Number.isInteger(status) || status < 100 || status > 599;
  const partial = status === 206;
  const classification = malformed || partial ? "indeterminate" : classifyHttpStatus(status);
  const reason = malformed
    ? "SOURCE_RESPONSE_MALFORMED"
    : (partial ? "SOURCE_PARTIAL_RESPONSE" : `SOURCE_HTTP_${status}`);
  return {
    classification,
    statusCode: status,
    reason: classification === "healthy" ? null : reason,
    ...retryMetadata(retryEvents),
    evidence: [...evidence, ...retryEvidence(retryEvents), requestEvidence(kind, method, status)],
  };
}

function resultForError(error, { kind, method, evidence = [], retryEvents: priorRetryEvents = [] } = {}) {
  const exhausted = error instanceof RequestAttemptsExhaustedError;
  const requestError = exhausted ? error.cause : error;
  const retryEvents = [
    ...priorRetryEvents,
    ...(exhausted ? error.retryEvents : []),
  ];
  const reason = sourceErrorReason(requestError);
  return {
    classification: "indeterminate",
    reason,
    ...retryMetadata(retryEvents),
    evidence: [...evidence, ...retryEvidence(retryEvents), {
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
  delay = wait,
  now = Date.now,
  signal,
  deadlineMilliseconds,
}) {
  if (typeof delay !== "function") throw new TypeError("delay must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const hostname = new URL(url).hostname;
  const schedule = retrySchedule(policy);
  const maximumDelaySeconds = Math.max(...schedule);
  const retryEvents = [];
  let nextDelaySeconds = 0;

  for (let attempt = 0; attempt < schedule.length; attempt += 1) {
    if (attempt > 0) await delay(nextDelaySeconds * 1000);
    try {
      const response = await safeFetch(url, {
        trustedHosts: [hostname],
        fetchImpl: (input, init) => fetchImpl(input, { ...init, method }),
        lookup,
        headers,
        maxBytes,
        timeoutMs: (policy?.http?.timeoutSeconds ?? 30) * 1000,
        maxRedirects: policy?.http?.maxRedirects ?? 5,
        signal,
        deadlineMilliseconds,
        now,
      });
      const reason = TRANSIENT_HTTP_STATUSES.has(response.status)
        ? `SOURCE_HTTP_${response.status}`
        : null;
      if (!reason || attempt === schedule.length - 1) {
        return { ...response, retryEvents };
      }
      nextDelaySeconds = retryAfterSeconds(response, maximumDelaySeconds, now)
        ?? schedule[attempt + 1];
      retryEvents.push({ reason, delaySeconds: nextDelaySeconds });
    } catch (error) {
      if (attempt === schedule.length - 1) {
        throw new RequestAttemptsExhaustedError(error, retryEvents);
      }
      nextDelaySeconds = schedule[attempt + 1];
      retryEvents.push({
        reason: sourceErrorReason(error),
        delaySeconds: nextDelaySeconds,
      });
    }
  }
  throw new Error("Availability retry schedule was not executed");
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
    return resultForStatus(head.status, {
      kind: "http-status",
      method: "HEAD",
      retryEvents: head.retryEvents,
    });
  }

  try {
    const get = await boundedRequest(canonicalSource, "GET", options);
    return resultForStatus(get.status, {
      kind: "http-status",
      method: "GET",
      evidence: headEvidence,
      retryEvents: [...(head.retryEvents ?? []), ...(get.retryEvents ?? [])],
    });
  } catch (error) {
    return resultForError(error, {
      kind: "http-status",
      method: "GET",
      evidence: headEvidence,
      retryEvents: head.retryEvents,
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
    retryEvents: repositoryResponse.retryEvents,
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
      evidence: [requestEvidence("github-repository-status", "GET", repositoryResponse.status)],
      retryEvents: repositoryResponse.retryEvents,
    });
  }
  return {
    ...resultForStatus(pathResponse.status, {
      kind: "github-path-status",
      method: "GET",
      evidence: [requestEvidence("github-repository-status", "GET", repositoryResponse.status)],
      retryEvents: [
        ...(repositoryResponse.retryEvents ?? []),
        ...(pathResponse.retryEvents ?? []),
      ],
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

export async function mapAvailabilityChecks(items, concurrency, worker, { delay = wait } = {}) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }
  if (typeof worker !== "function") throw new TypeError("worker must be a function");
  if (typeof delay !== "function") throw new TypeError("delay must be a function");

  const globalLimit = Math.min(concurrency, DEFAULT_CONCURRENCY);
  const results = new Array(items.length);
  const pendingIndexes = items.map((_, index) => index);
  const activeByHost = new Map();
  const completedHosts = new Set();

  function canonicalSource(item) {
    const source = typeof item === "string" ? item : item?.canonicalSource;
    return new URL(source).hostname.toLowerCase();
  }

  function claimNext() {
    for (let pendingIndex = 0; pendingIndex < pendingIndexes.length; pendingIndex += 1) {
      const itemIndex = pendingIndexes[pendingIndex];
      const hostname = canonicalSource(items[itemIndex]);
      const hostLimit = HOST_CONCURRENCY_LIMITS.get(hostname) ?? globalLimit;
      const activeForHost = activeByHost.get(hostname) ?? 0;
      if (activeForHost >= hostLimit) continue;
      pendingIndexes.splice(pendingIndex, 1);
      activeByHost.set(hostname, activeForHost + 1);
      return {
        hostname,
        itemIndex,
        interRequestDelayMilliseconds: completedHosts.has(hostname)
          ? (HOST_INTER_REQUEST_DELAYS_MILLISECONDS.get(hostname) ?? 0)
          : 0,
      };
    }
    return null;
  }

  async function runWorker() {
    while (true) {
      const claim = claimNext();
      if (!claim) return;
      try {
        if (claim.interRequestDelayMilliseconds > 0) {
          await delay(claim.interRequestDelayMilliseconds);
        }
        results[claim.itemIndex] = await worker(items[claim.itemIndex], claim.itemIndex);
        completedHosts.add(claim.hostname);
      } finally {
        const remaining = (activeByHost.get(claim.hostname) ?? 1) - 1;
        if (remaining === 0) activeByHost.delete(claim.hostname);
        else activeByHost.set(claim.hostname, remaining);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(globalLimit, items.length) }, () => runWorker()),
  );
  return results;
}

function assertHealthSchema(context, healthSnapshot) {
  const validate = context.schemas.validators.get("health.schema.json");
  if (validate(healthSnapshot)) return;
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new TypeError(`Health scanner produced invalid snapshot data: ${details}`);
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

function prettyJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function scanRunIdentity(reportTime, suppliedRun, environment) {
  if (suppliedRun) return suppliedRun;
  return {
    repository: environment.GITHUB_REPOSITORY ?? "local/gallery",
    runId: environment.GITHUB_RUN_ID ?? "local",
    runAttempt: Number(environment.GITHUB_RUN_ATTEMPT ?? 1),
    sourceRef: environment.GITHUB_REF ?? "refs/heads/local",
    sourceSha: environment.GITHUB_SHA ?? "local-unbound",
    observedAt: reportTime,
  };
}

export async function runHealthScan({
  rootDir = process.cwd(),
  fixturePath = null,
  checkedAt = null,
  concurrency = DEFAULT_CONCURRENCY,
  token = process.env.GITHUB_TOKEN,
  fetchImpl = globalThis.fetch,
  lookup,
  context: suppliedContext = null,
  records: suppliedRecords = null,
  policy: suppliedPolicy = null,
  previousHealth: suppliedPreviousHealth = null,
  catalogBytes: suppliedCatalogBytes = null,
  previousHealthBytes: suppliedPreviousHealthBytes = null,
  run: suppliedRun = null,
  environment = process.env,
  now = null,
  delay = wait,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const context = suppliedContext ?? await loadValidationContext(rootDir);
  const fixture = fixturePath ? await readFixture(fixturePath) : null;
  const network = fixture ? fixtureNetwork(fixture.responses) : { fetchImpl, lookup };
  const records = fixture?.catalog ?? suppliedRecords ?? context.catalog;
  const policy = fixture?.policy ?? suppliedPolicy ?? context.configs.policy;
  const previousHealth = fixture?.previousHealth ?? suppliedPreviousHealth ?? context.health;
  const reportTime = checkedAt ?? fixture?.checkedAt ?? new Date().toISOString();
  const resolvedRoot = path.resolve(rootDir);
  const catalogBytes = suppliedCatalogBytes ?? (
    fixture
      ? prettyJsonBytes(records)
      : (suppliedRecords ? prettyJsonBytes(records) : await readFile(path.join(resolvedRoot, CATALOG_PATH)))
  );
  const previousHealthBytes = suppliedPreviousHealthBytes ?? (
    fixture
      ? prettyJsonBytes(previousHealth)
      : (suppliedPreviousHealth
        ? prettyJsonBytes(previousHealth)
        : await readFile(path.join(resolvedRoot, HEALTH_PATH)))
  );
  const githubToken = fixture ? (fixture.githubToken ?? null) : token;
  const groups = groupCatalogSources(records);
  const checkedResults = await mapAvailabilityChecks(groups, concurrency, async (group) => [
    group.canonicalSource,
    await checkSource(group.canonicalSource, {
      token: githubToken,
      fetchImpl: network.fetchImpl,
      lookup: network.lookup,
      policy,
      delay,
    }),
  ], { delay });
  const sourceResults = new Map(checkedResults);
  const healthSnapshot = createHealthSnapshot(records, sourceResults, {
    previousHealth,
    policy,
    checkedAt: reportTime,
  });
  assertHealthSchema(context, healthSnapshot);
  const persistence = createHealthPersistenceArtifacts({
    catalog: records,
    catalogBytes,
    priorHealth: previousHealth,
    priorHealthBytes: previousHealthBytes,
    proposedHealth: healthSnapshot,
    run: scanRunIdentity(reportTime, fixture?.run ?? suppliedRun, environment),
    summary: summarize(groups, sourceResults, healthSnapshot),
    sources: groups.map((group) => ({
      canonicalSource: group.canonicalSource,
      galleryIds: group.records.map((item) => item.galleryId),
      ...sourceResults.get(group.canonicalSource),
    })),
    now: now ?? new Date().toISOString(),
  });
  return {
    dryRun: true,
    ...persistence.report,
    proposedHealth: persistence.proposedHealth,
    receipt: persistence.receipt,
    artifactBytes: persistence.artifactBytes,
  };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArguments(argv);
    const { outputDirectory, ...scanOptions } = options;
    const report = await runHealthScan(scanOptions);
    if (outputDirectory) {
      await writeHealthScanArtifacts({
        rootDir: options.rootDir,
        outputDirectory,
        artifactBytes: report.artifactBytes,
      });
    }
    stdout.write(report.artifactBytes[HEALTH_ARTIFACT_FILES.report]);
    return 0;
  } catch (error) {
    stderr.write(`${error?.message ?? error}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}