export const DEFAULT_API_BASE_URL = '/api';

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS' | 'VOLATILE';

export interface FetchResult {
  title: string;
  markdown: string;
  cacheStatus: CacheStatus | null;
}

function pickString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function buildApiUrl(apiBaseUrl: string, path: string): string {
  const base = apiBaseUrl.trim().replace(/\/+$/, '');
  if (!base || base.startsWith('//')) {
    throw new Error('请填写有效的 API 服务地址。');
  }
  if (!base.startsWith('/') && !/^https?:\/\//i.test(base)) {
    throw new Error('API 服务地址必须是站内路径或 HTTP(S) URL。');
  }
  if (/^https?:\/\//i.test(base)) {
    const parsed = new URL(base);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('API 服务地址协议无效。');
    }
  }
  return base + '/' + path;
}

function extractResult(payload: unknown, fallbackTitle: string, cacheStatus: CacheStatus | null): FetchResult {
  if (!payload || typeof payload !== 'object') {
    throw new Error('接口返回内容不是有效的 JSON 对象。');
  }

  const data = payload as Record<string, any>;
  const nested = [data.data, data.result, data.output].find((value) => value && typeof value === 'object') ?? {};
  const choiceText = data.choices?.[0]?.message?.content;
  const markdown = pickString(
    data.markdown,
    data.content,
    data.text,
    data.article,
    nested.markdown,
    nested.content,
    nested.text,
    nested.article,
    choiceText,
  );

  if (!markdown) {
    const detail = pickString(data.message, data.error?.message, data.error, nested.message);
    throw new Error(detail ? '接口未返回 Markdown：' + detail : '接口没有返回可用的正文内容，请检查 Fetch API 的响应格式。');
  }

  const title = pickString(data.title, nested.title, data.name, nested.name) ?? fallbackTitle;
  return { title, markdown, cacheStatus };
}

function buildAuthHeaders(apiKey: string, builtinAccessToken: string, includeContentType = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) headers['Content-Type'] = 'application/json';
  if (builtinAccessToken.trim()) {
    headers['X-Builtin-API-Token'] = builtinAccessToken.trim();
  } else if (apiKey.trim()) {
    headers.Authorization = 'Bearer ' + apiKey.trim();
  }
  return headers;
}

async function readError(response: Response): Promise<string | undefined> {
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') return undefined;
  const data = payload as Record<string, any>;
  return pickString(data.message, data.error?.message, data.error, data.detail);
}

export async function fetchWebpageAsMarkdown(
  url: string,
  apiKey: string,
  apiBaseUrl: string,
  signal: AbortSignal,
  builtinAccessToken = '',
): Promise<FetchResult> {
  const response = await fetch(buildApiUrl(apiBaseUrl, 'fetch'), {
    method: 'POST',
    signal,
    headers: buildAuthHeaders(apiKey, builtinAccessToken, true),
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const message = await readError(response);
    if (response.status === 401 || response.status === 403) {
      throw new Error(message ?? 'API Key 或内置 API 访问 Token 无效，或没有调用权限。');
    }
    if (response.status === 429) {
      throw new Error(message ?? '请求过于频繁或额度不足，请增大请求间隔后重试。');
    }
    throw new Error(message ?? 'API 服务请求失败（HTTP ' + response.status + '）。');
  }

  const payload = await response.json().catch(() => null);
  let fallbackTitle = url;
  try {
    fallbackTitle = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // URL validation is performed by the API service.
  }
  const headerCacheStatus = response.headers.get('X-Cache');
  const cacheStatus: CacheStatus | null = headerCacheStatus === 'HIT'
    || headerCacheStatus === 'MISS'
    || headerCacheStatus === 'BYPASS'
    || headerCacheStatus === 'VOLATILE'
    ? headerCacheStatus
    : null;
  return extractResult(payload, fallbackTitle, cacheStatus);
}

export interface BalanceResult {
  available: boolean;
  currency?: string;
  amount?: string;
}

export async function fetchAccountBalance(apiKey: string, apiBaseUrl: string, builtinAccessToken = ''): Promise<BalanceResult> {
  const response = await fetch(buildApiUrl(apiBaseUrl, 'balance'), {
    method: 'GET',
    headers: buildAuthHeaders(apiKey, builtinAccessToken),
  });
  if (!response.ok) {
    const message = await readError(response);
    throw new Error(message ?? '余额查询失败（HTTP ' + response.status + '）。');
  }

  const payload = await response.json().catch(() => null);
  const data = payload && typeof payload === 'object' ? (payload as Record<string, any>) : {};
  const firstBalance = Array.isArray(data.balance_infos) ? data.balance_infos[0] : undefined;
  const amount = firstBalance?.total_balance ?? firstBalance?.granted_balance ?? data.total_balance;
  const currency = firstBalance?.currency ?? 'CNY';
  return {
    available: Boolean(data.is_available ?? true),
    currency: typeof currency === 'string' ? currency : 'CNY',
    amount: amount === undefined || amount === null ? undefined : String(amount),
  };
}
