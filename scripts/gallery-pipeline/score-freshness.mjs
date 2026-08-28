import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  evaluateCatalogFreshness,
  isGitHubBackedRecord,
  repositoryCoordinates,
} from "./freshness.mjs";
import { canonicalizeUrl } from "./shared/canonicalize.mjs";
import { loadValidationContext } from "./validation.mjs";

const DEFAULT_FIXTURE = fileURLToPath(new URL("./fixtures/freshness/input.json", import.meta.url));

function argumentValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

export function parseArguments(argv = []) {
  const options = { dryRun: true, fixturePath: null, rootDir: process.cwd(), evaluatedAt: null };
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
      options.evaluatedAt = argumentValue(argv, index, argument);
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown option: ${argument}`);
  }
  return options;
}

async function readFixture(fixturePath) {
  const resolvedPath = path.resolve(fixturePath);
  const fixtureStats = await stat(resolvedPath);
  const inputPath = fixtureStats.isDirectory() ? path.join(resolvedPath, "input.json") : resolvedPath;
  return JSON.parse(await readFile(inputPath, "utf8"));
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "gallery-freshness-evaluator",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubRequest(url, { token, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`GitHub request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    const response = await fetchImpl(url, {
      headers: githubHeaders(token),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timeout);
  }
}

function linkedContentPath(canonicalSource) {
  const segments = new URL(canonicalSource).pathname.split("/").filter(Boolean);
  if (segments.length <= 2) return null;
  if ((segments[2] === "blob" || segments[2] === "tree") && segments.length > 4) {
    return segments.slice(4).join("/");
  }
  return segments.slice(2).join("/");
}

function decodeReadme(payload) {
  if (typeof payload?.content !== "string") return null;
  if (payload.encoding === "base64") {
    return Buffer.from(payload.content.replaceAll("\n", ""), "base64").toString("utf8");
  }
  return payload.content;
}

export async function fetchGitHubMetadata(
  record,
  { token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch, policy } = {},
) {
  const canonicalSource = canonicalizeUrl(record?.canonicalSource ?? record?.source ?? record?.website);
  const coordinates = repositoryCoordinates(canonicalSource);
  const observedAt = new Date().toISOString();
  const identity = { canonicalSource, observedAt };
  if (!coordinates) {
    return { ...identity, indeterminate: true, errorCode: "GITHUB_SOURCE_INVALID" };
  }
  if (!token) {
    return { ...identity, indeterminate: true, errorCode: "GITHUB_TOKEN_MISSING" };
  }
  if (typeof fetchImpl !== "function") {
    return { ...identity, indeterminate: true, errorCode: "GITHUB_FETCH_UNAVAILABLE" };
  }

  const timeoutMs = (policy?.http?.timeoutSeconds ?? 30) * 1000;
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repository)}`;
  let repositoryResponse;
  try {
    repositoryResponse = await githubRequest(apiRoot, { token, fetchImpl, timeoutMs });
  } catch (error) {
    return {
      ...identity,
      indeterminate: true,
      errorCode: error?.name === "AbortError" ? "GITHUB_TIMEOUT" : "GITHUB_REQUEST_FAILED",
    };
  }

  if (repositoryResponse.status === 404) {
    return { ...identity, availability: "deleted", authoritative: true, status: 404 };
  }
  if (!repositoryResponse.ok || !repositoryResponse.body) {
    return {
      ...identity,
      indeterminate: true,
      errorCode: `GITHUB_HTTP_${repositoryResponse.status}`,
    };
  }

  const contentPath = linkedContentPath(canonicalSource);
  const requests = {
    commits: `${apiRoot}/commits?per_page=100`,
    releases: `${apiRoot}/releases?per_page=20`,
    issues: `${apiRoot}/issues?state=all&sort=updated&direction=desc&per_page=30`,
    readme: `${apiRoot}/readme`,
    ...(contentPath ? { linkedPath: `${apiRoot}/contents/${contentPath.split("/").map(encodeURIComponent).join("/")}` } : {}),
  };
  const responses = await Promise.all(
    Object.entries(requests).map(async ([key, url]) => {
      try {
        return [key, await githubRequest(url, { token, fetchImpl, timeoutMs })];
      } catch {
        return [key, { status: 0, ok: false, body: null }];
      }
    }),
  );
  const results = Object.fromEntries(responses);
  const partial = Object.entries(results).some(([key, response]) => (
    !response.ok &&
    !((key === "readme" || key === "linkedPath") && response.status === 404) &&
    !(key === "commits" && response.status === 409)
  ));

  return {
    ...identity,
    repository: repositoryResponse.body,
    commits: results.commits.ok && Array.isArray(results.commits.body) ? results.commits.body : [],
    releases: results.releases.ok && Array.isArray(results.releases.body) ? results.releases.body : [],
    issues: results.issues.ok && Array.isArray(results.issues.body)
      ? results.issues.body.filter((item) => item.pull_request === undefined)
      : [],
    pulls: results.issues.ok && Array.isArray(results.issues.body)
      ? results.issues.body.filter((item) => item.pull_request !== undefined)
      : [],
    readme: results.readme.ok ? decodeReadme(results.readme.body) : null,
    linkedPathExists: contentPath ? results.linkedPath?.ok === true : true,
    partial,
  };
}

function summarize(report) {
  const summary = {
    applicable: 0,
    notApplicable: 0,
    healthy: 0,
    needsReview: 0,
    quarantined: 0,
    retired: 0,
    indeterminate: 0,
    proposedMutations: 0,
  };
  for (const entry of report.entries) {
    if (entry.applicability === "not-applicable") {
      summary.notApplicable += 1;
      continue;
    }
    summary.applicable += 1;
    const statusKey = {
      healthy: "healthy",
      "needs-review": "needsReview",
      quarantined: "quarantined",
      retired: "retired",
      indeterminate: "indeterminate",
    }[entry.health.status];
    summary[statusKey] += 1;
  }
  return summary;
}

function assertHealthSchema(context, healthSnapshot) {
  const validate = context.schemas.validators.get("health.schema.json");
  if (validate(healthSnapshot)) return;
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new TypeError(`Freshness report produced invalid health data: ${details}`);
}

export async function runFreshnessEvaluation({
  rootDir = process.cwd(),
  fixturePath = null,
  evaluatedAt = null,
  token = process.env.GITHUB_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  const context = await loadValidationContext(rootDir);
  const fixture = fixturePath ? await readFixture(fixturePath) : null;
  const records = fixture?.records ?? context.catalog;
  const policy = fixture?.policy ?? context.configs.policy;
  const health = fixture?.health ?? context.health;
  const reportTime = evaluatedAt ?? fixture?.evaluatedAt ?? new Date().toISOString();
  let githubMetadata = fixture?.githubMetadata ?? null;

  if (!fixture) {
    const githubRecords = records.filter(isGitHubBackedRecord);
    githubMetadata = await Promise.all(
      githubRecords.map((record) => fetchGitHubMetadata(record, { token, fetchImpl, policy })),
    );
  }

  const report = evaluateCatalogFreshness(records, {
    githubMetadata,
    policy,
    health,
    evaluatedAt: reportTime,
  });
  assertHealthSchema(context, report.healthSnapshot);
  return { ...report, summary: summarize(report) };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArguments(argv);
    const report = await runFreshnessEvaluation(options);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.summary.indeterminate > 0 && !options.fixturePath ? 1 : 0;
  } catch (error) {
    stderr.write(`${error?.message ?? error}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}