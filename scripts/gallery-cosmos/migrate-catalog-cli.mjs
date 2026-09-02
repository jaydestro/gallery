#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateExecutionProvenance } from "./artifact-contract.mjs";
import { canonicalHash, gallerySnapshotFromRecords } from "./canonical.mjs";
import {
  CosmosCliError,
  loadCosmosConfiguration,
  openCosmosContainers,
  parseCliArguments,
  readJsonFile,
  runCli,
} from "./cli-runtime.mjs";
import {
  migrateCatalogAndPublicCreateOnly,
  verifyCatalogMigration,
} from "./migrate-catalog.mjs";
import { assertGalleryCatalog } from "./schemas.mjs";

const ROOT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_PATH = ".github/workflows/migrate-gallery-catalog.yml";
const CONTAINERS = Object.freeze({
  catalog: Object.freeze({
    environmentName: "AZURE_COSMOS_CATALOG_CONTAINER",
    expected: "catalog-items",
  }),
  public: Object.freeze({
    environmentName: "AZURE_COSMOS_PUBLIC_CONTAINER",
    expected: "public-catalog",
  }),
});
const ALLOWED_ARGUMENTS = new Set([
  "dry-run",
  "input",
  "operation-id",
  "provenance",
  "published-at",
  "snapshot-id",
  "verify",
]);

function requireArguments(options) {
  for (const name of Object.keys(options)) {
    if (!ALLOWED_ARGUMENTS.has(name)) throw new CosmosCliError("CLI_ARGUMENT_INVALID", `Unknown argument: --${name}`);
  }
  if (!options.provenance) throw new CosmosCliError("CLI_ARGUMENT_INVALID", "--provenance is required.");
  if (!options["published-at"]) throw new CosmosCliError("CLI_ARGUMENT_INVALID", "--published-at is required.");
  if (Number.isNaN(Date.parse(options["published-at"]))) {
    throw new CosmosCliError("CLI_ARGUMENT_INVALID", "--published-at must be a date-time.");
  }
}

function bytesHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function executeMigration({
  argv,
  environment = process.env,
  rootDirectory = ROOT_DIRECTORY,
  openContainers = openCosmosContainers,
}) {
  const options = parseCliArguments(argv);
  requireArguments(options);
  const configuration = loadCosmosConfiguration({ environment, containers: CONTAINERS });
  const inputPath = path.resolve(rootDirectory, options.input ?? "static/templates.json");
  const provenancePath = path.resolve(rootDirectory, options.provenance);
  const [input, provenanceInput] = await Promise.all([
    readJsonFile(inputPath, "catalog migration input"),
    readJsonFile(provenancePath, "catalog migration provenance"),
  ]);
  assertGalleryCatalog(input.value);
  const provenance = validateExecutionProvenance(provenanceInput.value, { workflowPath: WORKFLOW_PATH });
  const inputDigest = bytesHash(input.bytes);
  if (provenance.artifactDigest !== inputDigest) {
    throw new CosmosCliError("ARTIFACT_PROVENANCE_INVALID", "Migration provenance does not bind the exact input bytes.");
  }
  const source = gallerySnapshotFromRecords(input.value);
  const snapshotId = options["snapshot-id"] ?? `migration-${source.hash.slice(7, 39)}`;
  const operationId = options["operation-id"] ?? `migration:static-templates:${source.hash.slice(-24)}`;
  const summary = {
    mode: options["dry-run"] ? "dry-run" : options.verify ? "verify" : "write",
    count: source.count,
    hash: source.hash,
    snapshotId,
    operationId,
    provenanceHash: canonicalHash(provenance),
  };
  if (options["dry-run"]) return Object.freeze(summary);

  const { containers } = openContainers(configuration);
  if (options.verify) {
    return Object.freeze({
      ...summary,
      ...await verifyCatalogMigration({
        records: input.value,
        catalogContainer: containers.catalog,
        publicContainer: containers.public,
        snapshotId,
      }),
    });
  }
  return Object.freeze({
    ...summary,
    ...await migrateCatalogAndPublicCreateOnly({
      records: input.value,
      catalogContainer: containers.catalog,
      publicContainer: containers.public,
      provenance,
      operationId,
      snapshotId,
      publishedAt: options["published-at"],
    }),
  });
}

export async function main(argv = process.argv.slice(2)) {
  return runCli(() => executeMigration({ argv }), {
    sensitiveValues: [process.env.AZURE_COSMOS_ENDPOINT],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}