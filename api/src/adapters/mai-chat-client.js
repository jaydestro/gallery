const { ApiError } = require("../domain/api-error");

const COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";

function malformedOutput(message) {
  throw new ApiError(502, "MODEL_OUTPUT_INVALID", message);
}

function parseMaiResponse(data) {
  if (!Array.isArray(data?.choices) || data.choices.length !== 1) {
    malformedOutput("MAI must return exactly one choice.");
  }
  const choice = data.choices[0];
  if (!choice || typeof choice !== "object" || choice.finish_reason !== "stop") {
    malformedOutput("MAI did not finish normally.");
  }
  const message = choice.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    malformedOutput("MAI returned an invalid message.");
  }
  if (message.refusal !== undefined && message.refusal !== null) {
    throw new ApiError(502, "MODEL_REFUSAL", "MAI refused the request.");
  }
  if (
    message.tool_calls !== undefined &&
    message.tool_calls !== null &&
    (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)
  ) {
    malformedOutput("MAI returned tool calls.");
  }
  if (typeof message.content !== "string" || message.content.trim() === "" || message.content.includes("```")) {
    malformedOutput("MAI returned malformed content.");
  }
  return message.content;
}

function createMaiChatClient({ credential, endpoint, deployment, fetchImpl = globalThis.fetch }) {
  if (typeof credential?.getToken !== "function") throw new TypeError("credential.getToken is required.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  if (typeof endpoint !== "string" || typeof deployment !== "string" || deployment.trim() === "") {
    throw new TypeError("A Foundry endpoint and deployment are required.");
  }

  return Object.freeze({
    async complete({ systemInstructions, input, maxCompletionTokens, signal }) {
      if (
        typeof systemInstructions !== "string" ||
        typeof input !== "string" ||
        !Number.isSafeInteger(maxCompletionTokens) ||
        maxCompletionTokens < 1 ||
        maxCompletionTokens > 800
      ) {
        throw new TypeError("The MAI request is invalid.");
      }
      const accessToken = await credential.getToken(COGNITIVE_SERVICES_SCOPE, { abortSignal: signal });
      if (typeof accessToken?.token !== "string" || accessToken.token === "") {
        throw new ApiError(503, "MODEL_AUTHENTICATION_FAILED", "Managed identity returned no token.");
      }
      const response = await fetchImpl(`${endpoint}/mai/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: deployment,
          messages: [
            { role: "system", content: systemInstructions },
            { role: "user", content: input },
          ],
          max_completion_tokens: maxCompletionTokens,
        }),
        signal,
      });
      if (!response?.ok) {
        throw new ApiError(502, "MODEL_REQUEST_FAILED", "MAI request failed.");
      }
      let data;
      try {
        data = await response.json();
      } catch {
        malformedOutput("MAI returned malformed JSON.");
      }
      return parseMaiResponse(data);
    },
  });
}

module.exports = { COGNITIVE_SERVICES_SCOPE, createMaiChatClient, parseMaiResponse };