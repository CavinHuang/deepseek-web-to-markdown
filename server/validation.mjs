import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

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

function ipv4FromGroups(high, low) {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function parseIpv6Groups(value) {
  // Expand a valid IPv6 string into eight 16-bit numbers; null when malformed.
  const sections = value.split('::');
  if (sections.length > 2) return null;
  const toGroups = (part) => (part === '' ? [] : part.split(':'));
  let groups;
  if (sections.length === 2) {
    const head = toGroups(sections[0]);
    const tail = toGroups(sections[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = toGroups(sections[0]);
  }
  if (groups.length !== 8) return null;
  const numbers = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    numbers.push(parseInt(group, 16));
  }
  return numbers;
}

function isBlockedIp(hostname) {
  if (isIP(hostname) === 4) return isBlockedIpv4(hostname);
  if (isIP(hostname) !== 6) return false;
  const value = hostname.toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // 识别任意十六进制写法的 IPv4 映射地址（如 ::ffff:7f00:1）与 NAT64 前缀（64:ff9b::/96）。
  const groups = parseIpv6Groups(value);
  if (groups) {
    const firstFiveZero = groups.slice(0, 5).every((group) => group === 0);
    if (firstFiveZero && groups[5] === 0xffff) {
      return isBlockedIpv4(ipv4FromGroups(groups[6], groups[7]));
    }
    const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b
      && groups.slice(2, 6).every((group) => group === 0);
    if (nat64) {
      return isBlockedIpv4(ipv4FromGroups(groups[6], groups[7]));
    }
  }
  return value === '::'
    || value === '::1'
    || /^f[cd]/.test(value)
    || /^fe[89ab]/.test(value)
    || /^ff/.test(value);
}

export async function validateTargetUrl(value) {
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
  // 域名可能把公网名字解析到内网地址（如 127.0.0.1.nip.io）。对非 IP 字面量的主机名
  // 做一次解析并逐一校验；解析失败按拒绝处理，避免在无 DNS 的环境下放行任意名字。
  if (isIP(hostname) === 0) {
    let addresses;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error('无法解析网页域名，请检查链接或稍后重试。');
    }
    if (!Array.isArray(addresses) || addresses.length === 0
      || addresses.some((entry) => isBlockedIp(entry.address))) {
      throw new Error('出于安全原因，不允许抓取本地、内网或保留地址。');
    }
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
