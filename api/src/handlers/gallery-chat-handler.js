const { authorizeEasyAuth } = require("../auth/easy-auth");
const { readChatRequest } = require("../http/request");
const { errorResponse } = require("../http/responses");

function createGalleryChatHandler({ service, rateLimiter, expectedPrincipalId }) {
  if (typeof service?.answer !== "function") {
    throw new TypeError("service.answer must be a function.");
  }
  if (typeof rateLimiter?.consume !== "function") {
    throw new TypeError("rateLimiter.consume must be a function.");
  }
  if (typeof expectedPrincipalId !== "string" || expectedPrincipalId === "") {
    throw new TypeError("expectedPrincipalId is required.");
  }
  return async function galleryChatHandler(request, context) {
    try {
      authorizeEasyAuth({ headers: request.headers, expectedPrincipalId });
      const { question } = await readChatRequest(request);
      await rateLimiter.consume(request.headers.get("x-gallery-client-ip"));
      const response = await service.answer({ question, signal: request.signal });
      return {
        status: 200,
        headers: { "Cache-Control": "no-store" },
        jsonBody: response,
      };
    } catch (error) {
      return errorResponse(error, context);
    }
  };
}

module.exports = { createGalleryChatHandler };