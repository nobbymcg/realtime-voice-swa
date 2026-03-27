# Realtime Voice Chat

A browser-based voice assistant powered by the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) on Azure, hosted as an [Azure Static Web App](https://learn.microsoft.com/azure/static-web-apps/) with an [Azure Container App](https://learn.microsoft.com/azure/container-apps/) backend.

## How It Works

The app lets users have a live voice conversation with an AI assistant directly in the browser. The frontend captures microphone audio, streams it over a WebSocket to Azure OpenAI's Realtime API, and plays back the assistant's spoken responses — all in real time.

### Architecture

```
┌──────────────────────┐         ┌──────────────────────────────┐
│  Azure Static Web App│         │  Azure Container App         │
│  (Frontend only)     │         │  (API backend)               │
│                      │         │                              │
│  index.html          │─ /api ─▶│  GET  /api/token             │
│  app.js              │  proxy  │  GET  /api/instructions      │
│  style.css           │         │  POST /api/search            │
│                      │         │                              │
└──────────┬───────────┘         └──────────────┬───────────────┘
           │                                    │
           │ WebSocket                          │ Managed Identity
           ▼                                    ▼
    ┌─────────────┐                   ┌──────────────────┐
    │ Azure OpenAI │◀─────────────────│ Azure AD / Entra │
    │ Realtime API │                   └──────────────────┘
    └─────────────┘
```

The Static Web App serves the frontend and proxies `/api/*` requests to a linked Azure Container App backend. This architecture was chosen because SWA's built-in managed Functions do not expose managed identity environment variables to the Functions runtime, making it impossible to use `DefaultAzureCredential` for outbound calls to Azure OpenAI.

### How the Static Web App Uses the Container App Backend

The SWA has a **linked backend** pointing to the Container App. Any request to `/api/*` is transparently proxied to the Container App, which runs an Express server with three endpoints:

| Endpoint | Route | Purpose |
|---|---|---|
| **token** | `GET /api/token` | Authenticates with Azure OpenAI using managed identity (`DefaultAzureCredential`), then returns a short-lived access token along with the endpoint, deployment name, and API version. The frontend uses this token to open a WebSocket directly to the Realtime API — **keeping credentials server-side**. |
| **instructions** | `GET /api/instructions` | Returns the system prompt from `instructions.txt`. This tells the assistant how to behave (greeting, tone, tool usage rules). Serving it from the backend keeps the prompt editable without changing frontend code. |
| **search** | `POST /api/search` | A knowledge base lookup. When the assistant decides it needs to look up information (via the `lookup_info` tool), the frontend calls this endpoint with a search query. The function fetches and caches content from configured URLs, performs keyword matching, and returns relevant text that the assistant uses to ground its response. |

**The key security benefit:** The frontend never handles Azure credentials. The token endpoint uses managed identity to obtain a scoped, short-lived token that only allows the browser to interact with the Realtime API — not to manage Azure resources.

### Conversation Flow

1. User clicks **Connect** → frontend calls `GET /api/token` → receives an access token
2. Frontend calls `GET /api/instructions` → receives the system prompt
3. Frontend opens a WebSocket to Azure OpenAI Realtime API using the token
4. Frontend sends a `session.update` with the instructions, voice settings, and tool definitions
5. User speaks → mic audio is captured at 24kHz, converted to PCM16, and streamed over the WebSocket
6. Azure OpenAI responds with audio + transcript deltas, streamed back in real time
7. If the model invokes the `lookup_info` tool → frontend calls `POST /api/search` → sends the result back over the WebSocket → model uses it to form a grounded response

## Features

- **Voice Activity Detection (VAD)** — hands-free mode with automatic speech detection
- **Push-to-Talk** — hold a button to speak
- **Multiple voices** — Alloy, Ash, Ballad, Coral, Echo, Sage, Shimmer, Verse
- **Live transcript** — real-time text display of both user and assistant speech
- **Audio visualizer** — frequency bar visualization of mic input
- **Knowledge base grounding** — assistant can look up information from configured URLs

## Prerequisites

- An **Azure OpenAI** resource with a Realtime API deployment (e.g., `gpt-realtime`)
- **Node.js 20**
- [SWA CLI](https://github.com/Azure/static-web-apps-cli) (for local development)
- [Docker](https://www.docker.com/) (for building the API container)

## Local Development

1. Clone the repo:
   ```bash
   git clone https://github.com/nobbymcg/realtime-voice-swa.git
   cd realtime-voice-swa
   ```

2. Install dependencies:
   ```bash
   npm install
   npm run install:api
   ```

3. Configure the API — create `api/local.settings.json`:
   ```json
   {
     "IsEncrypted": false,
     "Values": {
       "AzureWebJobsStorage": "",
       "FUNCTIONS_WORKER_RUNTIME": "node",
       "AZURE_OPENAI_ENDPOINT": "https://YOUR-RESOURCE.openai.azure.com/",
       "AZURE_OPENAI_DEPLOYMENT": "gpt-realtime"
     }
   }
   ```

4. Make sure you're logged in to Azure (`az login`) so `DefaultAzureCredential` can authenticate locally.

5. Start the local emulator:
   ```bash
   npx swa start src --api-location api
   ```

6. Open http://localhost:4280 in your browser.

## Deployment

The frontend deploys automatically via **GitHub Actions** — every push to `main` triggers a build and deploy to Azure Static Web Apps.

The API backend runs as a **Container App** linked to the SWA. To update the API, rebuild and push the container image:

```bash
cd api
az containerapp up --name realtime-voice-api --resource-group McGRealtimeVoice --source .
```

### Azure Resources

| Resource | Purpose |
|---|---|
| **Azure Static Web App** (Standard) | Hosts the frontend static files |
| **Azure Container App** | Hosts the API backend (Express server) |
| **Azure Container Registry** | Stores the API container image |
| **Azure OpenAI** | Provides the Realtime API for voice conversations |
| **Managed Identity** | Container App authenticates to Azure OpenAI without API keys |

### Environment Variables (Container App)

Configure these on the Container App via the Azure Portal or CLI:

| Setting | Value |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | Your Realtime API deployment name |

## Project Structure

```
├── src/                     # Frontend (static files served by SWA)
│   ├── index.html           # Main page
│   ├── app.js               # WebSocket, audio, UI logic
│   ├── audio-processor.js   # AudioWorklet for mic capture
│   └── style.css            # Styles
├── api/                     # API backend (Container App)
│   ├── server.js            # Express server (token, instructions, search)
│   ├── Dockerfile           # Container build definition
│   ├── instructions.txt     # System prompt for the assistant
│   ├── package.json         # API dependencies
│   └── src/functions/       # Azure Functions code (local dev with SWA CLI)
│       ├── token.js         # Auth token endpoint
│       ├── instructions.js  # System prompt endpoint
│       └── search.js        # Knowledge base search
├── staticwebapp.config.json # SWA routing config
└── swa-cli.config.json      # Local dev emulator config
```
