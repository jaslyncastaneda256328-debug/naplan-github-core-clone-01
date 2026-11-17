// Entry point: node main.ts
//
// With MAKEFUN_ENV_URL set (the conformance harness): listen on port 0, POST
// {"port": N} to $MAKEFUN_ENV_URL/register, then long-poll GET
// $MAKEFUN_ENV_URL/done until {"done": true} and exit 0.
//
// Without it (local development): listen on $PORT (default 8080) and serve
// until killed. The auth token is $MAKEFUN_SHOP_TOKEN when set; without it any
// non-empty Bearer token is accepted.

import { Store } from './store.ts';
import { createServer } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();
const server = createServer(store);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  const url = `${ENV_URL as string}/register`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
    } catch {
      // The harness may not be ready yet; retry.
    }
    await sleep(500);
  }
  throw new Error('could not register with the harness');
}

async function waitForDone(): Promise<void> {
  const url = `${ENV_URL as string}/done`;
  for (;;) {
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // Keep polling; the harness may restart.
    }
    await sleep(500);
  }
}

if (ENV_URL === undefined || ENV_URL === '') {
  const standalonePort = Number(process.env.PORT ?? '8080');
  server.listen(standalonePort, '127.0.0.1', () => {
    console.log(`naplan-github-forge listening on http://127.0.0.1:${standalonePort}`);
  });
} else {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    void (async () => {
      await register(port);
      await waitForDone();
      server.close(() => {
        process.exit(0);
      });
    })().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  });
}

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
