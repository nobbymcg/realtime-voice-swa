import { app } from '@azure/functions';
import { DefaultAzureCredential } from '@azure/identity';

const credential = new DefaultAzureCredential();
const TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

app.http('token', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'token',
  handler: async (request, context) => {
    try {
      const tokenResponse = await credential.getToken(TOKEN_SCOPE);

      return {
        jsonBody: {
          token: tokenResponse.token,
          endpoint: process.env.AZURE_OPENAI_ENDPOINT,
          deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-realtime-preview',
          apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview',
        },
      };
    } catch (err) {
      context.error('Failed to get access token:', err.message);
      return {
        status: 500,
        jsonBody: {
          error: 'Failed to authenticate with Azure OpenAI',
          detail: err.message,
          name: err.name,
        },
      };
    }
  },
});
