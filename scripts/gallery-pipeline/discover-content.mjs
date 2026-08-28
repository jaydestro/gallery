#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCandidateGates } from "./candidate-gates.mjs";
import { createFixtureTransport, runDiscovery } from "./discovery.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_FIXTURE_DIRECTORY = path.join(SCRIPT_DIRECTORY, "fixtures/live-discovery");
const DEFAULT_OPERATION_DEADLINE_SECONDS = 20 * 60;
const WORKFLOW_DEADLINE_ENVIRONMENT_VARIABLE = "GALLERY_DISCOVERY_DEADLINE_MILLISECONDS";
let temporaryReportSequence = 0;

function usage() {
  return [
    "Usage: node scripts/gallery-pipeline/discover-content.mjs [--dry-run] [--fixtures [directory]] [--report-directory directory]",
    "",
    "Runs trusted-source discovery and candidate gates without mutation.",
    "By default, writes one combined JSON report to stdout.",
    "--report-directory writes discovery.json and candidate-gates.json instead.",
    "--fixtures uses deterministic offline transport fixtures.",
  ].join("\n");
}

function parseArguments(arguments_) {
  let help = false;
  let fixtureDirectory = null;
  let fixtureSpecified = false;
  let reportDirectory = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--write" || argument === "--apply" || argument === "--mutate") {
      throw new TypeError(`${argument} is not supported; discovery is always a dry run`);
    }
    if (argument === "--fixtures") {
      if (fixtureSpecified) throw new TypeError("--fixtures may only be specified once");
      fixtureSpecified = true;
      const value = arguments_[index + 1];
      if (value && !value.startsWith("--")) {
        fixtureDirectory = path.resolve(value);
        index += 1;
      } else {
        fixtureDirectory = DEFAULT_FIXTURE_DIRECTORY;
      }
      continue;
    }
    if (argument.startsWith("--fixtures=")) {
      if (fixtureSpecified) throw new TypeError("--fixtures may only be specified once");
      const value = argument.slice("--fixtures=".length);
      if (!value) throw new TypeError("--fixtures requires a directory after =");
      fixtureSpecified = true;
      fixtureDirectory = path.resolve(value);
      continue;
    }
    if (argument === "--report-directory") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new TypeError("--report-directory requires a directory");
      }
      if (reportDirectory !== null) {
        throw new TypeError("--report-directory may only be specified once");
      }
      reportDirectory = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--report-directory=")) {
      const value = argument.slice("--report-directory=".length);
      if (!value) throw new TypeError("--report-directory requires a directory");
      if (reportDirectory !== null) {
        throw new TypeError("--report-directory may only be specified once");
      }
      reportDirectory = path.resolve(value);
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }
  return { help, fixtureDirectory, reportDirectory };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadLiveInputs(env) {
  const [trustedSources, activeCatalog, retiredCatalog, policy] = await Promise.all([
    readJson(path.join(REPOSITORY_ROOT, ".github/gallery-pipeline/trusted-sources.json")),
    readJson(path.join(REPOSITORY_ROOT, "static/templates.json")),
    readJson(path.join(REPOSITORY_ROOT, "static/retired-templates.json")),
    readJson(path.join(REPOSITORY_ROOT, ".github/gallery-pipeline/policy.json")),
  ]);
  return {
    trustedSources,
    activeCatalog,
    retiredCatalog,
    policy,
    githubToken: env.GITHUB_TOKEN,
    environment: typeof env.YOUTUBE_API_KEY === "string"
      ? { YOUTUBE_API_KEY: env.YOUTUBE_API_KEY }
      : {},
    fetchImpl: globalThis.fetch,
    lookup: undefined,
  };
}

async function loadFixtureInputs(directory) {
  const [trustedSources, activeCatalog, retiredCatalog, policy, responses, options] = await Promise.all([
    readJson(path.join(directory, "trusted-sources.json")),
    readJson(path.join(directory, "active.json")),
    readJson(path.join(directory, "retired.json")),
    readJson(path.join(directory, "policy.json")),
    readJson(path.join(directory, "responses.json")),
    readJson(path.join(directory, "options.json")),
  ]);
  const transport = createFixtureTransport(responses);
  const lookup = Array.isArray(options.lookup)
    ? async () => structuredClone(options.lookup)
    : transport.lookup;
  return {
    trustedSources,
    activeCatalog,
    retiredCatalog,
    policy,
    githubToken: options.githubToken,
    environment: options.environment ?? {},
    discoveredAt: options.discoveredAt,
    limits: options.limits,
    fetchImpl: transport.fetchImpl,
    lookup,
  };
}

function combinedStatus(discoveryStatus, candidateGateStatus) {
  if (discoveryStatus === "complete" && candidateGateStatus === "complete") return "complete";
  if (discoveryStatus === "indeterminate" || candidateGateStatus === "indeterminate") {
    return "indeterminate";
  }
  return "partial";
}

function diagnosticTimestamp(value) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw new TypeError("now must return a valid timestamp");
  return timestamp.toISOString();
}

function operationDeadlineSeconds(policy) {
  const value = policy?.discovery?.operationDeadlineSeconds ??
    DEFAULT_OPERATION_DEADLINE_SECONDS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("policy.discovery.operationDeadlineSeconds must be positive");
  }
  return value;
}

function workflowDeadlineMilliseconds(env) {
  const value = env?.[WORKFLOW_DEADLINE_ENVIRONMENT_VARIABLE];
  if (value === undefined || value === "") return Number.POSITIVE_INFINITY;
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${WORKFLOW_DEADLINE_ENVIRONMENT_VARIABLE} must be an epoch millisecond integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${WORKFLOW_DEADLINE_ENVIRONMENT_VARIABLE} must be an epoch millisecond integer`);
  }
  return parsed;
}

function resolveOperationDeadline({ env, operationStartedMilliseconds, policy }) {
  return Math.min(
    operationStartedMilliseconds + operationDeadlineSeconds(policy) * 1000,
    workflowDeadlineMilliseconds(env),
  );
}

async function writeJsonAtomic(filePath, value) {
  temporaryReportSequence += 1;
  const temporaryPath = `${filePath}.${process.pid}.${temporaryReportSequence}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeDiscoveryReport(directory, discovery) {
  await writeJsonAtomic(path.join(directory, "discovery.json"), discovery);
}

async function writeCandidateGateReport(directory, candidateGates) {
  await writeJsonAtomic(path.join(directory, "candidate-gates.json"), candidateGates);
}

export async function initializeDiagnosticReports(directory, { now = Date.now } = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const timestamp = diagnosticTimestamp(now());
  const discovery = {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: "partial",
    startedAt: timestamp,
    completedAt: timestamp,
    summary: {
      sources: 0,
      succeededSources: 0,
      skippedSources: 0,
      indeterminateSources: 0,
      candidates: 0,
      rejected: 0,
    },
    candidates: [],
    rejected: [],
    sources: [],
    evidence: [],
  };
  const candidateGates = {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: "partial",
    startedAt: timestamp,
    completedAt: timestamp,
    summary: {
      candidates: 0,
      availabilityChecks: 0,
      indeterminateAvailabilityChecks: 0,
      deadlineExceededAvailabilityChecks: 0,
      eligible: 0,
      rejected: 0,
    },
    eligible: [],
    rejected: [],
  };
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeDiscoveryReport(directory, discovery),
    writeCandidateGateReport(directory, candidateGates),
  ]);
  return { discovery, candidateGates };
}

export async function runReportOnlyPipeline(inputs, {
  runDiscoveryImpl = runDiscovery,
  runCandidateGatesImpl = runCandidateGates,
  onDiscoveryComplete = async () => {},
  onCandidateGatesComplete = async () => {},
  deadlineMilliseconds,
  now = Date.now,
} = {}) {
  const {
    trustedSources,
    activeCatalog,
    retiredCatalog,
    policy,
    githubToken,
    environment,
    discoveredAt,
    limits,
    fetchImpl,
    lookup,
  } = inputs;
  const discovery = await runDiscoveryImpl({
    trustedSources,
    activeCatalog,
    retiredCatalog,
    githubToken,
    environment,
    discoveredAt,
    limits,
    deadlineMilliseconds,
    now,
    fetchOptions: { fetchImpl, lookup, deadlineMilliseconds, now },
  });
  await onDiscoveryComplete(discovery);
  const candidateGates = await runCandidateGatesImpl({
    discovery,
    trustedSources,
    activeCatalog,
    retiredCatalog,
    policy,
    checkedAt: discovery.completedAt,
    token: githubToken,
    fetchImpl,
    lookup,
    deadlineMilliseconds,
    now,
  });
  await onCandidateGatesComplete(candidateGates);
  return {
    schemaVersion: "1.0.0",
    mode: "dry-run",
    mutationPerformed: false,
    status: combinedStatus(discovery.status, candidateGates.status),
    startedAt: discovery.startedAt,
    completedAt: candidateGates.completedAt,
    discovery,
    candidateGates,
  };
}

async function writeReports(directory, result) {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeDiscoveryReport(directory, result.discovery),
    writeCandidateGateReport(directory, result.candidateGates),
  ]);
}

export async function main(
  arguments_ = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    runDiscoveryImpl = runDiscovery,
    runCandidateGatesImpl = runCandidateGates,
    now = Date.now,
  } = {},
) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const operationStartedMilliseconds = now();
  const options = parseArguments(arguments_);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0, result: null };
  }

  if (options.reportDirectory) {
    await initializeDiagnosticReports(options.reportDirectory, {
      now: () => operationStartedMilliseconds,
    });
  }

  const inputs = options.fixtureDirectory
    ? await loadFixtureInputs(options.fixtureDirectory)
    : await loadLiveInputs(env);
  const deadlineMilliseconds = resolveOperationDeadline({
    env,
    operationStartedMilliseconds,
    policy: inputs.policy,
  });
  const result = await runReportOnlyPipeline(inputs, {
    runDiscoveryImpl,
    runCandidateGatesImpl,
    onDiscoveryComplete: options.reportDirectory
      ? (discovery) => writeDiscoveryReport(options.reportDirectory, discovery)
      : undefined,
    onCandidateGatesComplete: options.reportDirectory
      ? (candidateGates) => writeCandidateGateReport(options.reportDirectory, candidateGates)
      : undefined,
    deadlineMilliseconds,
    now,
  });
  if (options.reportDirectory) {
    await writeReports(options.reportDirectory, result);
  } else {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return { exitCode: result.status === "complete" ? 0 : 2, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { exitCode } = await main();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}