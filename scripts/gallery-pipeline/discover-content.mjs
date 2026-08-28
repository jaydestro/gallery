#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCandidateGates } from "./candidate-gates.mjs";
import { createFixtureTransport, runDiscovery } from "./discovery.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_FIXTURE_DIRECTORY = path.join(SCRIPT_DIRECTORY, "fixtures/live-discovery");

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

export async function runReportOnlyPipeline(inputs, {
  runDiscoveryImpl = runDiscovery,
  runCandidateGatesImpl = runCandidateGates,
} = {}) {
  const {
    trustedSources,
    activeCatalog,
    retiredCatalog,
    policy,
    githubToken,
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
    discoveredAt,
    limits,
    fetchOptions: { fetchImpl, lookup },
  });
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
  });
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
    writeFile(path.join(directory, "discovery.json"), `${JSON.stringify(result.discovery, null, 2)}\n`),
    writeFile(
      path.join(directory, "candidate-gates.json"),
      `${JSON.stringify(result.candidateGates, null, 2)}\n`,
    ),
  ]);
}

export async function main(
  arguments_ = process.argv.slice(2),
  {
    stdout = process.stdout,
    env = process.env,
    runDiscoveryImpl = runDiscovery,
    runCandidateGatesImpl = runCandidateGates,
  } = {},
) {
  const options = parseArguments(arguments_);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0, result: null };
  }

  const inputs = options.fixtureDirectory
    ? await loadFixtureInputs(options.fixtureDirectory)
    : await loadLiveInputs(env);
  const result = await runReportOnlyPipeline(inputs, {
    runDiscoveryImpl,
    runCandidateGatesImpl,
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