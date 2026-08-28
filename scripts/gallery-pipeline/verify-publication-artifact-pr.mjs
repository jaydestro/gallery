#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ALLOWED_PATHS = new Set([
  ".github/gallery-pipeline/catalog-change-plan.json",
  "static/templates.json",
  "static/gallery-health.json",
  "static/retired-templates.json",
  "static/catalog-audit.json",
]);

export class PublicationPullRequestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PublicationPullRequestError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new PublicationPullRequestError(code, message, details);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("VALUE_INVALID", `${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(requireObject(value, label)).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    fail("VALUE_INVALID", `${label} fields do not match the required contract.`);
  }
}

function decodeBlob(blob, label) {
  requireExactKeys(blob, ["sha", "size", "encoding", "content"], label);
  if (!SHA1_PATTERN.test(blob.sha) || blob.encoding !== "base64") {
    fail("BLOB_INVALID", `${label} has invalid identity or encoding.`);
  }
  if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_FILE_BYTES) {
    fail("BLOB_INVALID", `${label} has an invalid size.`);
  }
  if (typeof blob.content !== "string") {
    fail("BLOB_INVALID", `${label} content must be a base64 string.`);
  }
  const encoded = blob.content.replaceAll(/\s/g, "");
  if (!BASE64_PATTERN.test(encoded)) {
    fail("BLOB_INVALID", `${label} content is not canonical base64.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== blob.size) {
    fail("BLOB_INVALID", `${label} decoded size does not match its API size.`);
  }
  const gitHash = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (gitHash !== blob.sha) {
    fail("BLOB_INVALID", `${label} content does not match its Git blob SHA.`);
  }
  return bytes;
}

function expectedManifestPaths(manifest) {
  requireObject(manifest, "publication manifest");
  if (
    manifest.schemaVersion !== "1.0.0" ||
    manifest.publishable !== true ||
    !Array.isArray(manifest.paths)
  ) {
    fail("MANIFEST_INVALID", "The publication manifest is invalid.");
  }
  if (manifest.paths.length < 2 || manifest.paths.length > MAX_FILES) {
    fail("MANIFEST_INVALID", "The publication manifest path count is outside the bounded batch limit.");
  }
  const expected = new Map();
  for (const [index, entry] of manifest.paths.entries()) {
    requireExactKeys(entry, ["path", "digest"], `manifest.paths[${index}]`);
    if (
      typeof entry.path !== "string" ||
      entry.path === "" ||
      path.posix.normalize(entry.path) !== entry.path ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.split("/").some((segment) => segment === "." || segment === "..") ||
      !ALLOWED_PATHS.has(entry.path) ||
      !SHA256_PATTERN.test(entry.digest) ||
      expected.has(entry.path)
    ) {
      fail("MANIFEST_INVALID", `Publication manifest path ${entry.path} is invalid or duplicated.`);
    }
    expected.set(entry.path, entry.digest);
  }
  return expected;
}

export function verifyPublicationPullRequest({ manifest, files } = {}) {
  const expected = expectedManifestPaths(manifest);
  if (!Array.isArray(files) || files.length !== expected.size || files.length > MAX_FILES) {
    fail("PR_PATH_SET_INVALID", "Pull request files do not match the publication manifest path count.");
  }
  const seen = new Set();
  for (const [index, file] of files.entries()) {
    requireExactKeys(file, ["filename", "status", "previousFilename", "sha", "blob"], `files[${index}]`);
    if (
      typeof file.filename !== "string" ||
      seen.has(file.filename) ||
      !expected.has(file.filename) ||
      !["added", "modified"].includes(file.status) ||
      file.previousFilename !== null ||
      !SHA1_PATTERN.test(file.sha)
    ) {
      fail("PR_PATH_SET_INVALID", `Pull request file ${file.filename} is missing, duplicated, renamed, removed, or unexpected.`);
    }
    if (file.blob?.sha !== file.sha) {
      fail("BLOB_INVALID", `Pull request file ${file.filename} does not bind its requested blob.`);
    }
    const bytes = decodeBlob(file.blob, `files[${index}].blob`);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== expected.get(file.filename)) {
      fail("PR_BYTES_MISMATCH", `Pull request file ${file.filename} does not match the verified publication bytes.`);
    }
    seen.add(file.filename);
  }
  if (!isDeepStrictEqual([...seen].sort(), [...expected.keys()].sort())) {
    fail("PR_PATH_SET_INVALID", "Pull request file paths are not exact.");
  }
  return {
    files: seen.size,
    paths: [...seen].sort(),
    message: `Publication pull request verification passed: ${seen.size} files exactly match the verified artifact batch.`,
  };
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    fail("FILE_READ_FAILED", `Could not read ${label}: ${error.message}`);
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = {
      "--manifest": "manifestPath",
      "--pr-files": "filesPath",
    }[argument];
    if (!key || options[key] || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      fail("ARGUMENT_INVALID", `Invalid or duplicate argument ${argument}.`);
    }
    options[key] = argv[index + 1];
    index += 1;
  }
  if (!options.manifestPath || !options.filesPath) {
    fail("ARGUMENT_INVALID", "--manifest and --pr-files are required.");
  }
  return options;
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArguments(argv);
    const result = verifyPublicationPullRequest({
      manifest: await readJson(options.manifestPath, "publication manifest"),
      files: await readJson(options.filesPath, "pull request files"),
    });
    stdout.write(`${result.message}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Publication pull request verification failed [${error.code ?? "ERROR"}]: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}