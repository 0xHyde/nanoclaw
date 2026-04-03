import http from 'http';
import { logger } from '../logger.js';
import {
  capture,
  forgetMemory,
  listMemories,
  memoryStats,
  recall,
  storeMemory,
  updateMemory,
} from './engine.js';
import type { SearchResult } from './store.js';

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

export function startMemoryApiServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const pathname = url.pathname;

      if (req.method === 'POST' && pathname === '/memory/recall') {
        const body = (await readBody(req)) as {
          query?: string;
          groupFolder?: string;
        };
        if (!body.query || !body.groupFolder) {
          sendJson(res, 400, { error: 'Missing query or groupFolder' });
          return;
        }
        const memories = await recall(body.query, body.groupFolder);
        sendJson(res, 200, { memories });
        return;
      }

      if (req.method === 'POST' && pathname === '/memory/store') {
        const body = (await readBody(req)) as {
          content?: string;
          scope?: string;
          groupFolder?: string;
          importance?: number;
          kind?: string;
        };
        if (!body.content || !body.groupFolder) {
          sendJson(res, 400, { error: 'Missing content or groupFolder' });
          return;
        }
        const scope = body.scope || `group:${body.groupFolder}`;
        const id = await storeMemory(
          body.content,
          scope,
          body.groupFolder,
          body.importance ?? 0.5,
          body.kind ?? 'general',
        );
        sendJson(res, 200, { id });
        return;
      }

      if (req.method === 'POST' && pathname === '/memory/forget') {
        const body = (await readBody(req)) as { id?: string };
        if (!body.id) {
          sendJson(res, 400, { error: 'Missing id' });
          return;
        }
        await forgetMemory(body.id);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/memory/update') {
        const body = (await readBody(req)) as {
          id?: string;
          content?: string;
          scope?: string;
          groupFolder?: string;
          importance?: number;
          kind?: string;
        };
        if (!body.id || !body.content || !body.groupFolder) {
          sendJson(res, 400, { error: 'Missing id, content or groupFolder' });
          return;
        }
        const scope = body.scope || `group:${body.groupFolder}`;
        await updateMemory(
          body.id,
          body.content,
          scope,
          body.groupFolder,
          body.importance ?? 0.5,
          body.kind ?? 'general',
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/memory/list') {
        const scope = url.searchParams.get('scope') || undefined;
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const memories = await listMemories(scope, limit);
        sendJson(res, 200, { memories });
        return;
      }

      if (req.method === 'GET' && pathname === '/memory/stats') {
        const stats = await memoryStats();
        sendJson(res, 200, stats);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error({ err }, 'Memory API error');
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'Memory API server listening');
  });

  return server;
}
