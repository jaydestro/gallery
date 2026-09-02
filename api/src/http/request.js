const { ApiError } = require("../domain/api-error");
const { headerValue } = require("../auth/easy-auth");
const { validateContinuationToken, validatePageSize } = require("../services/gallery-items-service");

const MAX_CHAT_BODY_BYTES = 8192;
const MAX_QUESTION_CHARACTERS = 1000;

function oneQueryValue(query, name) {
  if (!query || typeof query.getAll !== "function") return null;
  const values = query.getAll(name);
  if (values.length > 1) {
    throw new ApiError(400, "QUERY_PARAMETER_INVALID", `${name} may be specified only once.`);
  }
  return values.length === 1 ? values[0] : null;
}

function parseGalleryItemsRequest(request) {
  const rawPageSize = oneQueryValue(request?.query, "pageSize");
  const pageSize = rawPageSize === null ? 50 : Number(rawPageSize);
  if (rawPageSize !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawPageSize)) {
    throw new ApiError(400, "PAGE_SIZE_INVALID", "pageSize must be an integer from 1 through 100.");
  }
  validatePageSize(pageSize);
  const continuationToken = validateContinuationToken(
    oneQueryValue(request?.query, "continuationToken"),
    { request: true },
  );
  return Object.freeze({
    pageSize,
    continuationToken,
    ifNoneMatch: headerValue(request?.headers, "if-none-match"),
  });
}

function parseContentLength(headers) {
  const value = headerValue(headers, "content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(400, "CONTENT_LENGTH_INVALID", "Content-Length is invalid.");
  }
  return Number(value);
}

async function readChatRequest(request) {
  const contentType = headerValue(request?.headers, "content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ApiError(415, "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json.");
  }
  const contentLength = parseContentLength(request.headers);
  if (contentLength !== null && contentLength > MAX_CHAT_BODY_BYTES) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "The request body exceeds 8192 bytes.");
  }
  if (typeof request.arrayBuffer !== "function") {
    throw new ApiError(400, "REQUEST_BODY_INVALID", "The request body is unavailable.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_CHAT_BODY_BYTES) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "The request body exceeds 8192 bytes.");
  }
  let body;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "REQUEST_BODY_INVALID", "The request body must be valid JSON.");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "question") ||
    typeof body.question !== "string"
  ) {
    throw new ApiError(400, "REQUEST_BODY_INVALID", "The request body must contain only question.");
  }
  const question = body.question.trim();
  if (question.length === 0 || question.length > MAX_QUESTION_CHARACTERS) {
    throw new ApiError(
      400,
      "QUESTION_INVALID",
      `question must contain 1 through ${MAX_QUESTION_CHARACTERS} characters.`,
    );
  }
  return Object.freeze({ question });
}

module.exports = {
  MAX_CHAT_BODY_BYTES,
  MAX_QUESTION_CHARACTERS,
  parseGalleryItemsRequest,
  readChatRequest,
};