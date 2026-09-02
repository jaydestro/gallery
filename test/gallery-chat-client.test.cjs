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
  askGalleryChat,
  GalleryChatError,
  MAX_GALLERY_CHAT_QUESTION_CHARACTERS,
} = loadTypeScriptModule("../src/data/galleryChatClient.ts");
const { MAX_QUESTION_CHARACTERS } = require("../api/src/http/request");

function validResponse(overrides = {}) {
  return {
    answer: "Try the Alpha sample.",
    citations: [
      { id: "alpha", title: "Alpha sample", launchUrl: "https://example.test/alpha" },
    ],
    ...overrides,
  };
}

function jsonResponse(body, { ok = true } = {}) {
  return {
    ok,
    async json() {
      return body;
    },
  };
}

test("posts one trimmed question without credentials and accepts the strict response", async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await askGalleryChat({
    apiBaseUrl: "https://gallery-api.example.test/",
    question: "  Find an Alpha sample  ",
    signal: controller.signal,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(validResponse());
    },
  });

  assert.deepEqual(result, validResponse());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gallery-api.example.test/gallery/chat");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Accept, "application/json");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.body, '{"question":"Find an Alpha sample"}');
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.signal, controller.signal);
});

test("enforces the API question length before making a request", async () => {
  assert.equal(MAX_GALLERY_CHAT_QUESTION_CHARACTERS, MAX_QUESTION_CHARACTERS);
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse(validResponse());
  };

  for (const question of ["   ", "x".repeat(MAX_GALLERY_CHAT_QUESTION_CHARACTERS + 1)]) {
    await assert.rejects(
      askGalleryChat({ apiBaseUrl: "https://gallery-api.example.test", question, fetchImpl }),
      GalleryChatError,
    );
  }
  assert.equal(fetchCount, 0);

  await askGalleryChat({
    apiBaseUrl: "https://gallery-api.example.test",
    question: "x".repeat(MAX_GALLERY_CHAT_QUESTION_CHARACTERS),
    fetchImpl,
  });
  assert.equal(fetchCount, 1);
});

test("rejects extra or malformed response and citation fields", async () => {
  const malformedResponses = [
    { ...validResponse(), unexpected: true },
    validResponse({ answer: "" }),
    validResponse({ citations: {} }),
    validResponse({ citations: [{ ...validResponse().citations[0], unexpected: true }] }),
    validResponse({ citations: [{ id: "alpha", title: "Alpha sample", launchUrl: "javascript:alert(1)" }] }),
    validResponse({ citations: [validResponse().citations[0], validResponse().citations[0]] }),
  ];

  for (const body of malformedResponses) {
    await assert.rejects(
      askGalleryChat({
        apiBaseUrl: "https://gallery-api.example.test",
        question: "Find Alpha",
        fetchImpl: async () => jsonResponse(body),
      }),
      (error) => error instanceof GalleryChatError && /temporarily unavailable/.test(error.message),
    );
  }
});

test("uses a generic retryable error without reading or exposing a server body", async () => {
  let bodyRead = false;
  await assert.rejects(
    askGalleryChat({
      apiBaseUrl: "https://gallery-api.example.test",
      question: "Find Alpha",
      fetchImpl: async () => ({
        ok: false,
        async json() {
          bodyRead = true;
          return { error: { message: "private upstream details" } };
        },
      }),
    }),
    (error) => {
      assert.equal(error.message, "The gallery assistant is temporarily unavailable. Please try again.");
      assert.equal(error.message.includes("private upstream details"), false);
      return true;
    },
  );
  assert.equal(bodyRead, false);
});

test("preserves AbortError so cancelled requests do not become visible failures", async () => {
  const abortError = new Error("cancelled");
  abortError.name = "AbortError";

  await assert.rejects(
    askGalleryChat({
      apiBaseUrl: "https://gallery-api.example.test",
      question: "Find Alpha",
      fetchImpl: async () => {
        throw abortError;
      },
    }),
    (error) => error === abortError,
  );
});