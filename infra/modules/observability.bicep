targetScope = 'resourceGroup'

@description('Azure region for monitoring resources.')
param location string

@description('Common gallery resource tags.')
param tags object

@description('Email address that receives platform and budget notifications.')
param alertEmail string

@description('First day of the monthly budget period.')
param budgetStartDate string

@description('Principal ID of the managed chatbot workload identity.')
param chatPrincipalId string

var monitoringMetricsPublisherRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '3913510d-42f4-4e42-8a64-420c390055eb'
)

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-gallery-platform-dev-eus2'
  location: location
  tags: tags
  properties: {
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
    workspaceCapping: {
      dailyQuotaGb: 1
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-gallery-chat-dev'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    DisableLocalAuth: true
    IngestionMode: 'LogAnalytics'
    WorkspaceResourceId: logAnalyticsWorkspace.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource platformActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-gallery-platform-dev'
  location: 'global'
  tags: tags
  properties: {
    enabled: true
    groupShortName: 'gallerydev'
    emailReceivers: [
      {
        name: 'deployment-owner'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource chatMetricsPublisherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationInsights.id, chatPrincipalId, monitoringMetricsPublisherRoleDefinitionId)
  scope: applicationInsights
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId
    principalId: chatPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource platformBudget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'budget-gallery-platform-dev'
  properties: {
    amount: 25
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      Actual_GreaterThanOrEqualTo_50_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [
          alertEmail
        ]
        contactGroups: [
          platformActionGroup.id
        ]
      }
      Actual_GreaterThanOrEqualTo_80_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [
          alertEmail
        ]
        contactGroups: [
          platformActionGroup.id
        ]
      }
      Actual_GreaterThanOrEqualTo_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: [
          alertEmail
        ]
        contactGroups: [
          platformActionGroup.id
        ]
      }
    }
  }
}

output logAnalyticsWorkspaceId string = logAnalyticsWorkspace.id
output applicationInsightsId string = applicationInsights.id
output applicationInsightsName string = applicationInsights.name
output applicationInsightsConnectionString string = applicationInsights.properties.ConnectionString
output actionGroupId string = platformActionGroup.id