import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUrlCacheKey, normalizeCacheUrl, UrlResponseCache } from './url-cache.mjs';

test('normalizes host casing, default ports, and URL fragments', () => {
  assert.equal(
    normalizeCacheUrl('HTTPS://Example.COM:443/article?id=7#section-one'),
    'https://example.com/article?id=7',
  );
  assert.equal(
    normalizeCacheUrl('https://example.com/article?id=7#section-two'),
    'https://example.com/article?id=7',
  );
  assert.notEqual(
    normalizeCacheUrl('https://example.com/article?id=7'),
    normalizeCacheUrl('https://example.com/article?id=8'),
  );
});

test('scopes cache keys to the URL and upstream endpoint, shared across API keys', () => {
  const input = {
    url: 'https://example.com/article#one',
    upstreamEndpoint: 'https://api.deepseek.com/v1/tools/fetch',
  };
  const first = createUrlCacheKey(input);
  assert.equal(first, createUrlCacheKey({ ...input, url: 'https://EXAMPLE.com/article#two' }));
  assert.equal(first, createUrlCacheKey({ url: input.url, upstreamEndpoint: input.upstreamEndpoint }));
  assert.notEqual(first, createUrlCacheKey({ ...input, upstreamEndpoint: 'https://proxy.example.com/fetch' }));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first.includes('sk-test-secret-value'), false);
});

test('persists successful responses and restores them in a new cache instance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepseek-url-cache-'));
  try {
    const key = createUrlCacheKey({
      url: 'https://example.com/article',
      upstreamEndpoint: 'https://api.deepseek.com/v1/tools/fetch',
    });
    const payload = { title: 'Example', markdown: '# Cached article' };
    await new UrlResponseCache({ directory }).set(key, 200, payload);

    const restored = await new UrlResponseCache({ directory }).get(key);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.payload, payload);
    assert.equal(typeof restored.cachedAt, 'string');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fails closed when an existing cache entry is corrupted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepseek-url-cache-corrupt-'));
  try {
    const key = createUrlCacheKey({
      url: 'https://example.com/article',
      upstreamEndpoint: 'https://api.deepseek.com/v1/tools/fetch',
    });
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, key + '.json'), '{broken', 'utf8');
    const cache = new UrlResponseCache({ directory });
    await assert.rejects(cache.get(key), /corrupted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
