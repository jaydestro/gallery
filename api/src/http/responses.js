const { ApiError } = require("../domain/api-error");

const CACHE_CONTROL = "public, max-age=60, must-revalidate";

function galleryItemsResponse(result) {
  const headers = {
    "Cache-Control": CACHE_CONTROL,
    ETag: result.metadata.etag,
  };
  if (result.statusCode === 304) return { status: 304, headers };
  return {
    status: 200,
    headers,
    jsonBody: {
      items: result.items,
      continuationToken: result.continuationToken,
      metadata: result.metadata,
    },
  };
}

function mappedError(error) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.status < 500 ? error.message : "The gallery service is temporarily unavailable.",
    };
  }
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return { status: 504, code: "DEPENDENCY_TIMEOUT", message: "The gallery service timed out." };
  }
  const dependencyStatus = Number(error?.statusCode ?? error?.status);
  if ([401, 403, 404, 408, 409, 412, 429].includes(dependencyStatus) || dependencyStatus >= 500) {
    return {
      status: dependencyStatus === 408 ? 504 : 503,
      code: dependencyStatus === 408 ? "DEPENDENCY_TIMEOUT" : "DEPENDENCY_UNAVAILABLE",
      message: dependencyStatus === 408
        ? "The gallery service timed out."
        : "The gallery service is temporarily unavailable.",
    };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "The gallery service failed." };
}

function errorResponse(error, context) {
  const mapped = mappedError(error);
  if (typeof context?.error === "function") {
    context.error("Gallery API request failed.", { code: mapped.code, status: mapped.status });
  }
  return {
    status: mapped.status,
    headers: { "Cache-Control": "no-store" },
    jsonBody: { error: { code: mapped.code, message: mapped.message } },
  };
}

module.exports = { CACHE_CONTROL, errorResponse, galleryItemsResponse, mappedError };