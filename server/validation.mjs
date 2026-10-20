import { isIP } from 'node:net';

function isBlockedIpv4(hostname) {
  if (isIP(hostname) !== 4) return false;
  const parts = hostname.split('.').map(Number);
  const a = parts[0];
  const b = parts[1];
  const c = parts[2];
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function isBlockedIp(hostname) {
  if (isIP(hostname) === 4) return isBlockedIpv4(hostname);
  if (isIP(hostname) !== 6) return false;
  const value = hostname.toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  return value === '::'
    || value === '::1'
    || /^f[cd]/.test(value)
    || /^fe[89ab]/.test(value)
    || /^ff/.test(value);
}

export function validateTargetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('请提供要抓取的网页 URL。');
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('网页 URL 格式无效。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 HTTP 或 HTTPS 网页链接。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('网页 URL 不允许包含用户名或密码。');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const localSuffixes = ['.localhost', '.local', '.internal', '.home.arpa', '.test', '.invalid'];
  if (hostname === 'localhost' || localSuffixes.some((suffix) => hostname.endsWith(suffix)) || isBlockedIp(hostname)) {
    throw new Error('出于安全原因，不允许抓取本地、内网或保留地址。');
  }
  return parsed.toString();
}

export function extractBearerKey(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const key = match[1].trim();
  if (key.length < 8 || key.length > 512 || /[\r\n]/.test(key)) return null;
  return key;
}
