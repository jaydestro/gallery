import assert from "node:assert/strict";
import test from "node:test";

import { safeFetch } from "./shared/safe-fetch.mjs";

const publicLookup = async () => [{ address: "20.12.34.56", family: 4 }];

test("safe fetch permits bounded HTTPS responses from exact trusted hosts", async () => {
  const result = await safeFetch("https://api.github.com/repos/example/demo", {
    trustedHosts: ["api.github.com"],
    lookup: publicLookup,
    fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
    maxBytes: 64,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.json(), { ok: true });
  assert.equal(result.bytes, 11);
});

test("safe fetch rejects insecure URLs, credentials, literal IPs, and private DNS results", async () => {
  const options = {
    trustedHosts: ["api.github.com"],
    lookup: publicLookup,
    fetchImpl: async () => new Response("ok"),
  };

  await assert.rejects(safeFetch("http://api.github.com/repos/example/demo", options), /only permits HTTPS/);
  await assert.rejects(
    safeFetch("https://user:secret@api.github.com/repos/example/demo", options),
    /containing credentials/,
  );
  await assert.rejects(
    safeFetch("https://127.0.0.1/data", { ...options, trustedHosts: ["127.0.0.1"] }),
    /literal IP addresses/,
  );
  await assert.rejects(
    safeFetch("https://[::1]/data", { ...options, trustedHosts: ["[::1]"] }),
    /literal IP addresses/,
  );
  await assert.rejects(
    safeFetch("https://api.github.com/data", {
      ...options,
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    /private or link-local address/,
  );
});

test("safe fetch validates the allowlist after every redirect", async () => {
  let calls = 0;
  await assert.rejects(
    safeFetch("https://api.github.com/start", {
      trustedHosts: ["api.github.com"],
      lookup: publicLookup,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/escaped" },
        });
      },
    }),
    /untrusted hostname: example.com/,
  );
  assert.equal(calls, 1);
});

test("safe fetch enforces response byte, redirect, and time limits", async () => {
  await assert.rejects(
    safeFetch("https://api.github.com/data", {
      trustedHosts: ["api.github.com"],
      lookup: publicLookup,
      fetchImpl: async () => new Response("too large"),
      maxBytes: 3,
    }),
    /byte limit/,
  );

  await assert.rejects(
    safeFetch("https://api.github.com/loop", {
      trustedHosts: ["api.github.com"],
      lookup: publicLookup,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "/loop" } }),
      maxRedirects: 1,
    }),
    /exceeded 1 redirects/,
  );

  await assert.rejects(
    safeFetch("https://api.github.com/slow", {
      trustedHosts: ["api.github.com"],
      lookup: publicLookup,
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      timeoutMs: 10,
    }),
    /timed out after 10ms/,
  );

  await assert.rejects(
    safeFetch("https://api.github.com/dns-stall", {
      trustedHosts: ["api.github.com"],
      lookup: async () => new Promise(() => {}),
      fetchImpl: async () => new Response("unreachable"),
      timeoutMs: 10,
    }),
    /timed out after 10ms/,
  );
});