import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIRECTORY = path.resolve(TEST_DIRECTORY, "../..");
const INFRA_DIRECTORY = path.join(ROOT_DIRECTORY, "infra");
const MODULE_DIRECTORY = path.join(INFRA_DIRECTORY, "modules");

async function readInfra(relativePath) {
  return readFile(path.join(INFRA_DIRECTORY, relativePath), "utf8");
}

function resourceBlocks(source) {
  const blocks = new Map();
  const declaration = /resource\s+([A-Za-z][A-Za-z0-9_]*)\s+'([^']+)'\s*=\s*\{/g;
  for (const match of source.matchAll(declaration)) {
    const openingBrace = match.index + match[0].length - 1;
    let depth = 0;
    let inString = false;
    let closingBrace = -1;

    for (let index = openingBrace; index < source.length; index += 1) {
      const character = source[index];
      if (character === "'") {
        if (inString && source[index + 1] === "'") {
          index += 1;
          continue;
        }
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth === 0) {
        closingBrace = index;
        break;
      }
    }

    assert.notEqual(closingBrace, -1, `Unterminated resource ${match[1]}`);
    blocks.set(match[1], {
      symbol: match[1],
      type: match[2],
      source: source.slice(openingBrace, closingBrace + 1),
    });
  }
  return blocks;
}

function block(blocks, symbol) {
  assert.ok(blocks.has(symbol), `Missing resource ${symbol}`);
  return blocks.get(symbol).source;
}

function quotedValues(source, prefix) {
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `Missing ${prefix}`);
  const arrayStart = source.indexOf("[", start);
  const arrayEnd = source.indexOf("]", arrayStart);
  assert.notEqual(arrayStart, -1, `Missing array for ${prefix}`);
  assert.notEqual(arrayEnd, -1, `Unterminated array for ${prefix}`);
  return [...source.slice(arrayStart, arrayEnd + 1).matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);
}

test("subscription entry point pins the approved resource group, region, tags, and modules", async () => {
  const main = await readInfra("main.bicep");
  const parameters = await readInfra("main.bicepparam");

  assert.match(main, /^targetScope = 'subscription'$/m);
  assert.match(main, /param location string = 'centralus'/);
  assert.match(main, /param resourceGroupName string = 'rg-cosmos-gallery-dev'/);
  assert.match(main, /param alertEmail string = 'jagord@microsoft.com'/);
  assert.match(main, /param budgetStartDate string = utcNow\('yyyy-MM-01'\)/);
  for (const [key, value] of Object.entries({
    application: "gallery",
    environment: "dev",
    owner: "jaydestro",
    repository: "https://github.com/jaydestro/gallery",
    "managed-by": "bicep",
  })) {
    assert.match(main, new RegExp(`(?:'${key}'|${key}): '${value.replaceAll("/", "\\/")}'`));
  }

  const modules = [...main.matchAll(/module\s+\w+\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(modules.sort(), [
    "./modules/alerts.bicep",
    "./modules/api-management.bicep",
    "./modules/api.bicep",
    "./modules/cosmos.bicep",
    "./modules/foundry.bicep",
    "./modules/identities.bicep",
    "./modules/observability.bicep",
  ]);

  assert.match(parameters, /^using '\.\/main\.bicep'$/m);
  assert.match(parameters, /param location = 'centralus'/);
  assert.match(parameters, /param resourceGroupName = 'rg-cosmos-gallery-dev'/);
  assert.match(parameters, /param alertEmail = 'jagord@microsoft.com'/);
});

test("Foundry account and MAI deployment match the approved contract exactly", async () => {
  const source = await readInfra("modules/foundry.bicep");
  const resources = resourceBlocks(source);
  const account = block(resources, "foundryAccount");
  const deployment = block(resources, "modelDeployment");

  assert.equal(resources.get("foundryAccount").type, "Microsoft.CognitiveServices/accounts@2025-06-01");
  assert.match(account, /name: 'aif-gallery-dev-jgd826'/);
  assert.match(account, /kind: 'AIServices'/);
  assert.match(account, /type: 'SystemAssigned'/);
  assert.match(account, /name: 'S0'/);
  assert.match(account, /customSubDomainName: 'aif-gallery-dev-jgd826'/);
  assert.match(account, /disableLocalAuth: true/);
  assert.match(account, /publicNetworkAccess: 'Enabled'/);

  assert.equal(
    resources.get("modelDeployment").type,
    "Microsoft.CognitiveServices/accounts/deployments@2024-10-01",
  );
  assert.match(deployment, /name: 'gallery-mai-thinking-1'/);
  assert.match(deployment, /name: 'GlobalStandard'/);
  assert.match(deployment, /capacity: 10/);
  assert.match(deployment, /format: 'Microsoft'/);
  assert.match(deployment, /name: 'MAI-Thinking-1'/);
  assert.match(deployment, /version: '2026-06-01'/);
  assert.match(deployment, /versionUpgradeOption: 'NoAutoUpgrade'/);
});

test("Foundry inference access is account-scoped and limited to the three approved identities", async () => {
  const source = await readInfra("modules/foundry.bicep");
  const resources = resourceBlocks(source);
  assert.match(source, /'a97b65f3-24c7-4388-baec-2e87135dc908'/);

  const expectedAssignments = new Map([
    ["modelEvaluationInferenceRole", "modelEvaluationPrincipalId"],
    ["candidateAnalysisInferenceRole", "candidateAnalysisPrincipalId"],
    ["chatInferenceRole", "chatPrincipalId"],
  ]);
  const assignments = [...resources.values()].filter(({ type }) =>
    type.startsWith("Microsoft.Authorization/roleAssignments@")
  );
  assert.equal(assignments.length, expectedAssignments.size);

  for (const assignment of assignments) {
    const principal = expectedAssignments.get(assignment.symbol);
    assert.ok(principal, `Unexpected Foundry role assignment ${assignment.symbol}`);
    assert.match(assignment.source, /scope: foundryAccount/);
    assert.match(assignment.source, new RegExp(`principalId: ${principal}`));
    assert.match(assignment.source, /roleDefinitionId: cognitiveServicesUserRoleDefinitionId/);
    assert.match(assignment.source, /principalType: 'ServicePrincipal'/);
  }
});

test("all workload identities are separate and GitHub trusts only exact environment subjects", async () => {
  const source = await readInfra("modules/identities.bicep");
  const resources = resourceBlocks(source);
  const identities = [...resources.values()].filter(({ type }) =>
    type.startsWith("Microsoft.ManagedIdentity/userAssignedIdentities@")
  );
  const federations = [...resources.values()].filter(({ type }) =>
    type.includes("/federatedIdentityCredentials@")
  );

  assert.deepEqual(
    identities.map(({ source: identity }) => identity.match(/name: '([^']+)'/)[1]).sort(),
    [
      "id-gallery-candidate-analysis-dev",
      "id-gallery-catalog-publisher-dev",
      "id-gallery-chat-dev",
      "id-gallery-model-eval-dev",
      "id-gallery-pipeline-writer-dev",
    ],
  );
  assert.equal(federations.length, 4);
  assert.match(source, /var githubIssuer = 'https:\/\/token\.actions\.githubusercontent\.com'/);
  assert.match(source, /var azureTokenExchangeAudience = 'api:\/\/AzureADTokenExchange'/);

  const expectedFederations = new Map([
    ["modelEvaluationFederation", ["modelEvaluationIdentity", "repo:jaydestro/gallery:environment:gallery-model-evaluation"]],
    ["candidateAnalysisFederation", ["candidateAnalysisIdentity", "repo:jaydestro/gallery:environment:gallery-candidate-analysis"]],
    ["pipelineStorageFederation", ["pipelineWriterIdentity", "repo:jaydestro/gallery:environment:gallery-pipeline-storage"]],
    ["publicationFederation", ["catalogPublisherIdentity", "repo:jaydestro/gallery:environment:gallery-publication"]],
  ]);
  for (const federation of federations) {
    const expected = expectedFederations.get(federation.symbol);
    assert.ok(expected, `Unexpected federation ${federation.symbol}`);
    assert.match(federation.source, new RegExp(`parent: ${expected[0]}`));
    assert.match(federation.source, new RegExp(`subject: '${expected[1]}'`));
    assert.match(federation.source, /issuer: githubIssuer/);
    assert.match(federation.source, /azureTokenExchangeAudience/);
  }
  assert.doesNotMatch(source, /parent: chatIdentity[\s\S]*federatedIdentityCredentials/);
});

test("Cosmos is keyless serverless TLS 1.2 with exactly five no-throughput no-TTL containers", async () => {
  const source = await readInfra("modules/cosmos.bicep");
  const resources = resourceBlocks(source);
  const account = block(resources, "cosmosAccount");
  const database = block(resources, "galleryDatabase");

  assert.match(account, /name: 'cosmos-gallery-dev-jgd826'/);
  assert.match(account, /name: 'EnableServerless'/);
  assert.match(account, /disableKeyBasedMetadataWriteAccess: true/);
  assert.match(account, /disableLocalAuth: true/);
  assert.match(account, /minimalTlsVersion: 'Tls12'/);
  assert.match(account, /publicNetworkAccess: 'Enabled'/);
  assert.match(account, /defaultConsistencyLevel: 'Session'/);
  assert.match(database, /name: 'gallery'/);
  assert.match(database, /id: 'gallery'/);

  const expectedContainers = new Map([
    ["catalog-items", "/catalogPartition"],
    ["public-catalog", "/catalogPartition"],
    ["review-candidates", "/runKey"],
    ["review-decisions", "/runKey"],
    ["pipeline-records", "/runKey"],
  ]);
  const containers = [...resources.values()].filter(({ type }) =>
    type.startsWith("Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@")
  );
  assert.equal(containers.length, expectedContainers.size);
  for (const container of containers) {
    const name = container.source.match(/name: '([^']+)'/)[1];
    assert.ok(expectedContainers.has(name), `Unexpected Cosmos container ${name}`);
    assert.match(container.source, new RegExp(`id: '${name}'`));
    assert.match(container.source, new RegExp(`'${expectedContainers.get(name)}'`));
    assert.match(container.source, /kind: 'Hash'/);
    assert.match(container.source, /version: 2/);
    assert.match(container.source, /options: \{\}/);
  }
  assert.doesNotMatch(source, /\bthroughput\b|\bdefaultTtl\b|\banalyticalStorageTtl\b/i);
});

test("Cosmos custom roles contain only the approved data actions", async () => {
  const source = await readInfra("modules/cosmos.bicep");
  const resources = resourceBlocks(source);
  const metadata = "Microsoft.DocumentDB/databaseAccounts/readMetadata";
  const create = "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/create";
  const read = "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read";
  const query = "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/executeQuery";
  const replace = "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/replace";
  const expectedRoles = new Map([
    ["appendWriterRole", [metadata, create, read]],
    ["itemReaderRole", [metadata, query, read]],
    ["catalogPublisherRole", [metadata, query, create, read, replace]],
  ]);

  const roles = [...resources.values()].filter(({ type }) =>
    type.startsWith("Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@")
  );
  assert.equal(roles.length, expectedRoles.size);
  for (const role of roles) {
    assert.deepEqual(quotedValues(role.source, "dataActions:").sort(), expectedRoles.get(role.symbol).sort());
    assert.match(role.source, /type: 'CustomRole'/);
    assert.match(role.source, /cosmosAccount\.id/);
  }
  assert.doesNotMatch(block(resources, "appendWriterRole"), /items\/(?:delete|replace|upsert)/i);
  assert.doesNotMatch(block(resources, "itemReaderRole"), /items\/(?:create|delete|replace|upsert)/i);
  assert.doesNotMatch(roles.map(({ source: role }) => role).join("\n"), /items\/(?:delete|upsert)/i);
  assert.match(block(resources, "catalogPublisherRole"), /items\/replace/);
});

test("Cosmos role assignments preserve workload separation and make publication the sole catalog writer", async () => {
  const source = await readInfra("modules/cosmos.bicep");
  const resources = resourceBlocks(source);
  const assignments = [...resources.values()].filter(({ type }) =>
    type.startsWith("Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@")
  );
  assert.equal(assignments.length, 11);

  const expectedAssignments = new Map([
    ["collectorCandidateWriter", ["pipelineWriterPrincipalId", "appendWriterRole", "review-candidates"]],
    ["collectorAuditWriter", ["pipelineWriterPrincipalId", "appendWriterRole", "pipeline-records"]],
    ["reviewerCatalogReader", ["candidateAnalysisPrincipalId", "itemReaderRole", "catalog-items"]],
    ["reviewerCandidateReader", ["candidateAnalysisPrincipalId", "itemReaderRole", "review-candidates"]],
    ["reviewerDecisionWriter", ["candidateAnalysisPrincipalId", "appendWriterRole", "review-decisions"]],
    ["reviewerAuditWriter", ["candidateAnalysisPrincipalId", "appendWriterRole", "pipeline-records"]],
    ["publisherDecisionReader", ["catalogPublisherPrincipalId", "itemReaderRole", "review-decisions"]],
    ["publisherCatalogWriter", ["catalogPublisherPrincipalId", "catalogPublisherRole", "catalog-items"]],
    ["publisherAuditWriter", ["catalogPublisherPrincipalId", "appendWriterRole", "pipeline-records"]],
    ["publisherPublicWriter", ["catalogPublisherPrincipalId", "catalogPublisherRole", "public-catalog"]],
    ["chatbotPublicReader", ["chatPrincipalId", "itemReaderRole", "public-catalog"]],
  ]);

  for (const assignment of assignments) {
    const expected = expectedAssignments.get(assignment.symbol);
    assert.ok(expected, `Unexpected Cosmos role assignment ${assignment.symbol}`);
    assert.match(assignment.source, new RegExp(`principalId: ${expected[0]}`));
    assert.match(assignment.source, new RegExp(`roleDefinitionId: ${expected[1]}\\.id`));
    assert.match(assignment.source, new RegExp(`scope: '\\$\\{cosmosAccount\\.id\\}/dbs/gallery/colls/${expected[2]}'`));
  }

  const catalogMutationAssignments = assignments.filter(({ source: assignment }) =>
    /roleDefinitionId: catalogPublisherRole\.id/.test(assignment)
  );
  assert.deepEqual(
    catalogMutationAssignments.map(({ symbol }) => symbol).sort(),
    ["publisherCatalogWriter", "publisherPublicWriter"],
  );
  for (const assignment of catalogMutationAssignments) {
    assert.match(assignment.source, /principalId: catalogPublisherPrincipalId/);
  }

  const chatAssignments = assignments.filter(({ source: assignment }) =>
    /principalId: chatPrincipalId/.test(assignment)
  );
  assert.deepEqual(chatAssignments.map(({ symbol }) => symbol), ["chatbotPublicReader"]);
  assert.match(chatAssignments[0].source, /scope: '\$\{cosmosAccount\.id\}\/dbs\/gallery\/colls\/public-catalog'/);
});

test("diagnostics, workspace, Application Insights, action group, alerts, and budget match the plan", async () => {
  const observabilitySource = await readInfra("modules/observability.bicep");
  const foundrySource = await readInfra("modules/foundry.bicep");
  const cosmosSource = await readInfra("modules/cosmos.bicep");
  const alertsSource = await readInfra("modules/alerts.bicep");
  const observability = resourceBlocks(observabilitySource);
  const alerts = resourceBlocks(alertsSource);

  assert.match(block(observability, "logAnalyticsWorkspace"), /retentionInDays: 30/);
  assert.match(block(observability, "logAnalyticsWorkspace"), /dailyQuotaGb: 1/);
  assert.match(block(observability, "logAnalyticsWorkspace"), /name: 'PerGB2018'/);
  assert.match(block(observability, "applicationInsights"), /WorkspaceResourceId: logAnalyticsWorkspace\.id/);
  assert.match(block(observability, "applicationInsights"), /DisableLocalAuth: true/);
  assert.match(block(observability, "platformActionGroup"), /groupShortName: 'gallerydev'/);
  assert.match(block(observability, "platformActionGroup"), /emailAddress: alertEmail/);
  assert.match(observabilitySource, /'3913510d-42f4-4e42-8a64-420c390055eb'/);
  assert.match(block(observability, "chatMetricsPublisherRole"), /scope: applicationInsights/);
  assert.match(block(observability, "chatMetricsPublisherRole"), /principalId: chatPrincipalId/);
  assert.match(
    block(observability, "chatMetricsPublisherRole"),
    /roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId/,
  );

  const budget = block(observability, "platformBudget");
  assert.match(budget, /amount: 25/);
  assert.match(budget, /timeGrain: 'Monthly'/);
  assert.deepEqual([...budget.matchAll(/threshold: (50|80|100)/g)].map((match) => Number(match[1])), [50, 80, 100]);
  assert.equal((budget.match(/contactGroups:/g) ?? []).length, 3);
  assert.equal((budget.match(/contactEmails:/g) ?? []).length, 3);

  for (const [source, name] of [
    [foundrySource, "diag-gallery-foundry"],
    [cosmosSource, "diag-gallery-cosmos"],
  ]) {
    assert.match(source, new RegExp(`name: '${name}'`));
    assert.match(source, /categoryGroup: 'allLogs'/);
    assert.match(source, /category: 'AllMetrics'/);
    assert.match(source, /workspaceId: logAnalyticsWorkspaceId/);
  }

  assert.deepEqual(
    [...alerts.values()].map(({ source: alert }) => alert.match(/name: '([^']+)'/)[1]).sort(),
    [
      "alert-cosmos-throttling",
      "alert-foundry-server-errors",
      "alert-foundry-throttling",
      "alert-foundry-unexpected-volume",
      "alert-missed-model-evaluation",
    ],
  );
  assert.match(block(alerts, "cosmosThrottlingAlert"), /enabled: true/);
  for (const symbol of [
    "foundryThrottlingAlert",
    "foundryServerErrorsAlert",
    "foundryUnexpectedVolumeAlert",
    "missedModelEvaluationAlert",
  ]) {
    assert.match(block(alerts, symbol), /enabled: false/);
  }
});

test("phase-two API contract is implemented but staged disabled behind explicit Graph preflight", async () => {
  const contract = JSON.parse(await readInfra("phase-2-api-contract.json"));
  assert.equal(contract.status, "implemented");
  assert.equal(contract.infrastructureState, "staged-disabled");
  assert.equal(contract.graphProvisioning.mode, "external-precreated");
  assert.deepEqual(contract.graphProvisioning.requiredParameters, [
    "apiAppClientId",
    "chatInvokeAppRoleId",
    "apimClientId",
    "apimPrincipalId",
  ]);
  assert.deepEqual(contract.graphProvisioning.preflightOutputs, ["apiAuthPreflight", "graphPreflight"]);
  assert.equal(contract.resources.functionApp.runtime, "node");
  assert.equal(contract.resources.functionApp.runtimeVersion, "22");
  assert.equal(contract.resources.functionApp.enabled, false);
  assert.equal(contract.resources.apiManagement.sku, "Consumption");
  assert.equal(contract.resources.apiManagement.capacity, 0);
  assert.equal(contract.runtimeIdentity, "id-gallery-chat-dev");
  assert.equal(contract.dataAccess.cosmosDatabase, "gallery");
  assert.deepEqual(contract.dataAccess.readContainers, ["public-catalog"]);
  assert.deepEqual(contract.dataAccess.writeContainers, []);
  assert.deepEqual(contract.dataAccess.forbiddenContainers.sort(), [
    "catalog-items",
    "pipeline-records",
    "review-candidates",
    "review-decisions",
  ]);
  assert.equal(
    contract.dataAccess.visibilityProtocol,
    "Point-read active-snapshot, then query only that exact snapshotId",
  );
  assert.equal(
    contract.dataAccess.publicPredicate,
    "type = catalog-item AND publicationStatus = published AND lifecycleStatus IN (active, needs-review)",
  );
  assert.deepEqual(
    contract.routes.map(({ method, path: routePath, source, mutationAllowed }) => ({
      method,
      path: routePath,
      source,
      mutationAllowed,
    })),
    [
      { method: "GET", path: "/gallery/items", source: "public-catalog", mutationAllowed: false },
      { method: "POST", path: "/gallery/chat", source: "public-catalog", mutationAllowed: false },
    ],
  );
  assert.equal(contract.security.browserReceivesAzureCredentials, false);
  assert.equal(contract.security.directAnonymousFunctionAccess, false);
  assert.equal(contract.security.localAuthenticationAllowed, false);
  assert.equal(contract.security.backendAudience, "api://gallery-chat-api-dev");
  assert.equal(contract.security.authsettingsV2.requireAuthentication, true);
  assert.equal(contract.security.authsettingsV2.issuer, "https://login.microsoftonline.com/{tenantId}/v2.0");
  assert.deepEqual(contract.security.authsettingsV2.allowedClientApplications, ["apimClientId"]);
  assert.deepEqual(contract.security.authsettingsV2.allowedPrincipalObjectIds, ["apimPrincipalId"]);
  assert.equal(contract.security.roleEnforcement.requiredRole, "Chat.Invoke");
  assert.deepEqual(contract.activation, {
    functionAppEnabled: false,
    modelEvaluation: false,
    candidateAnalysis: false,
    cosmosPersistence: false,
    catalogMutation: false,
    emergencyDisable: true,
  });
});

test("Function API uses Node 22 Flex Consumption, keyless package storage, and starts disabled", async () => {
  const source = await readInfra("modules/api.bicep");
  const resources = resourceBlocks(source);
  const storage = block(resources, "storageAccount");
  const container = block(resources, "deploymentContainer");
  const plan = block(resources, "functionPlan");
  const app = block(resources, "functionApp");

  assert.equal(resources.get("storageAccount").type, "Microsoft.Storage/storageAccounts@2023-05-01");
  assert.match(storage, /name: storageAccountName/);
  assert.match(source, /var storageAccountName = 'stgallerychatjgd826'/);
  assert.match(storage, /name: 'Standard_LRS'/);
  assert.match(storage, /allowSharedKeyAccess: false/);
  assert.match(storage, /allowBlobPublicAccess: false/);
  assert.match(storage, /defaultToOAuthAuthentication: true/);
  assert.match(storage, /minimumTlsVersion: 'TLS1_2'/);
  assert.match(container, /name: deploymentContainerName/);
  assert.match(source, /var deploymentContainerName = 'deployments'/);
  assert.match(container, /publicAccess: 'None'/);

  assert.equal(resources.get("functionPlan").type, "Microsoft.Web/serverfarms@2024-04-01");
  assert.match(source, /var functionPlanName = 'asp-gallery-chat-dev-eus2'/);
  assert.match(plan, /name: 'FC1'/);
  assert.match(plan, /tier: 'FlexConsumption'/);
  assert.match(app, /functionAppConfig:[\s\S]*runtime:[\s\S]*name: 'node'[\s\S]*version: '22'/);
  assert.doesNotMatch(app, /FUNCTIONS_WORKER_RUNTIME/);
  assert.match(plan, /reserved: true/);

  assert.equal(resources.get("functionApp").type, "Microsoft.Web/sites@2024-04-01");
  assert.match(source, /var functionAppName = 'func-gallery-chat-dev-jgd826'/);
  assert.match(app, /type: 'UserAssigned'/);
  assert.match(app, /enabled: false/);
  assert.match(app, /scmSiteAlsoStopped: true/);
  assert.match(app, /httpsOnly: true/);
  assert.match(app, /type: 'blobContainer'/);
  assert.match(app, /type: 'UserAssignedIdentity'/);
  assert.match(app, /userAssignedIdentityResourceId: chatIdentityId/);
  assert.match(app, /name: 'node'/);
  assert.match(app, /version: '22'/);
  assert.match(app, /name: 'AzureWebJobsStorage__credential'[\s\S]*value: 'managedidentity'/);
  assert.match(app, /name: 'AzureWebJobsStorage__clientId'[\s\S]*value: chatClientId/);
  assert.match(app, /name: 'AZURE_COSMOS_PUBLIC_CONTAINER'[\s\S]*value: 'public-catalog'/);
  assert.match(app, /name: 'GALLERY_MAX_CONTEXT_ITEMS'[\s\S]*value: '20'/);
  assert.match(app, /name: 'GALLERY_MAX_OUTPUT_TOKENS'[\s\S]*value: '800'/);
  assert.match(app, /name: 'GALLERY_CHAT_HISTORY_ENABLED'[\s\S]*value: 'false'/);

  const assignments = [...resources.values()].filter(({ type }) =>
    type.startsWith("Microsoft.Authorization/roleAssignments@")
  );
  assert.equal(assignments.length, 3);
  assert.match(source, /'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'/);
  assert.match(source, /'974c5e8b-45b9-4653-ba55-5f855dd0fb88'/);
  assert.match(source, /'0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'/);
  for (const assignment of assignments) {
    assert.match(assignment.source, /scope: storageAccount/);
    assert.match(assignment.source, /principalId: chatPrincipalId/);
    assert.match(assignment.source, /principalType: 'ServicePrincipal'/);
  }
});

test("Function authsettingsV2 pins tenant, audience, APIM caller, and Chat.Invoke preflight", async () => {
  const source = await readInfra("modules/api.bicep");
  const parameters = await readInfra("main.bicepparam");
  const auth = block(resourceBlocks(source), "authSettings");

  assert.match(source, /https:\/\/login\.microsoftonline\.com\/\$\{tenantId\}\/v2\.0/);
  assert.match(auth, /enabled: true/);
  assert.match(auth, /requireAuthentication: true/);
  assert.match(auth, /unauthenticatedClientAction: 'Return401'/);
  assert.match(auth, /clientId: apiAppClientId/);
  assert.match(auth, /allowedAudiences:[\s\S]*apiAudience/);
  assert.match(auth, /allowedApplications:[\s\S]*apimClientId/);
  assert.match(auth, /allowedPrincipals:[\s\S]*identities:[\s\S]*apimPrincipalId/);
  assert.match(auth, /allowedClientApplications:[\s\S]*apimClientId/);
  assert.match(source, /name: 'GALLERY_CHAT_REQUIRED_ROLE'[\s\S]*value: 'Chat\.Invoke'/);
  assert.match(source, /name: 'GALLERY_CHAT_REQUIRED_ROLE_ID'[\s\S]*value: chatInvokeAppRoleId/);
  assert.match(source, /graphProvisioningMode: 'external-precreated'/);
  assert.match(source, /parametersResolved:/);

  for (const parameter of ["apiAppClientId", "chatInvokeAppRoleId", "apimClientId", "apimPrincipalId"]) {
    assert.match(parameters, new RegExp(`param ${parameter} = '(?!00000000-0000-0000-0000-000000000000)[0-9a-f-]{36}'`));
  }
});

test("API Management exposes only the two public operations and authenticates to the backend with managed identity", async () => {
  const source = await readInfra("modules/api-management.bicep");
  const basePolicy = await readInfra("modules/policies/gallery-api.xml");
  const resources = resourceBlocks(source);
  const service = block(resources, "apiManagement");
  const backend = block(resources, "galleryBackend");
  const api = block(resources, "galleryApi");

  assert.equal(resources.get("apiManagement").type, "Microsoft.ApiManagement/service@2024-05-01");
  assert.match(source, /var apiManagementName = 'apim-gallery-chat-dev-jgd826'/);
  assert.match(service, /type: 'SystemAssigned'/);
  assert.match(service, /name: 'Consumption'/);
  assert.match(service, /capacity: 0/);
  assert.doesNotMatch(service, /customProperties/);
  assert.doesNotMatch(service, /(?:developer|legacy)PortalStatus/);
  assert.match(backend, /protocol: 'http'/);
  assert.match(backend, /url: '\$\{functionAppUrl\}\/api'/);
  assert.match(api, /path: 'gallery'/);
  assert.match(api, /subscriptionRequired: false/);
  assert.match(api, /protocols:[\s\S]*'https'/);

  const operations = [...resources.values()].filter(({ type }) =>
    type.startsWith("Microsoft.ApiManagement/service/apis/operations@")
  );
  assert.equal(operations.length, 2);
  assert.match(block(resources, "getGalleryItems"), /method: 'GET'[\s\S]*urlTemplate: '\/items'/);
  assert.match(block(resources, "postGalleryChat"), /method: 'POST'[\s\S]*urlTemplate: '\/chat'/);

  assert.match(basePolicy, /<origin>__ALLOWED_ORIGIN__<\/origin>/);
  assert.match(basePolicy, /<method>GET<\/method>/);
  assert.match(basePolicy, /<method>POST<\/method>/);
  assert.match(basePolicy, /<method>OPTIONS<\/method>/);
  assert.match(basePolicy, /<authentication-managed-identity resource="__API_AUDIENCE__" ignore-error="false" \/>/);
  assert.match(basePolicy, /<set-backend-service backend-id="__BACKEND_ID__" \/>/);
  assert.match(basePolicy, /<value>Chat\.Invoke<\/value>/);
  assert.match(basePolicy, /<set-header name="X-Gallery-Client-IP" exists-action="override">[\s\S]*context\.Request\.IpAddress/);
});

test("GET policy is cache and conditional aware without chat quotas", async () => {
  const basePolicy = await readInfra("modules/policies/gallery-api.xml");
  const getPolicy = await readInfra("modules/policies/get-gallery-items.xml");

  assert.match(basePolicy, /<header>If-None-Match<\/header>/);
  assert.match(basePolicy, /<header>ETag<\/header>/);
  assert.match(getPolicy, /<cache-lookup[^>]*caching-type="internal"[^>]*downstream-caching-type="public"[^>]*must-revalidate="true">/);
  assert.match(getPolicy, /<cache-store duration="60" \/>/);
  assert.match(getPolicy, /<forward-request timeout="30"/);
  assert.doesNotMatch(getPolicy, /rate-limit-by-key|quota-by-key|validate-content/);
});

test("POST applies exact body, durable IP rate, daily quota, and timeout limits", async () => {
  const apiSource = await readInfra("modules/api.bicep");
  const postPolicy = await readInfra("modules/policies/post-gallery-chat.xml");
  const limiter = await readFile(path.join(ROOT_DIRECTORY, "api", "src", "adapters", "table-rate-limiter.js"), "utf8");

  assert.match(postPolicy, /Content-Type/);
  assert.match(postPolicy, /application\/json/);
  assert.match(postPolicy, /<validate-content[^>]*max-size="8192"[^>]*size-exceeded-action="prevent"/);
  assert.doesNotMatch(postPolicy, /rate-limit-by-key|quota-by-key/);
  assert.match(postPolicy, /<forward-request timeout="30"/);
  assert.doesNotMatch(postPolicy, /cache-lookup|cache-store/);
  assert.match(apiSource, /Microsoft\.Storage\/storageAccounts\/tableServices\/tables@/);
  assert.match(apiSource, /name: 'GALLERY_RATE_LIMIT_TABLE'[\s\S]*value: rateLimitTable\.name/);
  assert.match(limiter, /minuteCount >= 20/);
  assert.match(limiter, /dayCount >= 200/);
  assert.match(limiter, /createHash\("sha256"\)/);
});

test("generated infrastructure contains no credential material or unverified Graph resources", async () => {
  const moduleFiles = (await readdir(MODULE_DIRECTORY))
    .filter((fileName) => fileName.endsWith(".bicep"))
    .map((fileName) => path.join("modules", fileName));
  const sourceFiles = ["main.bicep", "main.bicepparam", ...moduleFiles];
  const sources = await Promise.all(sourceFiles.map(readInfra));
  const allSource = sources.join("\n");

  assert.doesNotMatch(
    allSource,
    /listKeys\s*\(|\bprimaryKey\b|\bsecondaryKey\b|\baccountKey\b|\bclientSecret\b|\bsharedAccessKey\b|\binstrumentationKey\b|\bconnectionString\s*:/i,
  );
  assert.doesNotMatch(allSource, /Microsoft\.Graph\//);
  assert.doesNotMatch(allSource, /\b(?:Owner|Contributor|User Access Administrator)\b/);
  assert.doesNotMatch(allSource, /@secure\(\)|secureString|secureObject/);
});