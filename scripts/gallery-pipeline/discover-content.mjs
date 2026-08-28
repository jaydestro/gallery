#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixtureTransport, runDiscovery } from "./discovery.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");
const DEFAULT_FIXTURE_DIRECTORY = path.join(SCRIPT_DIRECTORY, "fixtures/live-discovery");

function usage() {
  return [
    "Usage: node scripts/gallery-pipeline/discover-content.mjs [--dry-run] [--fixtures [directory]]",
    "",
    "Runs trusted-source discovery in dry-run mode and writes JSON to stdout.",
    "--fixtures uses deterministic offline transport fixtures; no catalog files are modified.",
  ].join("\n");
}

function parseArguments(arguments_) {
  let fixtureDirectory = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") continue;
    if (argument === "--help" || argument === "-h") return { help: true, fixtureDirectory: null };
    if (argument === "--write" || argument === "--apply" || argument === "--mutate") {
      throw new TypeError(`${argument} is not supported; discovery is always a dry run`);
    }
    if (argument === "--fixtures") {
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
      fixtureDirectory = path.resolve(argument.slice("--fixtures=".length));
      continue;
    }
    throw new TypeError(`Unknown argument: ${argument}`);
  }
  return { help: false, fixtureDirectory };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadLiveInputs() {
  const [trustedSources, activeCatalog, retiredCatalog] = await Promise.all([
    readJson(path.join(REPOSITORY_ROOT, ".github/gallery-pipeline/trusted-sources.json")),
    readJson(path.join(REPOSITORY_ROOT, "static/templates.json")),
    readJson(path.join(REPOSITORY_ROOT, "static/retired-templates.json")),
  ]);
  return { trustedSources, activeCatalog, retiredCatalog };
}

async function loadFixtureInputs(directory) {
  const [trustedSources, activeCatalog, retiredCatalog, responses, options] = await Promise.all([
    readJson(path.join(directory, "trusted-sources.json")),
    readJson(path.join(directory, "active.json")),
    readJson(path.join(directory, "retired.json")),
    readJson(path.join(directory, "responses.json")),
    readJson(path.join(directory, "options.json")),
  ]);
  const transport = createFixtureTransport(responses);
  return {
    trustedSources,
    activeCatalog,
    retiredCatalog,
    githubToken: options.githubToken,
    discoveredAt: options.discoveredAt,
    limits: options.limits,
    fetchOptions: {
      fetchImpl: transport.fetchImpl,
      lookup: transport.lookup,
    },
  };
}

export async function main(
  arguments_ = process.argv.slice(2),
  { stdout = process.stdout, env = process.env } = {},
) {
  const options = parseArguments(arguments_);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0, result: null };
  }

  const inputs = options.fixtureDirectory
    ? await loadFixtureInputs(options.fixtureDirectory)
    : { ...(await loadLiveInputs()), githubToken: env.GITHUB_TOKEN };
  const result = await runDiscovery(inputs);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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