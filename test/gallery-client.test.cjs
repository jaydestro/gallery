const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(path.resolve(__dirname, relativePath), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  Function("module", "exports", "require", output)(loadedModule, loadedModule.exports, require);
  return loadedModule.exports;
}

const {
  GALLERY_SORT_OPTIONS,
  GalleryDataError,
  loadGalleryUsers,
  sortGalleryUsers,
} = loadTypeScriptModule("../src/data/galleryClient.ts");

const HASH = `sha256:${"a".repeat(64)}`;
const VALID_TAGS = ["featured", "example"];

function catalogItem(id, overrides = {}) {
  return {
    id,
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    preview: "coming soon",
    launchUrl: `https://example.test/${id}`,
    canonicalSource: `https://github.com/example/${id}`,
    sourceType: "github-repository",
    author: "Example",
    sourceOwner: "example",
    website: "https://example.test",
    tags: ["example"],
    publishedAt: "2026-08-01",
    dateAdded: null,
    lastVerified: "2026-08-28T00:00:00.000Z",
    lifecycleStatus: "active",
    supersededBy: null,
    ...overrides,
  };
}

function metadata(totalItems) {
  return {
    etag: '"catalog-etag"',
    snapshotId: "snapshot-42",
    catalogHash: HASH,
    totalItems,
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

function apiOptions(overrides = {}) {
  return {
    apiBaseUrl: "https://gallery-api.example.test/",
    useStaticCatalog: false,
    staticCatalog: [],
    validTags: VALID_TAGS,
    ...overrides,
  };
}

test("loads every gallery page and maps catalog fields to users", async () => {
  const calls = [];
  const pages = [
    {
      items: [catalogItem("alpha")],
      continuationToken: "next/+ token",
      metadata: metadata(2),
    },
    {
      items: [catalogItem("beta")],
      continuationToken: null,
      metadata: metadata(2),
    },
  ];
  const users = await loadGalleryUsers(apiOptions({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(pages.shift());
    },
  }));

  assert.deepEqual(users.map(({ id }) => id), ["alpha", "beta"]);
  assert.equal(users[0].description, "Summary alpha");
  assert.equal(users[0].source, "https://example.test/alpha");
  assert.equal(new URL(calls[0].url).searchParams.get("pageSize"), "100");
  assert.equal(new URL(calls[1].url).searchParams.get("continuationToken"), "next/+ token");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Accept, "application/json");
});

test("rejects response fields outside the strict envelope", async () => {
  await assert.rejects(
    loadGalleryUsers(apiOptions({
      fetchImpl: async () => jsonResponse({
        items: [catalogItem("alpha")],
        continuationToken: null,
        metadata: metadata(1),
        unexpected: true,
      }),
    })),
    (error) => error instanceof GalleryDataError && /invalid response/.test(error.message),
  );
});

test("accepts a valid empty gallery response", async () => {
  const users = await loadGalleryUsers(apiOptions({
    fetchImpl: async () => jsonResponse({
      items: [],
      continuationToken: null,
      metadata: metadata(0),
    }),
  }));

  assert.deepEqual(users, []);
});

test("rejects unknown tags, non-public lifecycle states, and extra item fields", async () => {
  for (const invalidItem of [
    catalogItem("alpha", { tags: ["unknown"] }),
    catalogItem("alpha", { lifecycleStatus: "retired" }),
    catalogItem("alpha", { unexpected: true }),
  ]) {
    await assert.rejects(
      loadGalleryUsers(apiOptions({
        fetchImpl: async () => jsonResponse({
          items: [invalidItem],
          continuationToken: null,
          metadata: metadata(1),
        }),
      })),
      (error) => error instanceof GalleryDataError && /invalid item/.test(error.message),
    );
  }
});

test("stops a repeated continuation-token loop", async () => {
  let callCount = 0;
  await assert.rejects(
    loadGalleryUsers(apiOptions({
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse({
          items: [catalogItem(callCount === 1 ? "alpha" : "beta")],
          continuationToken: "same-token",
          metadata: metadata(2),
        });
      },
    })),
    (error) => error instanceof GalleryDataError && /repeated continuation token/.test(error.message),
  );
  assert.equal(callCount, 2);
});

test("surfaces HTTP errors without silently using the static catalog", async () => {
  await assert.rejects(
    loadGalleryUsers(apiOptions({
      useStaticCatalog: true,
      staticCatalog: [catalogItem("static")],
      fetchImpl: async () => jsonResponse(null, { ok: false, status: 503 }),
    })),
    (error) => error instanceof GalleryDataError && /status 503/.test(error.message),
  );
});

test("uses bundled data only when static development mode is explicit", async () => {
  let fetchCalled = false;
  const users = await loadGalleryUsers({
    apiBaseUrl: undefined,
    useStaticCatalog: true,
    staticCatalog: [catalogItem("static")],
    validTags: VALID_TAGS,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("fetch should not run");
    },
  });

  assert.equal(fetchCalled, false);
  assert.deepEqual(users.map(({ id }) => id), ["static"]);

  await assert.rejects(
    loadGalleryUsers({
      apiBaseUrl: undefined,
      useStaticCatalog: false,
      staticCatalog: [catalogItem("static")],
      validTags: VALID_TAGS,
    }),
    (error) => error instanceof GalleryDataError && /not configured/.test(error.message),
  );
});

test("passes an abort signal through to fetch and preserves AbortError", async () => {
  const controller = new AbortController();
  const abortError = new Error("cancelled");
  abortError.name = "AbortError";

  const promise = loadGalleryUsers(apiOptions({
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      throw abortError;
    },
  }));
  controller.abort();

  await assert.rejects(promise, (error) => error === abortError);
});

test("sorts fetched users with the existing gallery semantics without mutation", () => {
  const users = [
    { ...catalogItem("charlie"), title: "Charlie", description: "", source: "" },
    { ...catalogItem("alpha"), title: "Alpha", description: "", source: "" },
    { ...catalogItem("bravo"), title: "Bravo", description: "", source: "" },
  ];

  assert.deepEqual(sortGalleryUsers(users).map(({ id }) => id), ["alpha", "bravo", "charlie"]);
  assert.deepEqual(
    sortGalleryUsers(users, GALLERY_SORT_OPTIONS[0]).map(({ id }) => id),
    ["bravo", "alpha", "charlie"],
  );
  assert.deepEqual(
    sortGalleryUsers(users, GALLERY_SORT_OPTIONS[1]).map(({ id }) => id),
    ["charlie", "alpha", "bravo"],
  );
  assert.deepEqual(
    sortGalleryUsers(users, GALLERY_SORT_OPTIONS[3]).map(({ id }) => id),
    ["charlie", "bravo", "alpha"],
  );
  assert.deepEqual(users.map(({ id }) => id), ["charlie", "alpha", "bravo"]);
});