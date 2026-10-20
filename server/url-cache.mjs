import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function normalizeCacheUrl(value) {
  const url = new URL(value);
  // Fragments are never sent to the web server, so they must not create separate billable cache entries.
  url.hash = '';
  return url.toString();
}

export function createUrlCacheKey({ url, apiKey, upstreamEndpoint }) {
  const source = [upstreamEndpoint, apiKey, normalizeCacheUrl(url)].join('\0');
  return createHash('sha256').update(source).digest('hex');
}

export class UrlResponseCache {
  constructor({ directory, memoryEntries = 128 }) {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error('URL cache directory is required.');
    }
    this.directory = path.resolve(directory);
    this.memoryEntries = Math.max(1, Number(memoryEntries) || 128);
    this.memory = new Map();
  }

  filePathFor(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) {
      throw new Error('Invalid URL cache key.');
    }
    return path.join(this.directory, key + '.json');
  }

  remember(key, entry) {
    this.memory.delete(key);
    this.memory.set(key, entry);
    while (this.memory.size > this.memoryEntries) {
      const oldestKey = this.memory.keys().next().value;
      if (oldestKey === undefined) break;
      this.memory.delete(oldestKey);
    }
  }

  async get(key) {
    const inMemory = this.memory.get(key);
    if (inMemory) {
      this.remember(key, inMemory);
      return inMemory;
    }

    let raw;
    try {
      raw = await readFile(this.filePathFor(key), 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }

    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      throw new Error('URL cache entry is corrupted.');
    }
    if (
      !entry
      || entry.version !== 1
      || !Number.isInteger(entry.status)
      || entry.status < 200
      || entry.status >= 300
      || !Object.prototype.hasOwnProperty.call(entry, 'payload')
    ) {
      throw new Error('URL cache entry has an invalid format.');
    }
    this.remember(key, entry);
    return entry;
  }

  async set(key, status, payload) {
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new Error('Only successful upstream responses can be cached.');
    }
    const entry = {
      version: 1,
      status,
      payload,
      cachedAt: new Date().toISOString(),
    };
    // Keep the result available in this process even if persistent storage fails.
    this.remember(key, entry);

    const destination = this.filePathFor(key);
    const temporary = destination + '.' + process.pid + '.' + randomUUID() + '.tmp';
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
