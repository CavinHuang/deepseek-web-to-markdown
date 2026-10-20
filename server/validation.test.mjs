import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBearerKey, validateTargetUrl } from './validation.mjs';

test('accepts a public HTTP(S) URL', () => {
  assert.equal(validateTargetUrl('https://example.com/article?a=1'), 'https://example.com/article?a=1');
});

test('rejects non-HTTP protocols and embedded credentials', () => {
  assert.throws(() => validateTargetUrl('file:///etc/passwd'), /HTTP 或 HTTPS/);
  assert.throws(() => validateTargetUrl('https://user:pass@example.com/'), /用户名或密码/);
});

test('rejects local hostnames and private IPv4 addresses', () => {
  for (const value of [
    'http://localhost/',
    'http://printer.local/',
    'http://10.0.0.2/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1/',
  ]) {
    assert.throws(() => validateTargetUrl(value), /不允许抓取本地、内网或保留地址/);
  }
});

test('rejects loopback, link-local and unique-local IPv6 addresses', () => {
  for (const value of ['http://[::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/']) {
    assert.throws(() => validateTargetUrl(value), /不允许抓取本地、内网或保留地址/);
  }
});

test('extracts a bearer API key without accepting malformed headers', () => {
  assert.equal(extractBearerKey('Bearer sk-example-secret'), 'sk-example-secret');
  assert.equal(extractBearerKey(undefined), null);
  assert.equal(extractBearerKey('Basic abcdefghijkl'), null);
  assert.equal(extractBearerKey('Bearer short'), null);
});
