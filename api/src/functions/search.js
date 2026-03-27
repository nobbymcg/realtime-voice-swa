import { app } from '@azure/functions';
import { JSDOM } from 'jsdom';

// ─── Knowledge Base Configuration ────────────────────────────────────────────
// Add URLs to ground the assistant's responses in external content.
const KNOWLEDGE_URLS = [
  'https://www.stc.com.sa/en/personal/home.html',
  // 'https://www.stc.com.sa/en/business/home.html',
  // 'https://www.stc.com.sa/en/small-office.html',
];

const knowledgeCache = new Map();

async function fetchPageText(url) {
  if (knowledgeCache.has(url)) return knowledgeCache.get(url);

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Remove scripts, styles, nav, footer for cleaner text
    doc.querySelectorAll('script, style, nav, footer, header, iframe').forEach(el => el.remove());
    const text = doc.body?.textContent?.replace(/\s+/g, ' ').trim() || '';

    // Cache the result (limit to ~8000 chars per page to stay within token budgets)
    const trimmed = text.slice(0, 8000);
    knowledgeCache.set(url, trimmed);
    return trimmed;
  } catch (err) {
    return '';
  }
}

async function searchKnowledgeBase(query) {
  const pages = await Promise.all(KNOWLEDGE_URLS.map(async (url) => {
    const text = await fetchPageText(url);
    return { url, text };
  }));

  // Simple keyword matching — find pages containing query terms
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

// ─── Azure Function ──────────────────────────────────────────────────────────
app.http('search', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'search',
  handler: async (request, context) => {
    try {
      const body = await request.json();
      const query = body?.query;

      if (!query || typeof query !== 'string') {
        return { status: 400, body: 'Missing or invalid "query" in request body.' };
      }

      const result = await searchKnowledgeBase(query);

      return {
        headers: { 'Content-Type': 'text/plain' },
        body: result,
      };
    } catch (err) {
      context.error('Search error:', err.message);
      return { status: 500, body: 'Internal error during knowledge base search.' };
    }
  },
});
