import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { DefaultAzureCredential } from '@azure/identity';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-realtime';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview';
const PORT = process.env.PORT || 3000;

if (!AZURE_OPENAI_ENDPOINT) {
  console.error('ERROR: AZURE_OPENAI_ENDPOINT must be set.');
  process.exit(1);
}

const credential = new DefaultAzureCredential();
const TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

async function getAccessToken() {
  const tokenResponse = await credential.getToken(TOKEN_SCOPE);
  return tokenResponse.token;
}

// ─── Instructions ──────────────────────────────────────────────────────────
app.get('/api/instructions', (req, res) => {
  try {
    const text = readFileSync(join(__dirname, 'instructions.txt'), 'utf-8');
    res.type('text/plain').send(text);
  } catch {
    res.status(404).send('Instructions file not found.');
  }
});

// ─── Knowledge Base ────────────────────────────────────────────────────────
const KNOWLEDGE_URLS = [
  'https://www.stc.com.sa/en/personal/home.html',
];

const knowledgeCache = new Map();

async function fetchPageText(url) {
  if (knowledgeCache.has(url)) return knowledgeCache.get(url);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    doc.querySelectorAll('script, style, nav, footer, header, iframe').forEach(el => el.remove());
    const text = doc.body?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const trimmed = text.slice(0, 8000);
    knowledgeCache.set(url, trimmed);
    console.log(`[kb] Fetched ${url} (${trimmed.length} chars)`);
    return trimmed;
  } catch (err) {
    console.error(`[kb] Failed to fetch ${url}:`, err.message);
    return '';
  }
}

async function searchKnowledgeBase(query) {
  const pages = await Promise.all(KNOWLEDGE_URLS.map(async (url) => {
    const text = await fetchPageText(url);
    return { url, text };
  }));
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const results = pages
    .map(({ url, text }) => {
      const lower = text.toLowerCase();
      const score = queryTerms.reduce((s, term) => s + (lower.includes(term) ? 1 : 0), 0);
      return { url, text, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (results.length === 0) {
    return pages.map(p => `[${p.url}]\n${p.text}`).join('\n\n---\n\n') || 'No information found in the knowledge base.';
  }
  return results.map(r => `[${r.url}]\n${r.text}`).join('\n\n---\n\n');
}

// ─── Static files ──────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));

// ─── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ─── WebSocket Relay ───────────────────────────────────────────────────────
wss.on('connection', async (clientWs) => {
  console.log('[relay] Client connected');

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.error('[relay] Failed to get access token:', err.message);
    clientWs.send(JSON.stringify({
      type: 'error',
      error: { message: 'Server failed to authenticate with Azure OpenAI' },
    }));
    clientWs.close();
    return;
  }

  // Connect to Azure OpenAI Realtime API (preview endpoint format)
  const host = AZURE_OPENAI_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const openaiUrl = `wss://${host}/openai/realtime?api-version=${AZURE_OPENAI_API_VERSION}&deployment=${AZURE_OPENAI_DEPLOYMENT}`;
  console.log('[relay] Connecting to:', openaiUrl);

  const openaiWs = new WebSocket(openaiUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  let openaiReady = false;
  const pendingMessages = [];

  openaiWs.on('open', () => {
    console.log('[relay] Connected to Azure OpenAI Realtime API');
    openaiReady = true;
    for (const msg of pendingMessages) {
      openaiWs.send(msg);
    }
    pendingMessages.length = 0;
  });

  // Relay: OpenAI → Client
  openaiWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  openaiWs.on('error', (err) => {
    console.error('[relay] OpenAI WS error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'error',
        error: { message: 'Relay lost connection to OpenAI' },
      }));
    }
  });

  openaiWs.on('close', (code, reason) => {
    console.log(`[relay] OpenAI WS closed: ${code} ${reason}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  // Relay: Client → OpenAI (with tool execution intercept)
  clientWs.on('message', async (data) => {
    const msg = data.toString();

    let parsed;
    try {
      parsed = JSON.parse(msg);
    } catch {
      if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(msg);
      } else {
        pendingMessages.push(msg);
      }
      return;
    }

    // Intercept tool execution requests from the client
    if (parsed.type === 'tool_execute') {
      console.log(`[tool] Executing ${parsed.name}(${parsed.arguments})`);

      let output = 'No information found.';
      try {
        const args = JSON.parse(parsed.arguments);
        if (parsed.name === 'lookup_info') {
          output = await searchKnowledgeBase(args.query);
        }
      } catch (err) {
        console.error('[tool] Execution error:', err.message);
        output = `Error looking up information: ${err.message}`;
      }

      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: parsed.call_id,
            output: output,
          },
        }));
        openaiWs.send(JSON.stringify({ type: 'response.create' }));
      }
      return;
    }

    // Normal relay
    if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(msg);
    } else {
      pendingMessages.push(msg);
    }
  });

  clientWs.on('close', () => {
    console.log('[relay] Client disconnected');
    if (openaiWs.readyState === WebSocket.OPEN || openaiWs.readyState === WebSocket.CONNECTING) {
      openaiWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error('[relay] Client WS error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
