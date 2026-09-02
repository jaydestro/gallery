const { CosmosClient } = require("@azure/cosmos");
const { TableClient } = require("@azure/data-tables");
const { ManagedIdentityCredential } = require("@azure/identity");

const { createCosmosPublicCatalogRepository } = require("../adapters/cosmos-public-catalog-repository");
const { createMaiChatClient } = require("../adapters/mai-chat-client");
const { createTableRateLimiter } = require("../adapters/table-rate-limiter");
const { createGalleryChatService } = require("../services/gallery-chat-service");
const { createGalleryItemsService } = require("../services/gallery-items-service");
const { loadRuntimeConfig } = require("./config");

let singletonServices;

function createRuntimeServices({
  environment = process.env,
  Credential = ManagedIdentityCredential,
  CosmosClientType = CosmosClient,
  TableClientType = TableClient,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = loadRuntimeConfig(environment);
  const credential = new Credential({ clientId: config.managedIdentityClientId });
  const cosmosClient = new CosmosClientType({
    endpoint: config.cosmosEndpoint,
    aadCredentials: credential,
    userAgentSuffix: "gallery-function-api",
  });
  const container = cosmosClient
    .database(config.cosmosDatabase)
    .container(config.publicContainer);
  const publicCatalogRepository = createCosmosPublicCatalogRepository(container);
  const rateLimitTableClient = new TableClientType(
    `https://${config.storageAccountName}.table.core.windows.net`,
    config.rateLimitTableName,
    credential,
  );
  const modelClient = createMaiChatClient({
    credential,
    endpoint: config.foundryEndpoint,
    deployment: config.foundryDeployment,
    fetchImpl,
  });
  return Object.freeze({
    config,
    credential,
    cosmosClient,
    itemsService: createGalleryItemsService({ publicCatalogRepository }),
    chatService: createGalleryChatService({ publicCatalogRepository, modelClient }),
    rateLimiter: createTableRateLimiter({ tableClient: rateLimitTableClient }),
  });
}

function getRuntimeServices() {
  singletonServices ??= createRuntimeServices();
  return singletonServices;
}

module.exports = { createRuntimeServices, getRuntimeServices };