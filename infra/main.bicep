targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment (e.g., dev, prod)')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

@description('Azure OpenAI endpoint URL')
param azureOpenAiEndpoint string = 'https://mcgrealtimevoice.openai.azure.com/'

@description('Azure OpenAI deployment name')
param azureOpenAiDeployment string = 'gpt-realtime'

@description('Resource group name for the Azure OpenAI resource')
param openAiResourceGroup string = 'McGRealtimeVoice'

@description('Name of the Azure OpenAI resource')
param openAiAccountName string = 'McGRealtimeVoice'

var abbrs = loadJsonContent('./abbreviations.json')
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }

resource rg 'Microsoft.Resources/resourceGroups@2022-09-01' = {
  name: '${abbrs.resourcesResourceGroups}${environmentName}'
  location: location
  tags: tags
}

module containerApps 'modules/container-apps.bicep' = {
  name: 'container-apps'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    azureOpenAiEndpoint: azureOpenAiEndpoint
    azureOpenAiDeployment: azureOpenAiDeployment
    openAiResourceGroup: openAiResourceGroup
    openAiAccountName: openAiAccountName
  }
}

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerApps.outputs.registryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = containerApps.outputs.registryName
output AZURE_CONTAINER_APP_FQDN string = containerApps.outputs.containerAppFqdn
