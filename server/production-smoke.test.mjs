import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function getAvailablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('production HTTP server serves the frontend, built assets, and API health endpoint', async (t) => {
  try {
    await access(path.join(rootDir, 'dist', 'index.html'));
  } catch {
    assert.fail('Production smoke test requires dist/index.html; run npm run build before npm test.');
  }

  const port = await getAvailablePort();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'deepseek-production-smoke-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SERVE_STATIC: 'true',
      PORT: String(port),
      URL_CACHE_DIR: path.join(tempDir, 'url-cache'),
      DEEPSEEK_API_KEY: '',
      BUILTIN_API_ACCESS_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(1500)]);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  let rootResponse;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      assert.fail(`Production server exited early (code ${child.exitCode}). Logs: ${logs}`);
    }
    try {
      rootResponse = await fetch(baseUrl + '/');
      break;
    } catch {
      await delay(100);
    }
  }

  assert.ok(rootResponse, `Production server did not start. Logs: ${logs}`);
  assert.equal(rootResponse.status, 200, 'the public root route must return HTTP 200');
  const html = await rootResponse.text();
  assert.match(html, /id=["']root["']/, 'the root route must return the built React application');
  const scriptMatch = html.match(/src=["']([^"']+\.js)["']/);
  assert.ok(scriptMatch, 'the built HTML must reference a JavaScript asset');

  const assetUrl = new URL(scriptMatch[1], baseUrl + '/');
  const assetResponse = await fetch(assetUrl);
  assert.equal(assetResponse.status, 200, 'the frontend JavaScript asset must be reachable');
  assert.match(assetResponse.headers.get('content-type') || '', /javascript/);

  const healthResponse = await fetch(baseUrl + '/api/health');
  assert.equal(healthResponse.status, 200, 'the API health route must return HTTP 200');
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, 'deepseek-web-to-markdown-api');
});
