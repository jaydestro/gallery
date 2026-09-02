targetScope = 'resourceGroup'

@description('Azure region for the gallery API resources.')
param location string

@description('Common gallery resource tags.')
param tags object

@description('Microsoft Entra tenant ID used to validate backend access tokens.')
param tenantId string

@description('Resource ID of the gallery chat user-assigned managed identity.')
param chatIdentityId string

@description('Principal ID of the gallery chat user-assigned managed identity.')
param chatPrincipalId string

@description('Client ID of the gallery chat user-assigned managed identity.')
param chatClientId string

@description('Non-secret Application Insights connection string.')
param applicationInsightsConnectionString string

@description('Keyless Cosmos DB account endpoint.')
param cosmosEndpoint string

@description('Cosmos DB database containing the committed public projection.')
param cosmosDatabaseName string

@description('Microsoft Foundry account endpoint.')
param foundryEndpoint string

@description('Microsoft Foundry model deployment used by gallery chat.')
param modelDeploymentName string

@description('Client ID of the pre-created single-tenant API application.')
param apiAppClientId string

@description('Application ID URI exposed by the pre-created API application.')
param apiAudience string = 'api://gallery-chat-api-dev'

@description('Application/client ID of the API Management system-assigned identity.')
param apimClientId string

@description('Object/principal ID of the API Management system-assigned identity.')
param apimPrincipalId string

@description('ID of the pre-created Chat.Invoke application role.')
param chatInvokeAppRoleId string

var storageAccountName = 'stgallerychatjgd826'
var deploymentContainerName = 'deployments'
var rateLimitTableName = 'gallerychatlimits'
var functionPlanName = 'asp-gallery-chat-dev-eus2'
var functionAppName = 'func-gallery-chat-dev-jgd826'
var unresolvedGuid = '00000000-0000-0000-0000-000000000000'
#disable-next-line no-hardcoded-env-urls
var issuer = 'https://login.microsoftonline.com/${tenantId}/v2.0'
var storageBlobDataOwnerRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
)
var storageQueueDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
)
var storageTableDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
)

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: false
    }
  }
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deploymentContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource rateLimitTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: rateLimitTableName
}

resource functionPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: functionPlanName
  location: location
  kind: 'functionapp'
  tags: tags
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${chatIdentityId}': {}
    }
  }
  properties: {
    enabled: false
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storageAccount.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: chatIdentityId
          }
        }
      }
      runtime: {
        name: 'node'
        version: '22'
      }
      scaleAndConcurrency: {
        instanceMemoryMB: 2048
        maximumInstanceCount: 20
        triggers: {
          http: {
            perInstanceConcurrency: 16
          }
        }
      }
    }
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    scmSiteAlsoStopped: true
    serverFarmId: functionPlan.id
    siteConfig: {
      alwaysOn: false
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storageAccount.name
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'AzureWebJobsStorage__clientId'
          value: chatClientId
        }
        {
          name: 'AZURE_STORAGE_ACCOUNT_NAME'
          value: storageAccount.name
        }
        {
          name: 'GALLERY_RATE_LIMIT_TABLE'
          value: rateLimitTable.name
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: applicationInsightsConnectionString
        }
        {
          name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING'
          value: 'Authorization=AAD;ClientId=${chatClientId}'
        }
        {
          name: 'AZURE_COSMOS_ENDPOINT'
          value: cosmosEndpoint
        }
        {
          name: 'AZURE_COSMOS_DATABASE'
          value: cosmosDatabaseName
        }
        {
          name: 'AZURE_COSMOS_PUBLIC_CONTAINER'
          value: 'public-catalog'
        }
        {
          name: 'AZURE_FOUNDRY_ENDPOINT'
          value: foundryEndpoint
        }
        {
          name: 'AZURE_FOUNDRY_DEPLOYMENT'
          value: modelDeploymentName
        }
        {
          name: 'GALLERY_API_AUDIENCE'
          value: apiAudience
        }
        {
          name: 'GALLERY_APIM_CLIENT_ID'
          value: apimClientId
        }
        {
          name: 'GALLERY_APIM_PRINCIPAL_ID'
          value: apimPrincipalId
        }
        {
          name: 'GALLERY_CHAT_REQUIRED_ROLE'
          value: 'Chat.Invoke'
        }
        {
          name: 'GALLERY_CHAT_REQUIRED_ROLE_ID'
          value: chatInvokeAppRoleId
        }
        {
          name: 'GALLERY_MAX_CONTEXT_ITEMS'
          value: '20'
        }
        {
          name: 'GALLERY_MAX_OUTPUT_TOKENS'
          value: '800'
        }
        {
          name: 'GALLERY_CHAT_HISTORY_ENABLED'
          value: 'false'
        }
      ]
      cors: {
        allowedOrigins: [
          'https://jaydestro.github.io'
        ]
        supportCredentials: false
      }
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      remoteDebuggingEnabled: false
      scmMinTlsVersion: '1.2'
    }
    storageAccountRequired: true
  }
  dependsOn: [
    deploymentContainer
  ]
}

resource authSettings 'Microsoft.Web/sites/config@2022-09-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  kind: 'functionapp'
  properties: {
    globalValidation: {
      redirectToProvider: 'azureActiveDirectory'
      requireAuthentication: true
      unauthenticatedClientAction: 'Return401'
    }
    httpSettings: {
      requireHttps: true
      routes: {
        apiPrefix: '.auth'
      }
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        login: {
          disableWWWAuthenticate: false
        }
        registration: {
          clientId: apiAppClientId
          openIdIssuer: issuer
        }
        validation: {
          allowedAudiences: [
            apiAudience
          ]
          defaultAuthorizationPolicy: {
            allowedApplications: [
              apimClientId
            ]
            allowedPrincipals: {
              identities: [
                apimPrincipalId
              ]
            }
          }
          jwtClaimChecks: {
            allowedClientApplications: [
              apimClientId
            ]
          }
        }
      }
    }
    login: {
      preserveUrlFragmentsForLogins: false
      tokenStore: {
        enabled: false
      }
    }
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
  }
}

resource chatStorageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, chatPrincipalId, storageBlobDataOwnerRoleDefinitionId)
  scope: storageAccount
  properties: {
    principalId: chatPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataOwnerRoleDefinitionId
  }
}

resource chatStorageQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, chatPrincipalId, storageQueueDataContributorRoleDefinitionId)
  scope: storageAccount
  properties: {
    principalId: chatPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageQueueDataContributorRoleDefinitionId
  }
}

resource chatStorageTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, chatPrincipalId, storageTableDataContributorRoleDefinitionId)
  scope: storageAccount
  properties: {
    principalId: chatPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageTableDataContributorRoleDefinitionId
  }
}

output functionAppId string = functionApp.id
output functionAppName string = functionApp.name
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output deploymentContainerName string = deploymentContainerName
output authPreflight object = {
  graphProvisioningMode: 'external-precreated'
  parametersResolved: apiAppClientId != unresolvedGuid && apimClientId != unresolvedGuid && apimPrincipalId != unresolvedGuid && chatInvokeAppRoleId != unresolvedGuid
  tenantIssuer: issuer
  apiAppClientId: apiAppClientId
  apiAudience: apiAudience
  chatInvokeAppRoleId: chatInvokeAppRoleId
  requiredRoleValue: 'Chat.Invoke'
  apimClientId: apimClientId
  apimPrincipalId: apimPrincipalId
  functionAppEnabled: false
  requiredChecks: [
    'API application and service principal exist in the deployment tenant.'
    'The API service principal requires assignment and exposes the Chat.Invoke application role.'
    'The APIM managed identity has the Chat.Invoke application-role assignment.'
    'Storage, Cosmos DB, Foundry, and Application Insights role assignments have propagated.'
  ]
}