targetScope = 'resourceGroup'

@description('Azure region for Microsoft Foundry resources.')
param location string

@description('Common gallery resource tags.')
param tags object

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string

@description('Principal ID of the model evaluation workload identity.')
param modelEvaluationPrincipalId string

@description('Principal ID of the candidate analysis workload identity.')
param candidateAnalysisPrincipalId string

@description('Principal ID of the managed chatbot workload identity.')
param chatPrincipalId string

var cognitiveServicesUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'a97b65f3-24c7-4388-baec-2e87135dc908'
)

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'aif-gallery-dev-jgd826'
  location: location
  kind: 'AIServices'
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: 'aif-gallery-dev-jgd826'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundryAccount
  name: 'gallery-mai-thinking-1'
  sku: {
    name: 'GlobalStandard'
    capacity: 10
  }
  properties: {
    model: {
      format: 'Microsoft'
      name: 'MAI-Thinking-1'
      version: '2026-06-01'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource foundryDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-gallery-foundry'
  scope: foundryAccount
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource modelEvaluationInferenceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundryAccount.id, modelEvaluationPrincipalId, cognitiveServicesUserRoleDefinitionId)
  scope: foundryAccount
  properties: {
    roleDefinitionId: cognitiveServicesUserRoleDefinitionId
    principalId: modelEvaluationPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource candidateAnalysisInferenceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundryAccount.id, candidateAnalysisPrincipalId, cognitiveServicesUserRoleDefinitionId)
  scope: foundryAccount
  properties: {
    roleDefinitionId: cognitiveServicesUserRoleDefinitionId
    principalId: candidateAnalysisPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource chatInferenceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundryAccount.id, chatPrincipalId, cognitiveServicesUserRoleDefinitionId)
  scope: foundryAccount
  properties: {
    roleDefinitionId: cognitiveServicesUserRoleDefinitionId
    principalId: chatPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output foundryAccountId string = foundryAccount.id
output foundryAccountName string = foundryAccount.name
#disable-next-line no-hardcoded-env-urls
output foundryEndpoint string = 'https://${foundryAccount.name}.services.ai.azure.com'
output modelDeploymentName string = modelDeployment.name