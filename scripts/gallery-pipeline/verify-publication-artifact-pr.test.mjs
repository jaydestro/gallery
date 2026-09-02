import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PublicationPullRequestError,
  verifyPublicationPullRequest,
} from "./verify-publication-artifact-pr.mjs";

function blob(bytes) {
  const value = Buffer.from(bytes);
  return {
    sha: createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex"),
    size: value.length,
    encoding: "base64",
    content: value.toString("base64"),
  };
}

function fixture() {
  const values = new Map([
    [".github/gallery-pipeline/catalog-change-plan.json", Buffer.from("{\"plan\":true}\n")],
    ["static/templates.json", Buffer.from("[]\n")],
  ]);
  const manifest = {
    schemaVersion: "1.0.0",
    publishable: true,
    paths: [...values].map(([filePath, bytes]) => ({
      path: filePath,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    })),
  };
  const files = [...values].map(([filename, bytes]) => {
    const apiBlob = blob(bytes);
    return {
      filename,
      status: filename.startsWith(".github/") ? "added" : "modified",
      previousFilename: null,
      sha: apiBlob.sha,
      blob: apiBlob,
    };
  });
  return { manifest, files };
}

function expectCode(code) {
  return (error) => error instanceof PublicationPullRequestError && error.code === code;
}

test("accepts only API blobs whose Git and SHA-256 bytes exactly match the verified batch", () => {
  const input = fixture();
  const result = verifyPublicationPullRequest(input);

  assert.equal(result.files, 2);
  assert.deepEqual(result.paths, [
    ".github/gallery-pipeline/catalog-change-plan.json",
    "static/templates.json",
  ]);
});

test("rejects unexpected, missing, duplicate, removed, and renamed paths", () => {
  const mutations = [
    (input) => { input.files[0].filename = "static/unexpected.json"; },
    (input) => { input.files.pop(); },
    (input) => { input.files[1].filename = input.files[0].filename; },
    (input) => { input.files[0].status = "removed"; },
    (input) => { input.files[0].status = "renamed"; input.files[0].previousFilename = "old.json"; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyPublicationPullRequest(input), expectCode("PR_PATH_SET_INVALID"));
  }
});

test("rejects malformed base64, API size drift, blob SHA drift, and file-to-blob substitution", () => {
  const cases = [
    ["base64", (input) => { input.files[0].blob.content = "***"; }],
    ["size", (input) => { input.files[0].blob.size += 1; }],
    ["blob sha", (input) => { input.files[0].blob.sha = "f".repeat(40); input.files[0].sha = "f".repeat(40); }],
    ["substitution", (input) => { input.files[0].sha = input.files[1].sha; }],
  ];
  for (const [name, mutate] of cases) {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyPublicationPullRequest(input), expectCode("BLOB_INVALID"), name);
  }
});

test("rejects valid Git blobs whose bytes differ from the verified artifact", () => {
  const input = fixture();
  const replacement = blob("{\"forged\":true}\n");
  input.files[0].sha = replacement.sha;
  input.files[0].blob = replacement;

  assert.throws(() => verifyPublicationPullRequest(input), expectCode("PR_BYTES_MISMATCH"));
});

test("rejects malformed or duplicated manifest paths and digests", () => {
  const mutations = [
    (input) => { input.manifest.paths[0].path = "../escape.json"; },
    (input) => { input.manifest.paths[1].path = input.manifest.paths[0].path; },
    (input) => { input.manifest.paths[0].digest = "f".repeat(64); },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyPublicationPullRequest(input), expectCode("MANIFEST_INVALID"));
  }
});