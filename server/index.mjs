import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBearerKey, validateTargetUrl } from './validation.mjs';
import { createUrlCacheKey, UrlResponseCache } from './url-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const serveStatic = process.env.NODE_ENV === 'production' || process.env.SERVE_STATIC === 'true';
const port = Number(process.env.PORT || (serveStatic ? 4173 : 4313));
const defaultFetchEndpoint = 'https://api.deepseek.com/v1/tools/fetch';
const fetchEndpoint = new URL(process.env.DEEPSEEK_FETCH_ENDPOINT || defaultFetchEndpoint);
if (fetchEndpoint.protocol !== 'https:') {
  throw new Error('DEEPSEEK_FETCH_ENDPOINT must use HTTPS.');
}
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const rateLimitWindowMs = Math.max(1000, Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 600000);
const rateLimitMax = Math.max(1, Number(process.env.API_RATE_LIMIT_MAX) || 120);
const maxRequestBytes = 32 * 1024;
const maxResponseBytes = 5 * 1024 * 1024;
const rateBuckets = new Map();
const urlCacheDirectory = process.env.URL_CACHE_DIR
  ? path.resolve(process.env.URL_CACHE_DIR)
  : path.join(rootDir, 'data', 'url-cache');
const urlCache = new UrlResponseCache({
  directory: urlCacheDirectory,
  memoryEntries: Math.max(1, Number(process.env.URL_CACHE_MEMORY_ENTRIES) || 128),
});
const inFlightFetches = new Map();
let requestCounter = 0;

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function getRequestOrigin(req) {
  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',').at(-1).trim()
    : '';
  const host = forwardedHost || req.headers.host || 'localhost';
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',').at(-1).trim()
    : '';
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + host;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return true;
  const allowed = origin === getRequestOrigin(req) || allowedOrigins.has(origin);
  if (!allowed) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
  return true;
}

function getClientIp(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',').at(-1).trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  const now = Date.now();
  const key = getClientIp(req);
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + rateLimitWindowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  requestCounter += 1;
  if (requestCounter % 100 === 0) {
    for (const [ip, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(ip);
    }
  }
  return {
    allowed: bucket.count <= rateLimitMax,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxRequestBytes) {
        settled = true;
        reject(new Error('请求体过大。'));
        req.resume();
        return;
      }
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (settled) return;
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('请求体必须是有效的 JSON。'));
      }
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

async function readLimitedText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxResponseBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('上游响应超过 5 MB 限制。');
    }
    chunks.push(part.value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function requestJson(url, init) {
  let upstream;
  try {
    upstream = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      status: timedOut ? 504 : 502,
      payload: {
        error: timedOut ? 'upstream_timeout' : 'upstream_unavailable',
        message: timedOut ? 'DeepSeek 请求超时，请稍后重试。' : '无法连接 DeepSeek API，请检查网络或服务配置。',
      },
    };
  }

  try {
    const text = await readLimitedText(upstream);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        status: 502,
        payload: {
          error: 'invalid_upstream_response',
          message: 'DeepSeek API 返回了非 JSON 响应（HTTP ' + upstream.status + '）。',
        },
      };
    }
    return { status: upstream.status, payload };
  } catch (error) {
    return {
      status: 502,
      payload: {
        error: 'upstream_response_error',
        message: error instanceof Error ? error.message : '读取 DeepSeek 响应失败。',
      },
    };
  }
}

async function forwardJsonRequest(url, init, res) {
  const result = await requestJson(url, init);
  sendJson(res, result.status, result.payload);
}

async function handleApi(req, res, url) {
  if (!applyCors(req, res)) {
    sendJson(res, 403, { error: 'origin_not_allowed', message: '当前前端来源不在 API 服务的跨域白名单中。' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Content-Length': '0' });
    res.end();
    return;
  }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, service: 'deepseek-web-to-markdown-api', version: 1 });
    return;
  }
  if (url.pathname !== '/api/fetch' && url.pathname !== '/api/balance') {
    sendJson(res, 404, { error: 'not_found', message: 'API 路由不存在。' });
    return;
  }
  if (url.pathname === '/api/fetch' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed', message: '此路由仅支持 POST。' }, { Allow: 'POST, OPTIONS' });
    return;
  }
  if (url.pathname === '/api/balance' && req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed', message: '此路由仅支持 GET。' }, { Allow: 'GET, OPTIONS' });
    return;
  }

  const rate = checkRateLimit(req);
  if (!rate.allowed) {
    sendJson(res, 429, {
      error: 'rate_limit_exceeded',
      message: 'API 服务请求过于频繁，请等待后重试。',
    }, { 'Retry-After': String(rate.retryAfter) });
    return;
  }

  const apiKey = extractBearerKey(req.headers.authorization);
  if (!apiKey) {
    sendJson(res, 401, { error: 'missing_api_key', message: '请在应用设置中配置有效的 DeepSeek API Key。' });
    return;
  }

  if (url.pathname === '/api/fetch') {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      sendJson(res, 415, { error: 'unsupported_media_type', message: '请求必须使用 application/json。' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: 'invalid_request', message: error instanceof Error ? error.message : '请求体无效。' });
      return;
    }
    let targetUrl;
    try {
      targetUrl = validateTargetUrl(body.url);
    } catch (error) {
      sendJson(res, 400, { error: 'invalid_target_url', message: error instanceof Error ? error.message : '网页 URL 无效。' });
      return;
    }
    const cacheKey = createUrlCacheKey({
      url: targetUrl,
      apiKey,
      upstreamEndpoint: fetchEndpoint.toString(),
    });
    let cached;
    try {
      cached = await urlCache.get(cacheKey);
    } catch {
      console.error('[cache] unable to read URL cache; upstream request blocked to avoid duplicate billing');
      sendJson(res, 503, {
        error: 'url_cache_unavailable',
        message: 'URL 缓存读取失败。为避免重复扣费，本次未重新请求 DeepSeek，请检查服务器缓存目录。',
      });
      return;
    }
    if (cached) {
      sendJson(res, cached.status, cached.payload, { 'X-Cache': 'HIT' });
      return;
    }

    const currentRequest = inFlightFetches.get(cacheKey);
    const joinedInFlight = Boolean(currentRequest);
    let requestPromise = currentRequest;
    if (!requestPromise) {
      requestPromise = (async () => {
        const result = await requestJson(fetchEndpoint.toString(), {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ url: targetUrl }),
        });
        if (result.status < 200 || result.status >= 300) {
          return { ...result, cacheStatus: 'BYPASS' };
        }
        try {
          await urlCache.set(cacheKey, result.status, result.payload);
          return { ...result, cacheStatus: 'MISS' };
        } catch {
          console.error('[cache] failed to persist URL cache; result kept in memory only');
          return { ...result, cacheStatus: 'VOLATILE' };
        }
      })();
      inFlightFetches.set(cacheKey, requestPromise);
      void requestPromise.finally(() => {
        if (inFlightFetches.get(cacheKey) === requestPromise) inFlightFetches.delete(cacheKey);
      }).catch(() => {});
    }

    let result;
    try {
      result = await requestPromise;
    } catch {
      sendJson(res, 502, {
        error: 'upstream_request_failed',
        message: '请求处理失败。请检查服务日志；为避免重复扣费，请勿立即重复提交。',
      });
      return;
    }
    const cacheStatus = joinedInFlight && (result.cacheStatus === 'MISS' || result.cacheStatus === 'VOLATILE')
      ? 'HIT'
      : result.cacheStatus;
    sendJson(res, result.status, result.payload, { 'X-Cache': cacheStatus });
    return;
  }

  const balanceUrl = new URL('/user/balance', fetchEndpoint.origin);
  await forwardJsonRequest(balanceUrl.toString(), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
  }, res);
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function serveFile(req, res, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'invalid_path', message: '请求路径无效。' });
    return;
  }
  const candidate = path.resolve(distDir, '.' + (decodedPath === '/' ? '/index.html' : decodedPath));
  if (candidate !== distDir && !candidate.startsWith(distDir + path.sep)) {
    sendJson(res, 403, { error: 'forbidden', message: '请求路径无效。' });
    return;
  }

  let filePath = candidate;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
    await access(filePath);
  } catch {
    filePath = path.join(distDir, 'index.html');
    try {
      await access(filePath);
    } catch {
      sendJson(res, 503, { error: 'build_missing', message: '未找到前端构建产物，请先运行 npm run build。' });
      return;
    }
  }

  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { error: 'file_read_failed', message: '读取页面失败。' });
    else res.destroy();
  }).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  if (!serveStatic) {
    sendJson(res, 404, { error: 'not_found', message: '开发模式下请通过 Vite 访问前端，API 路由位于 /api。' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed', message: '静态页面仅支持 GET/HEAD。' }, { Allow: 'GET, HEAD' });
    return;
  }
  await serveFile(req, res, url.pathname);
}

const server = createServer((req, res) => {
  route(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: 'API 服务内部错误。' });
    else res.destroy();
  });
});
server.listen(port, '0.0.0.0', () => {
  console.log('[server] listening on port ' + port + (serveStatic ? ' (web + API)' : ' (API only)'));
});
