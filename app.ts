// The HTTP layer: one Node http server, routing to the git, REST, GraphQL and
// MCP handlers. Every reply carries X-GitHub-Request-Id; REST replies carry
// X-OAuth-Scopes. Bearer auth is required on every route except /healthz: when
// MAKEFUN_SHOP_TOKEN is set the token must match it exactly, otherwise any
// non-empty Bearer token is accepted (a missing token is always a 401). A bad
// handler never kills the server — it answers 500 JSON instead.

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function jsonReply(response: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-GitHub-Request-Id': randomUUID(),
    ...extraHeaders,
  });
  response.end(payload);
}

function rawReply(response: http.ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': randomUUID(),
  });
  response.end(body);
}

function authorized(request: http.IncomingMessage): boolean {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return token === expected;
  return true;
}

export function createHandler(store: Store): (request: http.IncomingMessage, response: http.ServerResponse) => void {
  return (request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const method = request.method ?? 'GET';
        const path = url.pathname;

        if (path === '/healthz' && method === 'GET') {
          jsonReply(response, 200, { ok: true });
          return;
        }

        if (!authorized(request)) {
          jsonReply(response, 401, { message: 'Bad credentials' });
          return;
        }

        if (path === '/mcp' && method === 'POST') {
          const raw = (await readBody(request)).toString('utf8');
          const result = handleMcp(store, raw);
          if (result.body === null) {
            response.writeHead(result.status, { 'X-GitHub-Request-Id': randomUUID() });
            response.end();
            return;
          }
          jsonReply(response, result.status, result.body);
          return;
        }

        if (path === '/api/graphql' && method === 'POST') {
          const raw = (await readBody(request)).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            jsonReply(response, 400, { message: 'request body is not valid JSON' });
            return;
          }
          jsonReply(response, 200, handleGraphql(store, parsed));
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((segment) => segment !== '');
          let body: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            const raw = (await readBody(request)).toString('utf8');
            if (raw.trim() !== '') {
              try {
                body = JSON.parse(raw);
              } catch {
                jsonReply(response, 400, { message: 'request body is not valid JSON' }, { 'X-OAuth-Scopes': 'repo, read:org' });
                return;
              }
            }
          }
          const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
          const result = handleRest(store, segments, url.searchParams, method, body, origin);
          jsonReply(response, result.status, result.body, { 'X-OAuth-Scopes': 'repo, read:org', ...(result.headers ?? {}) });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const [, owner, repoName, endpoint] = gitMatch as [string, string, string, string];
          const wantsV2 = (request.headers['git-protocol'] ?? '') === 'version=2';
          if (endpoint === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const result = handleInfoRefs(store, owner as string, repoName as string, service, wantsV2);
            rawReply(response, result.status, result.contentType, result.body);
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(request);
            const result = handleUploadPack(store, owner as string, repoName as string, body, wantsV2);
            rawReply(response, result.status, result.contentType, result.body);
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(request);
            const result = handleReceivePack(store, owner as string, repoName as string, body);
            rawReply(response, result.status, result.contentType, result.body);
            return;
          }
          jsonReply(response, 404, { message: 'Not Found' });
          return;
        }

        jsonReply(response, 404, { message: 'Not Found' });
      } catch (error) {
        if (!response.headersSent) {
          jsonReply(response, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        } else {
          response.destroy();
        }
      }
    })();
  };
}

export function createServer(store: Store): http.Server {
  return http.createServer(createHandler(store));
}
