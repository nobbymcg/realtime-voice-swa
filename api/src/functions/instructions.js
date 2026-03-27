import { app } from '@azure/functions';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.http('instructions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'instructions',
  handler: async (request, context) => {
    try {
      // instructions.txt sits at the api/ root
      const text = readFileSync(join(__dirname, '..', '..', '..', 'instructions.txt'), 'utf-8');
      return {
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      };
    } catch {
      return { status: 404, body: 'Instructions file not found.' };
    }
  },
});
