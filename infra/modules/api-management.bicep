targetScope = 'resourceGroup'

@description('Azure region for API Management.')
param location string

@description('Common gallery resource tags.')
param tags object

@description('Publisher email required by API Management.')
param publisherEmail string

@description('Base URL of the Entra-protected Function App.')
param functionAppUrl string

@description('Application ID URI of the protected gallery API.')
param apiAudience string = 'api://gallery-chat-api-dev'

@description('Expected application/client ID of the API Management managed identity.')
param apimClientId string

@description('Expected object/principal ID of the API Management managed identity.')
param apimPrincipalId string

@description('ID of the pre-created Chat.Invoke application role.')
param chatInvokeAppRoleId string

var apiManagementName = 'apim-gallery-chat-dev-jgd826'
var backendName = 'backend-gallery-chat'
var apiName = 'gallery-chat'
var allowedOrigin = 'https://jaydestro.github.io'
var unresolvedGuid = '00000000-0000-0000-0000-000000000000'
var apiPolicy = replace(
  replace(
    replace(loadTextContent('./policies/gallery-api.xml'), '__ALLOWED_ORIGIN__', allowedOrigin),
    '__BACKEND_ID__',
    backendName
  ),
  '__API_AUDIENCE__',
  apiAudience
)

resource apiManagement 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: apiManagementName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    capacity: 0
    name: 'Consumption'
  }
  properties: {
    publicNetworkAccess: 'Enabled'
    publisherEmail: publisherEmail
    publisherName: 'Gallery'
    virtualNetworkType: 'None'
  }
}

resource galleryBackend 'Microsoft.ApiManagement/service/backends@2024-05-01' = {
  parent: apiManagement
  name: backendName
  properties: {
    description: 'Entra-protected Gallery Function backend'
    protocol: 'http'
    url: '${functionAppUrl}/api'
  }
}

resource galleryApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apiManagement
  name: apiName
  properties: {
    apiRevision: '1'
    apiType: 'http'
    description: 'Read-only gallery catalog and bounded gallery chat API.'
    displayName: 'Gallery API'
    isCurrent: true
    path: 'gallery'
    protocols: [
      'https'
    ]
    serviceUrl: '${functionAppUrl}/api'
    subscriptionRequired: false
    type: 'http'
  }
}

resource galleryApiPolicy 'Microsoft.ApiManagement/service/apis/policies@2024-05-01' = {
  parent: galleryApi
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: apiPolicy
  }
  dependsOn: [
    galleryBackend
  ]
}

resource getGalleryItems 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: galleryApi
  name: 'get-gallery-items'
  properties: {
    description: 'Returns one committed public gallery projection.'
    displayName: 'Get gallery items'
    method: 'GET'
    request: {
      queryParameters: [
        {
          name: 'continuationToken'
          required: false
          type: 'string'
        }
        {
          name: 'pageSize'
          required: false
          type: 'integer'
        }
      ]
    }
    responses: [
      {
        description: 'Gallery items or a conditional not-modified response.'
        statusCode: 200
      }
      {
        description: 'The active public projection has not changed.'
        statusCode: 304
      }
    ]
    urlTemplate: '/items'
  }
}

resource getGalleryItemsPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: getGalleryItems
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('./policies/get-gallery-items.xml')
  }
}

resource postGalleryChat 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: galleryApi
  name: 'post-gallery-chat'
  properties: {
    description: 'Answers a bounded question using committed public gallery records.'
    displayName: 'Post gallery chat'
    method: 'POST'
    request: {
      representations: [
        {
          contentType: 'application/json'
        }
      ]
    }
    responses: [
      {
        description: 'Grounded answer with gallery citations.'
        statusCode: 200
      }
    ]
    urlTemplate: '/chat'
  }
}

resource postGalleryChatPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: postGalleryChat
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: loadTextContent('./policies/post-gallery-chat.xml')
  }
}

output apiManagementId string = apiManagement.id
output apiManagementName string = apiManagement.name
output deployedApimPrincipalId string = apiManagement.identity.principalId
output gatewayUrl string = 'https://${apiManagement.name}.azure-api.net/gallery'
output graphPreflight object = {
  graphProvisioningMode: 'external-precreated'
  parametersResolved: apimClientId != unresolvedGuid && apimPrincipalId != unresolvedGuid && chatInvokeAppRoleId != unresolvedGuid
  apiAudience: apiAudience
  chatInvokeAppRoleId: chatInvokeAppRoleId
  requiredRoleValue: 'Chat.Invoke'
  expectedApimClientId: apimClientId
  expectedApimPrincipalId: apimPrincipalId
  deployedApimPrincipalId: apiManagement.identity.principalId
  principalIdMustMatch: true
  appRoleGrantRequired: true
  functionMustRemainStopped: true
}