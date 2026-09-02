import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalizeUrl, inferSourceType } from "./validation.mjs";

function requireLegacyString(record, field, index) {
  const value = record?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Catalog record ${index} requires legacy field ${field}.`);
  }
  return value;
}

function migratePreview(record, index) {
  if (record?.preview === "") return "coming soon";
  return requireLegacyString(record, "preview", index);
}

export function stableLegacyId(canonicalSource, title) {
  const digest = createHash("sha256")
    .update(canonicalSource)
    .update("\0")
    .update(title)
    .digest("hex")
    .slice(0, 24);
  return `legacy-${digest}`;
}

function migrateRecord(record, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`Catalog record ${index} must be an object.`);
  }
  if (typeof record.id === "string") {
    for (const field of ["launchUrl", "publishedAt", "dateAdded", "lastVerified"]) {
      if (!Object.hasOwn(record, field)) {
        throw new TypeError(
          `Catalog record ${index} is versioned but missing ${field}; recover it from the legacy catalog.`,
        );
      }
    }
    return structuredClone(record);
  }

  const title = requireLegacyString(record, "title", index);
  const source = requireLegacyString(record, "source", index);
  const publishedAt = requireLegacyString(record, "date", index);
  const canonicalSource = canonicalizeUrl(source);
  if (!canonicalSource) {
    throw new TypeError(`Catalog record ${index} has an invalid legacy source URL.`);
  }

  return {
    id: stableLegacyId(canonicalSource, title),
    title,
    summary: requireLegacyString(record, "description", index),
    preview: migratePreview(record, index),
    launchUrl: source,
    canonicalSource,
    sourceType: inferSourceType(canonicalSource, record.tags),
    author: requireLegacyString(record, "author", index),
    sourceOwner: null,
    website: requireLegacyString(record, "website", index),
    tags: structuredClone(record.tags),
    publishedAt,
    dateAdded: null,
    lastVerified: null,
    lifecycleStatus: "active",
  };
}

export function migrateCatalog(catalog) {
  if (!Array.isArray(catalog)) {
    throw new TypeError("Catalog must be an array.");
  }
  return catalog.map(migrateRecord);
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const catalogPath = path.join(rootDir, "static", "templates.json");
  const original = process.argv.includes("--stdin")
    ? await readStdin()
    : await readFile(catalogPath, "utf8");
  const migrated = serializeCatalog(migrateCatalog(JSON.parse(original)));

  if (process.argv.includes("--check")) {
    if (migrated !== original) {
      throw new Error("Catalog migration is not idempotent; run migrate-catalog.mjs first.");
    }
    console.log("Catalog migration idempotence check passed.");
    return;
  }

  await writeFile(catalogPath, migrated, "utf8");
  console.log(`Migrated ${JSON.parse(migrated).length} catalog records to v2.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}