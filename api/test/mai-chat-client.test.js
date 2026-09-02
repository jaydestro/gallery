const assert = require("node:assert/strict");
const test = require("node:test");

const { ApiError } = require("../src/domain/api-error");
const {
  COGNITIVE_SERVICES_SCOPE,
  createMaiChatClient,
} = require("../src/adapters/mai-chat-client");

const TOKEN = "fixture-secret-token";

function successfulResponse(content = '{"answer":"Found it.","citationIds":[]}') {
  return {
    ok: true,
    async json() {
      return {
        choices: [{ finish_reason: "stop", message: { content } }],
      };
    },
  };
}

test("calls the MAI endpoint with managed-identity bearer auth and bounded documented fields", async () => {
  const calls = [];
  const credential = {
    async getToken(scope, options) {
      calls.push({ method: "getToken", scope, options });
      return { token: TOKEN };
    },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ method: "fetch", url, options });
    return successfulResponse();
  };
  const client = createMaiChatClient({
    credential,
    endpoint: "https://gallery.services.ai.azure.com",
    deployment: "gallery-mai-thinking-1",
    fetchImpl,
  });
  const output = await client.complete({
    systemInstructions: "System",
    input: "Input",
    maxCompletionTokens: 800,
    signal: AbortSignal.timeout(1000),
  });

  assert.equal(output, '{"answer":"Found it.","citationIds":[]}');
  assert.equal(calls[0].scope, COGNITIVE_SERVICES_SCOPE);
  assert.equal(calls[1].url, "https://gallery.services.ai.azure.com/mai/v1/chat/completions");
  assert.equal(calls[1].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(Object.hasOwn(calls[1].options.headers, "api-key"), false);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    model: "gallery-mai-thinking-1",
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Input" },
    ],
    max_completion_tokens: 800,
  });
  assert.equal(output.includes(TOKEN), false);
});

test("fails closed on malformed or unsuccessful model responses without exposing the token", async () => {
  const credential = { async getToken() { return { token: TOKEN }; } };
  const malformed = createMaiChatClient({
    credential,
    endpoint: "https://gallery.services.ai.azure.com",
    deployment: "gallery-mai-thinking-1",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ finish_reason: "length", message: { content: "partial" } }] };
      },
    }),
  });
  await assert.rejects(
    malformed.complete({
      systemInstructions: "System",
      input: "Input",
      maxCompletionTokens: 800,
    }),
    (error) => error instanceof ApiError && error.code === "MODEL_OUTPUT_INVALID",
  );

  const failed = createMaiChatClient({
    credential,
    endpoint: "https://gallery.services.ai.azure.com",
    deployment: "gallery-mai-thinking-1",
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(
    failed.complete({
      systemInstructions: "System",
      input: "Input",
      maxCompletionTokens: 800,
    }),
    (error) => (
      error instanceof ApiError &&
      error.code === "MODEL_REQUEST_FAILED" &&
      !error.message.includes(TOKEN)
    ),
  );
});