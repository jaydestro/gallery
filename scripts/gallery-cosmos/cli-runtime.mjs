import { readFile } from "node:fs/promises";

import { CosmosClient } from "@azure/cosmos";
import { AzureCliCredential, DefaultAzureCredential } from "@azure/identity";

import { createAzureContainerAdapter } from "./azure-container-adapter.mjs";

const ROOT_PATHS = new Set(["", "/"]);
const CONTAINER_ID_PATTERN = /^[^/\\?#]{1,255}$/;
const CREDENTIAL_MODES = new Set(["azure-cli", "default"]);
const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;

export class CosmosCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CosmosCliError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CosmosCliError(code, message);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail("COSMOS_CONFIG_INVALID", `${name} is required.`);
  }
  return value.trim();
}

function validateEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail("COSMOS_CONFIG_INVALID", "AZURE_COSMOS_ENDPOINT must be an absolute HTTPS URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !ROOT_PATHS.has(endpoint.pathname)
  ) {
    fail("COSMOS_CONFIG_INVALID", "AZURE_COSMOS_ENDPOINT must be a credential-free HTTPS account root.");
  }
  return endpoint.href;
}

function validateContainerId(value, environmentName, expected) {
  if (!CONTAINER_ID_PATTERN.test(value)) {
    fail("COSMOS_CONFIG_INVALID", `${environmentName} is not a valid Cosmos container ID.`);
  }
  if (expected && value !== expected) {
    fail("COSMOS_CONFIG_INVALID", `${environmentName} must be ${expected}.`);
  }
  return value;
}

export function parseCliArguments(argv, { booleanFlags = ["dry-run", "verify"] } = {}) {
  const flags = new Set(booleanFlags);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") || argument.length === 2) {
      fail("CLI_ARGUMENT_INVALID", `Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    if (Object.hasOwn(options, name)) {
      fail("CLI_ARGUMENT_INVALID", `Duplicate argument: --${name}`);
    }
    if (flags.has(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("CLI_ARGUMENT_INVALID", `--${name} requires a value.`);
    }
    options[name] = value;
    index += 1;
  }
  if (options["dry-run"] && options.verify) {
    fail("CLI_ARGUMENT_INVALID", "--dry-run and --verify are mutually exclusive.");
  }
  return Object.freeze(options);
}

export function loadCosmosConfiguration({
  environment = process.env,
  containers = {},
}) {
  const endpoint = validateEndpoint(requiredEnvironment(environment, "AZURE_COSMOS_ENDPOINT"));
  const database = requiredEnvironment(environment, "AZURE_COSMOS_DATABASE");
  if (!CONTAINER_ID_PATTERN.test(database)) {
    fail("COSMOS_CONFIG_INVALID", "AZURE_COSMOS_DATABASE is not a valid Cosmos database ID.");
  }
  const credentialMode = environment.AZURE_COSMOS_CREDENTIAL?.trim() || (
    environment.GITHUB_ACTIONS === "true" ? "" : "default"
  );
  if (!CREDENTIAL_MODES.has(credentialMode)) {
    fail(
      "COSMOS_CONFIG_INVALID",
      "AZURE_COSMOS_CREDENTIAL must be azure-cli or default; GitHub Actions must set it explicitly.",
    );
  }
  if (environment.GITHUB_ACTIONS === "true" && credentialMode !== "azure-cli") {
    fail("COSMOS_CONFIG_INVALID", "GitHub Actions must use AzureCliCredential after azure/login.");
  }

  const resolvedContainers = {};
  for (const [name, specification] of Object.entries(containers)) {
    const environmentName = specification.environmentName;
    const value = requiredEnvironment(environment, environmentName);
    resolvedContainers[name] = validateContainerId(value, environmentName, specification.expected);
  }
  if (new Set(Object.values(resolvedContainers)).size !== Object.keys(resolvedContainers).length) {
    fail("COSMOS_CONFIG_INVALID", "Required Cosmos containers must be distinct.");
  }
  return Object.freeze({
    endpoint,
    database,
    credentialMode,
    containers: Object.freeze(resolvedContainers),
  });
}

export function createCredential(
  credentialMode,
  {
    AzureCliCredentialClass = AzureCliCredential,
    DefaultAzureCredentialClass = DefaultAzureCredential,
  } = {},
) {
  if (credentialMode === "azure-cli") return new AzureCliCredentialClass();
  if (credentialMode === "default") {
    return new DefaultAzureCredentialClass({ excludeInteractiveBrowserCredential: true });
  }
  fail("COSMOS_CONFIG_INVALID", `Unsupported credential mode: ${credentialMode}`);
}

export function openCosmosContainers(
  configuration,
  {
    CosmosClientClass = CosmosClient,
    AzureCliCredentialClass = AzureCliCredential,
    DefaultAzureCredentialClass = DefaultAzureCredential,
  } = {},
) {
  const credential = createCredential(configuration.credentialMode, {
    AzureCliCredentialClass,
    DefaultAzureCredentialClass,
  });
  const client = new CosmosClientClass({
    endpoint: configuration.endpoint,
    aadCredentials: credential,
    userAgentSuffix: "gallery-cosmos-operations",
  });
  const database = client.database(configuration.database);
  const containers = Object.freeze(Object.fromEntries(
    Object.entries(configuration.containers).map(([name, containerId]) => [
      name,
      createAzureContainerAdapter(database.container(containerId)),
    ]),
  ));
  return Object.freeze({ client, containers });
}

export async function readJsonFile(filePath, label, { maxBytes = DEFAULT_MAX_JSON_BYTES } = {}) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    fail("CLI_INPUT_READ_FAILED", `Could not read ${label}: ${error.message}`);
  }
  if (bytes.length > maxBytes) {
    fail("CLI_INPUT_TOO_LARGE", `${label} exceeds ${maxBytes} bytes.`);
  }
  try {
    return Object.freeze({ bytes, value: JSON.parse(bytes.toString("utf8")) });
  } catch {
    fail("CLI_INPUT_INVALID", `${label} must contain valid JSON.`);
  }
}

export function safeError(error, sensitiveValues = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value) message = message.replaceAll(value, "[REDACTED]");
  }
  return Object.freeze({
    code: typeof error?.code === "string" ? error.code : "COSMOS_CLI_FAILED",
    message,
  });
}

export function writeJsonResult(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}

export async function runCli(operation, {
  output = process.stdout,
  errorOutput = process.stderr,
  sensitiveValues = [],
} = {}) {
  try {
    const result = await operation();
    writeJsonResult(output, result);
    return 0;
  } catch (error) {
    writeJsonResult(errorOutput, safeError(error, sensitiveValues));
    return 1;
  }
}