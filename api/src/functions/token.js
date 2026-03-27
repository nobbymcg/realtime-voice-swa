import { app } from '@azure/functions';
import { ManagedIdentityCredential } from '@azure/identity';

const credential = new ManagedIdentityCredential();
const TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

app.http('token', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'token',
  handler: async (request, context) => {
    // Debug: try raw IMDS/identity endpoint to see what SWA provides
    const identityEndpoint = process.env.IDENTITY_ENDPOINT;
    const identityHeader = process.env.IDENTITY_HEADER;
    const msiEndpoint = process.env.MSI_ENDPOINT;
    const msiSecret = process.env.MSI_SECRET;

    if (!identityEndpoint && !msiEndpoint) {
      return {
        status: 500,
        jsonBody: {
          error: 'No identity endpoint available',
          env: {
            IDENTITY_ENDPOINT: identityEndpoint || null,
            IDENTITY_HEADER: identityHeader ? '(set)' : null,
            MSI_ENDPOINT: msiEndpoint || null,
            MSI_SECRET: msiSecret ? '(set)' : null,
            AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID || null,
            WEBSITE_INSTANCE_ID: process.env.WEBSITE_INSTANCE_ID || null,
            CONTAINER_NAME: process.env.CONTAINER_NAME || null,
            allIdentityVars: Object.keys(process.env).filter(k => k.includes('IDENTITY') || k.includes('MSI') || k.includes('MANAGED')).join(', ') || 'none',
          },
        },
      };
    }

    try {
      // Try the modern endpoint first, fall back to MSI
      let tokenUrl, headers;
      if (identityEndpoint && identityHeader) {
        tokenUrl = `${identityEndpoint}?resource=https://cognitiveservices.azure.com&api-version=2019-08-01`;
        headers = { 'X-IDENTITY-HEADER': identityHeader };
      } else if (msiEndpoint && msiSecret) {
        tokenUrl = `${msiEndpoint}?resource=https://cognitiveservices.azure.com&api-version=2017-09-01`;
        headers = { 'Secret': msiSecret };
      }

      const res = await fetch(tokenUrl, { headers });
      const raw = await res.text();

      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }

      if (parsed && parsed.access_token) {
        return {
          jsonBody: {
            token: parsed.access_token,
            endpoint: process.env.AZURE_OPENAI_ENDPOINT,
            deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-realtime-preview',
            apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview',
          },
        };
      }

      return {
        status: 500,
        jsonBody: {
          error: 'Token response unexpected',
          statusCode: res.status,
          raw: raw.substring(0, 500),
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
