# Realtime Voice Chat

A browser-based voice assistant powered by the [Azure OpenAI Realtime API](https://learn.microsoft.com/azure/ai-services/openai/how-to/realtime-audio), deployed as a single [Azure Container App](https://learn.microsoft.com/azure/container-apps/).

## How It Works

The app lets users have a live voice conversation with an AI assistant directly in the browser. A server-side WebSocket relay handles authentication with Azure OpenAI using managed identity, while the frontend captures microphone audio and plays back the assistant's spoken responses — all in real time.

### Architecture

```
┌─────────────────────────────────────────────────┐
│             Azure Container App                 │
│                                                 │
│  ┌──────────────┐     ┌──────────────────────┐  │
│  │  Static Files │     │  WebSocket Relay     │  │
│  │  (Express)    │     │  (server.js)         │  │
│  │               │     │                      │  │
│  │  index.html   │     │  /ws  ◄── Browser WS │  │
│  │  app.js       │     │    │                 │  │
│  │  style.css    │     │    ▼  Azure OpenAI   │  │
│  │               │     │  wss://...realtime   │  │
│  └──────────────┘     └──────────────────────┘  │
│                              │                   │
│                    Managed Identity              │
│                              ▼                   │
│                     ┌──────────────┐             │
│                     │  Entra ID    │             │
│                     └──────┬───────┘             │
└─────────────────────────────┼────────────────────┘
                              ▼
                    ┌──────────────────┐
                    │  Azure OpenAI    │
                    │  Realtime API    │
                    └──────────────────┘
```

**Why a server-side relay?** Browsers cannot set `Authorization` headers on WebSocket connections. Since Azure OpenAI with Entra ID authentication requires a `Bearer` token header, the server must open the upstream WebSocket on behalf of the client and relay messages bidirectionally.

### Key Endpoints

| Route | Purpose |
|---|---|
| `/ws` | WebSocket relay — authenticates with Azure OpenAI via managed identity, opens an upstream WebSocket with `Authorization: Bearer` header, and relays messages between the browser and Azure OpenAI. Also intercepts `tool_execute` messages to run server-side knowledge base searches. |
| `GET /api/instructions` | Returns the system prompt from `instructions.txt`. |
| `GET /api/health` | Health check endpoint. |

### Conversation Flow

1. User clicks **Connect** → frontend fetches `GET /api/instructions` for the system prompt
2. Frontend opens a WebSocket to `/ws` on the Container App
3. Server obtains an Entra ID token via `DefaultAzureCredential` and opens an upstream WebSocket to Azure OpenAI Realtime API with the `Authorization: Bearer` header
4. Server relays the `session.created` event to the client
5. Client sends a `session.update` with instructions, voice settings, and tool definitions
6. User speaks → mic audio is captured at 24kHz PCM16 and streamed through the relay
7. Azure OpenAI responds with audio + transcript deltas, relayed back to the browser
8. If the model invokes the `lookup_info` tool → client sends a `tool_execute` message → server executes the knowledge base search → sends the result back to Azure OpenAI → model uses it to form a grounded response

## Features

- **Voice Activity Detection (VAD)** — hands-free mode with automatic speech detection
- **Push-to-Talk** — hold a button to speak
- **Multiple voices** — Alloy, Ash, Ballad, Coral, Echo, Sage, Shimmer, Verse
- **Live transcript** — real-time text display of both user and assistant speech
- **Audio visualizer** — frequency bar visualization of mic input
- **Knowledge base grounding** — assistant can look up information from configured URLs via server-side search

## Prerequisites

- An **Azure OpenAI** resource with a Realtime API deployment (e.g., `gpt-realtime`)
- **Node.js 20+**
- [Docker](https://www.docker.com/) (for container builds)

## Local Development

1. Clone the repo:
   ```bash
   git clone https://github.com/nobbymcg/realtime-voice-swa.git
   cd realtime-voice-swa
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set environment variables:
   ```bash
   export AZURE_OPENAI_ENDPOINT="https://YOUR-RESOURCE.openai.azure.com/"
   export AZURE_OPENAI_DEPLOYMENT="gpt-realtime"
   ```

4. Make sure you're logged in to Azure (`az login`) so `DefaultAzureCredential` can authenticate locally.

5. Start the server:
   ```bash
   npm start
   ```

6. Open http://localhost:3000 in your browser.

## Deployment

Deploy to Azure Container Apps directly from source:

```bash
az containerapp up --name realtime-voice-api --resource-group McGRealtimeVoice --source .
```

### Azure Resources

| Resource | Purpose |
|---|---|
| **Azure Container App** | Hosts the Express server (frontend + WebSocket relay) |
| **Azure Container Registry** | Stores the container image |
| **Azure OpenAI** | Provides the Realtime API for voice conversations |
| **Managed Identity** | Container App authenticates to Azure OpenAI without API keys |

### Environment Variables (Container App)

| Setting | Value |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | Realtime API deployment name (default: `gpt-realtime`) |
| `AZURE_OPENAI_API_VERSION` | API version (default: `2025-04-01-preview`) |

## Project Structure

```
├── public/                  # Frontend (served as static files)
│   ├── index.html           # Main page
│   ├── app.js               # WebSocket client, audio, UI logic
│   ├── audio-processor.js   # AudioWorklet for 24kHz PCM16 mic capture
│   └── style.css            # Styles
├── server.js                # Express + WebSocket relay server
├── instructions.txt         # System prompt for the assistant
├── Dockerfile               # Container build definition
└── package.json             # Dependencies
```
