# Realtime Voice Chat

A browser-based voice assistant powered by the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) on Azure, hosted as an [Azure Static Web App](https://learn.microsoft.com/azure/static-web-apps/) with an Azure Functions backend.

## How It Works

The app lets users have a live voice conversation with an AI assistant directly in the browser. The frontend captures microphone audio, streams it over a WebSocket to Azure OpenAI's Realtime API, and plays back the assistant's spoken responses — all in real time.

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│              Azure Static Web App                        │
│                                                          │
│  ┌─────────────┐         ┌─────────────────────────┐     │
│  │  Frontend    │─ /api ─▶│  Azure Functions (Node) │     │
│  │  (src/)      │         │  (api/)                 │     │
│  │             │         │                         │     │
│  │  index.html  │         │  GET  /api/token        │     │
│  │  app.js      │         │  GET  /api/instructions │     │
│  │  style.css   │         │  POST /api/search       │     │
│  └──────┬──────┘         └──────────┬──────────────┘     │
│         │                           │                    │
└─────────┼───────────────────────────┼────────────────────┘
          │                           │
          │ WebSocket                 │ Managed Identity
          ▼                           ▼
   ┌─────────────┐          ┌──────────────────┐
   │ Azure OpenAI │◀────────│ Azure AD / Entra │
   │ Realtime API │          └──────────────────┘
   └─────────────┘
```

### How the Static Web App Uses the Azure Functions

Azure Static Web Apps provides a built-in reverse proxy that routes any request to `/api/*` to the Azure Functions backend. The frontend never talks to the Functions directly — it simply calls `/api/token`, `/api/instructions`, or `/api/search` and the SWA infrastructure handles the routing.

The three Azure Functions serve distinct roles:

| Function | Route | Purpose |
|---|---|---|
| **token** | `GET /api/token` | Authenticates with Azure OpenAI using managed identity (`DefaultAzureCredential`), then returns a short-lived access token along with the endpoint, deployment name, and API version. The frontend uses this token to open a WebSocket directly to the Realtime API — **keeping credentials server-side**. |
| **instructions** | `GET /api/instructions` | Returns the system prompt from `api/instructions.txt`. This tells the assistant how to behave (greeting, tone, tool usage rules). Serving it from the backend keeps the prompt editable without changing frontend code. |
| **search** | `POST /api/search` | A knowledge base lookup. When the assistant decides it needs to look up information (via the `lookup_info` tool), the frontend calls this endpoint with a search query. The function fetches and caches content from configured URLs, performs keyword matching, and returns relevant text that the assistant uses to ground its response. |

**The key security benefit:** The frontend never handles Azure credentials. The token function uses managed identity to obtain a scoped, short-lived token that only allows the browser to interact with the Realtime API — not to manage Azure resources.

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

- An **Azure OpenAI** resource with a Realtime API deployment (e.g., `gpt-4o-realtime-preview`)
- **Node.js 20** (Azure Functions v4 requires Node 18 or 20)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-locally) (for local development)
- [SWA CLI](https://github.com/Azure/static-web-apps-cli) (for local development)

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

This project deploys automatically via **GitHub Actions**. Every push to `main` triggers a build and deploy to Azure Static Web Apps.

### Azure Resources

| Resource | Purpose |
|---|---|
| **Azure Static Web App** (Standard) | Hosts frontend + Functions API |
| **Azure OpenAI** | Provides the Realtime API for voice conversations |
| **Managed Identity** | SWA authenticates to Azure OpenAI without API keys |

### App Settings

Configure these in the Azure Portal under **Static Web App → Configuration → Application settings**:

| Setting | Value |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | Your Realtime API deployment name |

## Project Structure

```
├── src/                     # Frontend (static files)
│   ├── index.html           # Main page
│   ├── app.js               # WebSocket, audio, UI logic
│   ├── audio-processor.js   # AudioWorklet for mic capture
│   └── style.css            # Styles
├── api/                     # Azure Functions backend
│   ├── src/functions/
│   │   ├── token.js         # Auth token endpoint
│   │   ├── instructions.js  # System prompt endpoint
│   │   └── search.js        # Knowledge base search
│   ├── instructions.txt     # System prompt for the assistant
│   ├── host.json            # Functions host config
│   └── package.json         # API dependencies
├── staticwebapp.config.json # SWA routing and platform config
└── swa-cli.config.json      # Local dev emulator config
```
