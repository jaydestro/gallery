targetScope = 'resourceGroup'

@description('Azure region for the workload identities.')
param location string

@description('Common gallery resource tags.')
param tags object

var githubIssuer = 'https://token.actions.githubusercontent.com'
var azureTokenExchangeAudience = 'api://AzureADTokenExchange'

resource modelEvaluationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gallery-model-eval-dev'
  location: location
  tags: tags
}

resource candidateAnalysisIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gallery-candidate-analysis-dev'
  location: location
  tags: tags
}

resource pipelineWriterIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gallery-pipeline-writer-dev'
  location: location
  tags: tags
}

resource catalogPublisherIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gallery-catalog-publisher-dev'
  location: location
  tags: tags
}

resource chatIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-gallery-chat-dev'
  location: location
  tags: tags
}

resource modelEvaluationFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: modelEvaluationIdentity
  name: 'fic-gallery-model-evaluation'
  properties: {
    issuer: githubIssuer
    subject: 'repo:jaydestro/gallery:environment:gallery-model-evaluation'
    audiences: [
      azureTokenExchangeAudience
    ]
  }
}

resource candidateAnalysisFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: candidateAnalysisIdentity
  name: 'fic-gallery-candidate-analysis'
  properties: {
    issuer: githubIssuer
    subject: 'repo:jaydestro/gallery:environment:gallery-candidate-analysis'
    audiences: [
      azureTokenExchangeAudience
    ]
  }
}

resource pipelineStorageFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: pipelineWriterIdentity
  name: 'fic-gallery-pipeline-storage'
  properties: {
    issuer: githubIssuer
    subject: 'repo:jaydestro/gallery:environment:gallery-pipeline-storage'
    audiences: [
      azureTokenExchangeAudience
    ]
  }
}

resource publicationFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: catalogPublisherIdentity
  name: 'fic-gallery-publication'
  properties: {
    issuer: githubIssuer
    subject: 'repo:jaydestro/gallery:environment:gallery-publication'
    audiences: [
      azureTokenExchangeAudience
    ]
  }
}

output modelEvaluationPrincipalId string = modelEvaluationIdentity.properties.principalId
output modelEvaluationClientId string = modelEvaluationIdentity.properties.clientId
output candidateAnalysisPrincipalId string = candidateAnalysisIdentity.properties.principalId
output candidateAnalysisClientId string = candidateAnalysisIdentity.properties.clientId
output pipelineWriterPrincipalId string = pipelineWriterIdentity.properties.principalId
output pipelineWriterClientId string = pipelineWriterIdentity.properties.clientId
output catalogPublisherPrincipalId string = catalogPublisherIdentity.properties.principalId
output catalogPublisherClientId string = catalogPublisherIdentity.properties.clientId
output chatIdentityId string = chatIdentity.id
output chatPrincipalId string = chatIdentity.properties.principalId
output chatClientId string = chatIdentity.properties.clientId