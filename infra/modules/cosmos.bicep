targetScope = 'resourceGroup'

@description('Azure region for Cosmos DB resources.')
param location string

@description('Common gallery resource tags.')
param tags object

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string

@description('Principal ID of the candidate analysis workload identity.')
param candidateAnalysisPrincipalId string

@description('Principal ID of the pipeline writer workload identity.')
param pipelineWriterPrincipalId string

@description('Principal ID of the catalog publisher workload identity.')
param catalogPublisherPrincipalId string

@description('Principal ID of the managed chatbot workload identity.')
param chatPrincipalId string

var standardIndexingPolicy = {
  automatic: true
  indexingMode: 'consistent'
  includedPaths: [
    {
      path: '/*'
    }
  ]
  excludedPaths: [
    {
      path: '/"_etag"/?'
    }
  ]
}

//checkov:skip=CKV_AZURE_101:GitHub-hosted runners require a public endpoint; local auth is disabled and data access is container-scoped through Entra RBAC.
resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: 'cosmos-gallery-dev-jgd826'
  location: location
  kind: 'GlobalDocumentDB'
  tags: tags
  properties: {
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    databaseAccountOfferType: 'Standard'
    disableKeyBasedMetadataWriteAccess: true
    disableLocalAuth: true
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    locations: [
      {
        failoverPriority: 0
        isZoneRedundant: false
        locationName: location
      }
    ]
    minimalTlsVersion: 'Tls12'
    networkAclBypass: 'None'
    publicNetworkAccess: 'Enabled'
  }
}

resource galleryDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmosAccount
  name: 'gallery'
  properties: {
    resource: {
      id: 'gallery'
    }
    options: {}
  }
}

resource catalogItemsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: galleryDatabase
  name: 'catalog-items'
  properties: {
    resource: {
      id: 'catalog-items'
      indexingPolicy: standardIndexingPolicy
      partitionKey: {
        kind: 'Hash'
        paths: [
          '/catalogPartition'
        ]
        version: 2
      }
    }
    options: {}
  }
}

resource publicCatalogContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: galleryDatabase
  name: 'public-catalog'
  properties: {
    resource: {
      id: 'public-catalog'
      indexingPolicy: standardIndexingPolicy
      partitionKey: {
        kind: 'Hash'
        paths: [
          '/catalogPartition'
        ]
        version: 2
      }
    }
    options: {}
  }
}

resource reviewCandidatesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: galleryDatabase
  name: 'review-candidates'
  properties: {
    resource: {
      id: 'review-candidates'
      indexingPolicy: standardIndexingPolicy
      partitionKey: {
        kind: 'Hash'
        paths: [
          '/runKey'
        ]
        version: 2
      }
    }
    options: {}
  }
}

resource reviewDecisionsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: galleryDatabase
  name: 'review-decisions'
  properties: {
    resource: {
      id: 'review-decisions'
      indexingPolicy: standardIndexingPolicy
      partitionKey: {
        kind: 'Hash'
        paths: [
          '/runKey'
        ]
        version: 2
      }
    }
    options: {}
  }
}

resource pipelineRecordsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: galleryDatabase
  name: 'pipeline-records'
  properties: {
    resource: {
      id: 'pipeline-records'
      indexingPolicy: standardIndexingPolicy
      partitionKey: {
        kind: 'Hash'
        paths: [
          '/runKey'
        ]
        version: 2
      }
    }
    options: {}
  }
}

resource appendWriterRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, 'gallery-append-writer')
  properties: {
    roleName: 'gallery-append-writer'
    type: 'CustomRole'
    assignableScopes: [
      cosmosAccount.id
    ]
    permissions: [
      {
        dataActions: [
          'Microsoft.DocumentDB/databaseAccounts/readMetadata'
          'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/create'
          'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read'
        ]
      }
    ]
  }
}

resource itemReaderRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, 'gallery-item-reader')
  properties: {
    roleName: 'gallery-item-reader'
    type: 'CustomRole'
    assignableScopes: [
      cosmosAccount.id
    ]
    permissions: [
      {
        dataActions: [
          'Microsoft.DocumentDB/databaseAccounts/readMetadata'
          'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/executeQuery'
          'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read'
        ]
      }
    ]
  }
}

resource catalogPublisherRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, 'gallery-catalog-publisher')
  properties: {
    roleName: 'gallery-catalog-publisher'
    type: 'CustomRole'
    assignableScopes: [
      cosmosAccount.id
    ]
    permissions: [
      {
        dataActions: [
          'Microsoft.DocumentDB/databaseAccounts/readMetadata'
          'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/executeQuery'
          'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/create'
          'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/read'
          'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers/items/replace'
        ]
      }
    ]
  }
}

resource collectorCandidateWriter 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, pipelineWriterPrincipalId, reviewCandidatesContainer.id, appendWriterRole.id)
  properties: {
    principalId: pipelineWriterPrincipalId
    roleDefinitionId: appendWriterRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/review-candidates'
  }
}

resource collectorAuditWriter 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, pipelineWriterPrincipalId, pipelineRecordsContainer.id, appendWriterRole.id)
  properties: {
    principalId: pipelineWriterPrincipalId
    roleDefinitionId: appendWriterRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/pipeline-records'
  }
}

resource reviewerCatalogReader 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, candidateAnalysisPrincipalId, catalogItemsContainer.id, itemReaderRole.id)
  properties: {
    principalId: candidateAnalysisPrincipalId
    roleDefinitionId: itemReaderRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/catalog-items'
  }
}

resource reviewerCandidateReader 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, candidateAnalysisPrincipalId, reviewCandidatesContainer.id, itemReaderRole.id)
  properties: {
    principalId: candidateAnalysisPrincipalId
    roleDefinitionId: itemReaderRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/review-candidates'
  }
}

resource reviewerDecisionWriter 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, candidateAnalysisPrincipalId, reviewDecisionsContainer.id, appendWriterRole.id)
  properties: {
    principalId: candidateAnalysisPrincipalId
    roleDefinitionId: appendWriterRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/review-decisions'
  }
}

resource reviewerAuditWriter 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, candidateAnalysisPrincipalId, pipelineRecordsContainer.id, appendWriterRole.id)
  properties: {
    principalId: candidateAnalysisPrincipalId
    roleDefinitionId: appendWriterRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/pipeline-records'
  }
}

resource publisherDecisionReader 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, catalogPublisherPrincipalId, reviewDecisionsContainer.id, itemReaderRole.id)
  properties: {
    principalId: catalogPublisherPrincipalId
    roleDefinitionId: itemReaderRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/review-decisions'
  }
}

resource publisherCatalogWriter 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, catalogPublisherPrincipalId, catalogItemsContainer.id, catalogPublisherRole.id)
  properties: {
    principalId: catalogPublisherPrincipalId
    roleDefinitionId: catalogPublisherRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/catalog-items'
  }
}

resource publisherAuditWriter 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, catalogPublisherPrincipalId, pipelineRecordsContainer.id, appendWriterRole.id)
  properties: {
    principalId: catalogPublisherPrincipalId
    roleDefinitionId: appendWriterRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/pipeline-records'
  }
}

resource publisherPublicWriter 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, catalogPublisherPrincipalId, publicCatalogContainer.id, catalogPublisherRole.id)
  properties: {
    principalId: catalogPublisherPrincipalId
    roleDefinitionId: catalogPublisherRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/public-catalog'
  }
}

resource chatbotPublicReader 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, chatPrincipalId, publicCatalogContainer.id, itemReaderRole.id)
  properties: {
    principalId: chatPrincipalId
    roleDefinitionId: itemReaderRole.id
    scope: '${cosmosAccount.id}/dbs/gallery/colls/public-catalog'
  }
}

resource cosmosDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-gallery-cosmos'
  scope: cosmosAccount
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

output cosmosAccountId string = cosmosAccount.id
output cosmosAccountName string = cosmosAccount.name
output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint
output cosmosDatabaseName string = galleryDatabase.name