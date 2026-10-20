import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBearerKey, validateTargetUrl } from './validation.mjs';

test('accepts a public HTTP(S) URL', async () => {
  assert.equal(await validateTargetUrl('https://example.com/article?a=1'), 'https://example.com/article?a=1');
});

test('rejects non-HTTP protocols and embedded credentials', async () => {
  await assert.rejects(() => validateTargetUrl('file:///etc/passwd'), /HTTP 或 HTTPS/);
  await assert.rejects(() => validateTargetUrl('https://user:pass@example.com/'), /用户名或密码/);
});

test('rejects local hostnames and private IPv4 addresses', async () => {
  for (const value of [
    'http://localhost/',
    'http://printer.local/',
    'http://10.0.0.2/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/',
    'http://0x7f000001/',
    'http://2130706433/',
  ]) {
    await assert.rejects(() => validateTargetUrl(value), /不允许抓取本地、内网或保留地址/);
  }
});

test('rejects loopback, link-local and unique-local IPv6 addresses', async () => {
  for (const value of ['http://[::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/']) {
    await assert.rejects(() => validateTargetUrl(value), /不允许抓取本地、内网或保留地址/);
  }
});

test('rejects IPv4-mapped and NAT64 IPv6 literals in any textual form', async () => {
  for (const value of [
    'http://[::ffff:127.0.0.1]/x',
    'http://[::ffff:7f00:1]/x',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/x',
    'http://[64:ff9b::7f00:1]/x',
  ]) {
    await assert.rejects(() => validateTargetUrl(value), /不允许抓取本地、内网或保留地址/);
  }
});

test('rejects hostnames that resolve to loopback or private addresses', async () => {
  // 127.0.0.1.nip.io 由公共 DNS 解析为 127.0.0.1；无网络环境会因解析失败同样被拒绝。
  await assert.rejects(() => validateTargetUrl('http://127.0.0.1.nip.io/x'), /不允许抓取本地、内网或保留地址|无法解析网页域名/);
});

test('extracts a bearer API key without accepting malformed headers', () => {
  assert.equal(extractBearerKey('Bearer sk-example-secret'), 'sk-example-secret');
  assert.equal(extractBearerKey(undefined), null);
  assert.equal(extractBearerKey('Basic abcdefghijkl'), null);
  assert.equal(extractBearerKey('Bearer short'), null);
});
