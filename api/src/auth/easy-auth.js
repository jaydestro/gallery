const { ApiError } = require("../domain/api-error");

const MAX_PRINCIPAL_HEADER_LENGTH = 16384;
const ROLE_CLAIM_TYPES = new Set([
  "role",
  "roles",
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
]);

function headerValue(headers, name) {
  if (!headers || typeof headers.get !== "function") return null;
  const value = headers.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function decodePrincipal(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_PRINCIPAL_HEADER_LENGTH ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)
  ) {
    throw new ApiError(401, "AUTHENTICATION_INVALID", "The authenticated principal is malformed.");
  }
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const principal = JSON.parse(decoded);
    if (!principal || typeof principal !== "object" || !Array.isArray(principal.claims)) {
      throw new Error("Principal claims are missing.");
    }
    return principal;
  } catch {
    throw new ApiError(401, "AUTHENTICATION_INVALID", "The authenticated principal is malformed.");
  }
}

function principalRoles(principal) {
  return new Set(principal.claims
    .filter((claim) => {
      const type = typeof claim?.typ === "string" ? claim.typ.toLowerCase() : "";
      return ROLE_CLAIM_TYPES.has(type) && typeof claim.val === "string";
    })
    .map((claim) => claim.val));
}

function authorizeEasyAuth({ headers, expectedPrincipalId, requiredRole = "Chat.Invoke" }) {
  const principalId = headerValue(headers, "x-ms-client-principal-id");
  const encodedPrincipal = headerValue(headers, "x-ms-client-principal");
  if (!principalId || !encodedPrincipal) {
    throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  if (principalId.toLowerCase() !== expectedPrincipalId.toLowerCase()) {
    throw new ApiError(403, "PRINCIPAL_FORBIDDEN", "The authenticated principal is not allowed.");
  }
  const principal = decodePrincipal(encodedPrincipal);
  if (!principalRoles(principal).has(requiredRole)) {
    throw new ApiError(403, "ROLE_FORBIDDEN", "The required application role is missing.");
  }
  return Object.freeze({ principalId: principalId.toLowerCase(), role: requiredRole });
}

module.exports = { authorizeEasyAuth, decodePrincipal, headerValue };