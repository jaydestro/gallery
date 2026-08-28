import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { main } from "./discover-content.mjs";

const FIXTURE_DIRECTORY = fileURLToPath(new URL("./fixtures/live-discovery/", import.meta.url));

function outputBuffer() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    value() { return value; },
  };
}

test("--fixtures runs a deterministic, stdout-only dry run", async () => {
  const activePath = fileURLToPath(new URL("./fixtures/live-discovery/active.json", import.meta.url));
  const before = await readFile(activePath, "utf8");
  const firstOutput = outputBuffer();
  const first = await main(["--fixtures", FIXTURE_DIRECTORY], { stdout: firstOutput.stream, env: {} });
  const secondOutput = outputBuffer();
  const second = await main(["--fixtures", FIXTURE_DIRECTORY], { stdout: secondOutput.stream, env: {} });

  assert.equal(first.exitCode, 0);
  assert.equal(first.result.mode, "dry-run");
  assert.equal(first.result.mutationPerformed, false);
  assert.equal(first.result.status, "complete");
  assert.equal(first.result.candidates.length, 2);
  assert.ok(first.result.rejected.some((item) => item.reason === "exact-duplicate"));
  assert.equal(firstOutput.value(), secondOutput.value());
  assert.deepEqual(first.result, second.result);
  assert.equal(await readFile(activePath, "utf8"), before);
});

test("CLI rejects every catalog mutation flag", async () => {
  await assert.rejects(main(["--write"], { stdout: outputBuffer().stream, env: {} }), /always a dry run/);
});