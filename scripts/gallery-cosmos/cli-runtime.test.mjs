import assert from "node:assert/strict";
import test from "node:test";

import {
  CosmosCliError,
  loadCosmosConfiguration,
  openCosmosContainers,
  parseCliArguments,
  safeError,
} from "./cli-runtime.mjs";

const environment = Object.freeze({
  AZURE_COSMOS_ENDPOINT: "https://gallery.documents.azure.com:443/",
  AZURE_COSMOS_DATABASE: "gallery",
  AZURE_COSMOS_CATALOG_CONTAINER: "catalog-items",
  AZURE_COSMOS_PUBLIC_CONTAINER: "public-catalog",
});
const canonicalEndpoint = "https://gallery.documents.azure.com/";
const containers = Object.freeze({
  catalog: Object.freeze({
    environmentName: "AZURE_COSMOS_CATALOG_CONTAINER",
    expected: "catalog-items",
  }),
  public: Object.freeze({
    environmentName: "AZURE_COSMOS_PUBLIC_CONTAINER",
    expected: "public-catalog",
  }),
});

test("parses value arguments and mutually exclusive dry-run modes", () => {
  assert.deepEqual(parseCliArguments(["--input", "catalog.json", "--dry-run"]), {
    input: "catalog.json",
    "dry-run": true,
  });
  assert.throws(
    () => parseCliArguments(["--dry-run", "--verify"]),
    (error) => error instanceof CosmosCliError && error.code === "CLI_ARGUMENT_INVALID",
  );
  assert.throws(() => parseCliArguments(["--input", "one", "--input", "two"]), /Duplicate/);
});

test("validates exact Cosmos endpoint, database, containers, and credential mode", () => {
  const local = loadCosmosConfiguration({ environment, containers });
  assert.deepEqual(local, {
    endpoint: canonicalEndpoint,
    database: "gallery",
    credentialMode: "default",
    containers: { catalog: "catalog-items", public: "public-catalog" },
  });

  const github = loadCosmosConfiguration({
    environment: {
      ...environment,
      GITHUB_ACTIONS: "true",
      AZURE_COSMOS_CREDENTIAL: "azure-cli",
    },
    containers,
  });
  assert.equal(github.credentialMode, "azure-cli");

  for (const invalid of [
    { ...environment, AZURE_COSMOS_ENDPOINT: "http://gallery.documents.azure.com/" },
    { ...environment, AZURE_COSMOS_ENDPOINT: "https://gallery.documents.azure.com/db" },
    { ...environment, AZURE_COSMOS_PUBLIC_CONTAINER: "catalog-items" },
    { ...environment, AZURE_COSMOS_CATALOG_CONTAINER: "wrong-catalog" },
    { ...environment, GITHUB_ACTIONS: "true" },
    { ...environment, GITHUB_ACTIONS: "true", AZURE_COSMOS_CREDENTIAL: "default" },
  ]) {
    assert.throws(
      () => loadCosmosConfiguration({ environment: invalid, containers }),
      (error) => error instanceof CosmosCliError && error.code === "COSMOS_CONFIG_INVALID",
    );
  }
});

test("constructs Cosmos with an explicit token credential and exposes only adapters", () => {
  const calls = [];
  class FakeAzureCliCredential {}
  class FakeDefaultAzureCredential {}
  class FakeCosmosClient {
    constructor(options) {
      calls.push({ method: "client", options });
    }

    database(databaseId) {
      calls.push({ method: "database", databaseId });
      return {
        container(containerId) {
          calls.push({ method: "container", containerId });
          return {
            items: {
              create() {},
              query() {},
            },
            item() {},
          };
        },
      };
    }
  }

  const configuration = loadCosmosConfiguration({
    environment: { ...environment, AZURE_COSMOS_CREDENTIAL: "azure-cli" },
    containers,
  });
  const runtime = openCosmosContainers(configuration, {
    CosmosClientClass: FakeCosmosClient,
    AzureCliCredentialClass: FakeAzureCliCredential,
    DefaultAzureCredentialClass: FakeDefaultAzureCredential,
  });

  assert(calls[0].options.aadCredentials instanceof FakeAzureCliCredential);
  assert.equal(calls[0].options.endpoint, canonicalEndpoint);
  assert.deepEqual(calls.filter(({ method }) => method === "container").map(({ containerId }) => containerId), [
    "catalog-items",
    "public-catalog",
  ]);
  assert.deepEqual(Object.keys(runtime.containers), ["catalog", "public"]);
  assert.equal(JSON.stringify(runtime).includes("token"), false);
});

test("redacts sensitive values from structured CLI errors", () => {
  const error = new Error("request failed for bearer-secret and https://gallery.documents.azure.com:443/");
  error.code = "REQUEST_FAILED";
  assert.deepEqual(safeError(error, [
    "bearer-secret",
    "https://gallery.documents.azure.com:443/",
  ]), {
    code: "REQUEST_FAILED",
    message: "request failed for [REDACTED] and [REDACTED]",
  });
});