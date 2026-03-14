import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';

import type { SessionManager } from './core/session.js';
import type { WsClientMessage } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createServer(sessionManager: SessionManager) {
  const app = Fastify({ logger: false });

  // Static files
  app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
  });

  // WebSocket plugin + route
  app.register(fastifyWebsocket);

  app.register(async function wsRoutes(fastify) {
    fastify.get('/ws', { websocket: true }, (socket, _req) => {
      let subscribedSessionId: string | null = null;
      let unsubscribe: (() => void) | null = null;

      socket.on('message', (raw: Buffer) => {
        let msg: WsClientMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          socket.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
          return;
        }

        switch (msg.type) {
          case 'subscribe': {
            if (unsubscribe) {
              unsubscribe();
              unsubscribe = null;
            }

            const sessionId = msg.sessionId;
            if (!sessionId || !sessionManager.has(sessionId)) {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  error: `Session ${sessionId} not found`,
                })
              );
              return;
            }

            subscribedSessionId = sessionId;

            const scrollback = sessionManager.getScrollback(sessionId);
            if (scrollback) {
              socket.send(
                JSON.stringify({
                  type: 'scrollback',
                  sessionId,
                  data: scrollback,
                })
              );
            }

            unsubscribe = sessionManager.onData(sessionId, data => {
              socket.send(JSON.stringify({ type: 'output', sessionId, data }));
            });

            sessionManager.onExit(sessionId, () => {
              socket.send(JSON.stringify({ type: 'session_ended', sessionId }));
            });

            break;
          }

          case 'input': {
            const sid = msg.sessionId ?? subscribedSessionId;
            if (sid && sessionManager.has(sid)) {
              sessionManager.write(sid, msg.data ?? '');
            }
            break;
          }

          case 'resize': {
            const sid = msg.sessionId ?? subscribedSessionId;
            if (sid && sessionManager.has(sid) && msg.cols && msg.rows) {
              sessionManager.resize(sid, msg.cols, msg.rows);
            }
            break;
          }
        }
      });

      socket.on('close', () => {
        if (unsubscribe) {
          unsubscribe();
        }
      });
    });
  });

  // REST API
  app.get('/api/sessions', async () => {
    return sessionManager.list();
  });

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (request, reply) => {
      const { id } = request.params;
      if (!sessionManager.has(id)) {
        return reply.code(404).send({ error: `Session ${id} not found` });
      }
      return sessionManager.getInfo(id);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/kill',
    async (request, reply) => {
      const { id } = request.params;
      if (!sessionManager.has(id)) {
        return reply.code(404).send({ error: `Session ${id} not found` });
      }
      sessionManager.kill(id);
      return { ok: true };
    }
  );

  return app;
}
