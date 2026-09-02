import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { detectExactDuplicates } from "./detect-duplicates.mjs";
import { normalizeCandidates } from "./normalize.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/discovery/duplicates.json", import.meta.url), "utf8"),
);

test("detects exact identities and canonical URLs across active, retired, and incoming records", () => {
  const result = detectExactDuplicates(normalizeCandidates(fixture.candidates), {
    active: normalizeCandidates(fixture.active),
    retired: normalizeCandidates(fixture.retired),
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].sourceId, "101");
  assert.equal(result.duplicates.length, 3);

  const bySourceId = new Map(result.duplicates.map((duplicate) => [duplicate.candidate.sourceId, duplicate]));
  assert.deepEqual(bySourceId.get("6IIUtEFKJec").reasons, ["identity-key", "canonical-url"]);
  assert.deepEqual(
    bySourceId.get("https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/").reasons,
    ["identity-key", "canonical-url"],
  );
  assert.deepEqual(bySourceId.get("202").reasons, ["canonical-url"]);
  assert.equal(bySourceId.get("202").matches[0].scope, "incoming");
});

test("fails closed when a candidate lacks an exact identity field", () => {
  assert.throws(
    () => detectExactDuplicates([{ canonicalUrl: "https://example.com/item" }]),
    /missing identityKey/,
  );
});