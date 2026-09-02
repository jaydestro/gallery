targetScope = 'resourceGroup'

@description('Azure region for regional alert resources.')
param location string

@description('Common gallery resource tags.')
param tags object

@description('Resource ID of the platform action group.')
param actionGroupId string

@description('Resource ID of the Log Analytics workspace.')
param logAnalyticsWorkspaceId string

@description('Resource ID of the Microsoft Foundry account.')
param foundryAccountId string

@description('Resource ID of the Cosmos DB account.')
param cosmosAccountId string

var foundryMetricNamespace = 'Microsoft.CognitiveServices/accounts'
var cosmosMetricNamespace = 'Microsoft.DocumentDB/databaseAccounts'

resource foundryThrottlingAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-foundry-throttling'
  location: 'global'
  tags: tags
  properties: {
    description: 'Any throttled model request in 15 minutes. Disabled until the MAI metric dimensions are validated online.'
    severity: 2
    enabled: false
    scopes: [
      foundryAccountId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'ThrottledRequests'
          metricName: 'AzureOpenAIRequests'
          metricNamespace: foundryMetricNamespace
          dimensions: [
            {
              name: 'StatusCode'
              operator: 'Include'
              values: [
                '429'
              ]
            }
          ]
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          skipMetricValidation: true
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
    autoMitigate: true
    targetResourceType: 'Microsoft.CognitiveServices/accounts'
    targetResourceRegion: location
  }
}

resource foundryServerErrorsAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-foundry-server-errors'
  location: 'global'
  tags: tags
  properties: {
    description: 'Any model server error in 15 minutes. Disabled until the MAI metric dimensions are validated online.'
    severity: 2
    enabled: false
    scopes: [
      foundryAccountId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'ServerErrors'
          metricName: 'AzureOpenAIRequests'
          metricNamespace: foundryMetricNamespace
          dimensions: [
            {
              name: 'StatusCode'
              operator: 'Include'
              values: [
                '500'
                '502'
                '503'
                '504'
              ]
            }
          ]
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          skipMetricValidation: true
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
    autoMitigate: true
    targetResourceType: 'Microsoft.CognitiveServices/accounts'
    targetResourceRegion: location
  }
}

resource foundryUnexpectedVolumeAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-foundry-unexpected-volume'
  location: 'global'
  tags: tags
  properties: {
    description: 'Model request volume exceeds the initial scheduled-run envelope. Disabled until the offline corpus is measured.'
    severity: 2
    enabled: false
    scopes: [
      foundryAccountId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'UnexpectedRequestVolume'
          metricName: 'AzureOpenAIRequests'
          metricNamespace: foundryMetricNamespace
          dimensions: []
          operator: 'GreaterThan'
          threshold: 100
          timeAggregation: 'Total'
          skipMetricValidation: true
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
    autoMitigate: true
    targetResourceType: 'Microsoft.CognitiveServices/accounts'
    targetResourceRegion: location
  }
}

resource cosmosThrottlingAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-cosmos-throttling'
  location: 'global'
  tags: tags
  properties: {
    description: 'Any Cosmos DB HTTP 429 response in 15 minutes.'
    severity: 2
    enabled: true
    scopes: [
      cosmosAccountId
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'ThrottledRequests'
          metricName: 'TotalRequests'
          metricNamespace: cosmosMetricNamespace
          dimensions: [
            {
              name: 'StatusCode'
              operator: 'Include'
              values: [
                '429'
              ]
            }
          ]
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Count'
          skipMetricValidation: true
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
    autoMitigate: true
    targetResourceType: 'Microsoft.DocumentDB/databaseAccounts'
    targetResourceRegion: location
  }
}

resource missedModelEvaluationAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-missed-model-evaluation'
  location: location
  tags: tags
  properties: {
    displayName: 'Gallery missed model evaluation'
    description: 'No successful model invocation during an expected enabled evaluation window. Disabled until live telemetry is calibrated.'
    severity: 3
    enabled: false
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    scopes: [
      logAnalyticsWorkspaceId
    ]
    criteria: {
      allOf: [
        {
          query: 'AzureMetrics | where ResourceId =~ "${foundryAccountId}" | where MetricName =~ "SuccessfulCalls" and Total > 0'
          timeAggregation: 'Count'
          operator: 'LessThan'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroupId
      ]
      customProperties: {}
    }
    autoMitigate: false
    checkWorkspaceAlertsStorageConfigured: false
    skipQueryValidation: true
  }
}