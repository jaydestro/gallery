targetScope = 'subscription'

@description('Azure region for the gallery foundation resources.')
param location string = 'centralus'

@description('Dedicated resource group for the gallery foundation.')
param resourceGroupName string = 'rg-cosmos-gallery-dev'

@description('Email address that receives platform and budget notifications.')
param alertEmail string = 'jagord@microsoft.com'

@description('First day of the budget period. Defaults to the current month at deployment time.')
param budgetStartDate string = utcNow('yyyy-MM-01')

@minLength(36)
@maxLength(36)
@description('Client ID of the pre-created single-tenant gallery API application.')
param apiAppClientId string

@minLength(36)
@maxLength(36)
@description('ID of the pre-created Chat.Invoke application role.')
param chatInvokeAppRoleId string

@minLength(36)
@maxLength(36)
@description('Application/client ID of the API Management system-assigned identity.')
param apimClientId string

@minLength(36)
@maxLength(36)
@description('Object/principal ID of the API Management system-assigned identity.')
param apimPrincipalId string

@description('Application ID URI exposed by the pre-created gallery API application.')
param apiAudience string = 'api://gallery-chat-api-dev'

var tags = {
  application: 'gallery'
  environment: 'dev'
  owner: 'jaydestro'
  repository: 'https://github.com/jaydestro/gallery'
  'managed-by': 'bicep'
}

resource galleryResourceGroup 'Microsoft.Resources/resourceGroups@2022-09-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module identities './modules/identities.bicep' = {
  name: 'gallery-identities'
  scope: resourceGroup(resourceGroupName)
  params: {
    location: location
    tags: tags
  }
  dependsOn: [
    galleryResourceGroup
  ]
}

module observability './modules/observability.bicep' = {
  name: 'gallery-observability'
  scope: resourceGroup(resourceGroupName)
  params: {
    location: location
    tags: tags
    alertEmail: alertEmail
    budgetStartDate: budgetStartDate
    chatPrincipalId: identities.outputs.chatPrincipalId
  }
  dependsOn: [
    galleryResourceGroup
  ]
}

module foundry './modules/foundry.bicep' = {
  name: 'gallery-foundry'
  scope: resourceGroup(resourceGroupName)
  params: {
    location: location
    tags: tags
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    modelEvaluationPrincipalId: identities.outputs.modelEvaluationPrincipalId
    candidateAnalysisPrincipalId: identities.outputs.candidateAnalysisPrincipalId
    chatPrincipalId: identities.outputs.chatPrincipalId
  }
}

module cosmos './modules/cosmos.bicep' = {
  name: 'gallery-cosmos'
  scope: resourceGroup(resourceGroupName)
  params: {
    location: location
    tags: tags
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    candidateAnalysisPrincipalId: identities.outputs.candidateAnalysisPrincipalId
    pipelineWriterPrincipalId: identities.outputs.pipelineWriterPrincipalId
    catalogPublisherPrincipalId: identities.outputs.catalogPublisherPrincipalId
    chatPrincipalId: identities.outputs.chatPrincipalId
  }
}

module alerts './modules/alerts.bicep' = {
  name: 'gallery-alerts'
  scope: resourceGroup(resourceGroupName)
  params: {
    location: location
    tags: tags
    actionGroupId: observability.outputs.actionGroupId
    logAnalyticsWorkspaceId: observability.outputs.logAnalyticsWorkspaceId
    foundryAccountId: foundry.outputs.foundryAccountId
    cosmosAccountId: cosmos.outputs.cosmosAccountId
  }
}

module api './modules/api.bicep' = {
  name: 'gallery-api'
  scope: resourceGroup(resourceGroupName)
  params: {
    location: location
    tags: tags
    tenantId: tenant().tenantId
    chatIdentityId: identities.outputs.chatIdentityId
    chatPrincipalId: identities.outputs.chatPrincipalId
    chatClientId: identities.outputs.chatClientId
    applicationInsightsConnectionString: observability.outputs.applicationInsightsConnectionString
    cosmosEndpoint: cosmos.outputs.cosmosEndpoint
    cosmosDatabaseName: cosmos.outputs.cosmosDatabaseName
    foundryEndpoint: foundry.outputs.foundryEndpoint
    modelDeploymentName: foundry.outputs.modelDeploymentName
    apiAppClientId: apiAppClientId
    apiAudience: apiAudience
    apimClientId: apimClientId
    apimPrincipalId: apimPrincipalId
    chatInvokeAppRoleId: chatInvokeAppRoleId
  }
}

module apiManagement './modules/api-management.bicep' = {
  name: 'gallery-api-management'
  scope: resourceGroup(resourceGroupName)
  params: {
    location: location
    tags: tags
    publisherEmail: alertEmail
    functionAppUrl: api.outputs.functionAppUrl
    apiAudience: apiAudience
    apimClientId: apimClientId
    apimPrincipalId: apimPrincipalId
    chatInvokeAppRoleId: chatInvokeAppRoleId
  }
}

output resourceGroupId string = galleryResourceGroup.id
output foundryAccountName string = foundry.outputs.foundryAccountName
output modelDeploymentName string = foundry.outputs.modelDeploymentName
output cosmosAccountName string = cosmos.outputs.cosmosAccountName
output cosmosDatabaseName string = cosmos.outputs.cosmosDatabaseName
output modelEvaluationClientId string = identities.outputs.modelEvaluationClientId
output candidateAnalysisClientId string = identities.outputs.candidateAnalysisClientId
output pipelineWriterClientId string = identities.outputs.pipelineWriterClientId
output catalogPublisherClientId string = identities.outputs.catalogPublisherClientId
output chatClientId string = identities.outputs.chatClientId
output functionAppName string = api.outputs.functionAppName
output apiManagementName string = apiManagement.outputs.apiManagementName
output galleryApiUrl string = apiManagement.outputs.gatewayUrl
output apiAuthPreflight object = api.outputs.authPreflight
output graphPreflight object = apiManagement.outputs.graphPreflight