/**
 * Tools Proxy — shared HTTP server for container tool APIs
 *
 * Owns the HTTP server on port 8081. Tool modules register route handlers
 * by path prefix; the proxy dispatches incoming requests to the matching handler.
 *
 * Example:
 *   registerRoutes('/todoist', handleTodoistRequest);
 *   registerRoutes('/', handleMtprotoRequest);  // catch-all for legacy paths
 */
import http from 'http';

import { logger } from './logger.js';

const PORT = 8081;

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

const routes: Array<{ prefix: string; handler: RouteHandler }> = [];
let _server: http.Server | null = null;

/**
 * Register a route handler for a path prefix.
 * More specific prefixes are matched first (sorted by length descending).
 * Use '/' as a catch-all for legacy routes.
 */
export function registerRoutes(prefix: string, handler: RouteHandler): void {
  routes.push({ prefix, handler });
  // Sort by prefix length descending so more specific prefixes match first
  routes.sort((a, b) => b.prefix.length - a.prefix.length);
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function startToolsProxy(): void {
  if (_server) return;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const pathname = url.pathname;

    // Find matching route handler by prefix
    const route = routes.find((r) => pathname.startsWith(r.prefix));

    if (!route) {
      jsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    try {
      await route.handler(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ pathname, err }, 'Tools proxy: request error');
      jsonResponse(res, 500, { error: message });
    }
  });

  _server = server;

  server.listen(PORT, '127.0.0.1', () => {
    logger.info({ port: PORT }, 'Tools proxy: HTTP server listening');
  });
}

export function stopToolsProxy(): void {
  if (_server) {
    _server.close();
    _server = null;
  }
}
