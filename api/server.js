import express from 'express';
import { DefaultAzureCredential } from '@azure/identity';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

// ─── Token endpoint ──────────────────────────────────────────────────────────
const credential = new DefaultAzureCredential();
const TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

app.get('/api/token', async (req, res) => {
  try {
    const tokenResponse = await credential.getToken(TOKEN_SCOPE);
    res.json({
      token: tokenResponse.token,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-realtime-preview',
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview',
    });
  } catch (err) {
    console.error('Failed to get access token:', err.message);
    res.status(500).json({ error: 'Failed to authenticate with Azure OpenAI' });
  }
});

// ─── Instructions endpoint ───────────────────────────────────────────────────
app.get('/api/instructions', (req, res) => {
  try {
    const text = readFileSync(join(__dirname, 'instructions.txt'), 'utf-8');
    res.type('text/plain').send(text);
  } catch {
    res.status(404).send('Instructions file not found.');
  }
});

// ─── Search endpoint ─────────────────────────────────────────────────────────
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
    return trimmed;
  } catch {
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

app.post('/api/search', async (req, res) => {
  try {
    const query = req.body?.query;
    if (!query || typeof query !== 'string') {
      return res.status(400).send('Missing or invalid "query" in request body.');
    }
    const result = await searchKnowledgeBase(query);
    res.type('text/plain').send(result);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).send('Internal error during knowledge base search.');
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ─── Start server ────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API server running on port ${port}`));
