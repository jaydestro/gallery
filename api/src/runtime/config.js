const { ApiError } = require("../domain/api-error");

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(500, "CONFIGURATION_INVALID", `${name} is required.`);
  }
  return value.trim();
}

function requireGuid(value, name) {
  if (!GUID_PATTERN.test(value)) {
    throw new ApiError(500, "CONFIGURATION_INVALID", `${name} must be a GUID.`);
  }
  return value;
}

function requireRootEndpoint(value, name, hostnameSuffix) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(500, "CONFIGURATION_INVALID", `${name} must be an HTTPS endpoint.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !url.hostname.toLowerCase().endsWith(hostnameSuffix)
  ) {
    throw new ApiError(500, "CONFIGURATION_INVALID", `${name} must be an approved HTTPS root endpoint.`);
  }
  return url.origin;
}

function loadRuntimeConfig(environment = process.env) {
  return Object.freeze({
    managedIdentityClientId: requireGuid(
      requiredValue(environment, "AZURE_CLIENT_ID"),
      "AZURE_CLIENT_ID",
    ),
    cosmosEndpoint: requireRootEndpoint(
      requiredValue(environment, "AZURE_COSMOS_ENDPOINT"),
      "AZURE_COSMOS_ENDPOINT",
      ".documents.azure.com",
    ),
    cosmosDatabase: requiredValue(environment, "AZURE_COSMOS_DATABASE"),
    publicContainer: requiredValue(environment, "AZURE_COSMOS_PUBLIC_CONTAINER"),
    storageAccountName: requiredValue(environment, "AZURE_STORAGE_ACCOUNT_NAME"),
    rateLimitTableName: requiredValue(environment, "GALLERY_RATE_LIMIT_TABLE"),
    foundryEndpoint: requireRootEndpoint(
      requiredValue(environment, "AZURE_FOUNDRY_ENDPOINT"),
      "AZURE_FOUNDRY_ENDPOINT",
      ".services.ai.azure.com",
    ),
    foundryDeployment: requiredValue(environment, "AZURE_FOUNDRY_DEPLOYMENT"),
    apimPrincipalId: requireGuid(
      requiredValue(environment, "GALLERY_APIM_PRINCIPAL_ID"),
      "GALLERY_APIM_PRINCIPAL_ID",
    ).toLowerCase(),
  });
}

module.exports = { loadRuntimeConfig };