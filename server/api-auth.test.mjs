import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveApiCredential } from './api-auth.mjs';

const serverConfig = {
  configuredBuiltinApiKey: 'sk-server-secret-key',
  configuredBuiltinAccessToken: 'user-access-token-very-secret',
};

test('uses the server-side built-in key only when the access token matches', () => {
  assert.deepEqual(resolveApiCredential({
    builtinTokenHeader: 'user-access-token-very-secret',
    ...serverConfig,
  }), { ok: true, apiKey: 'sk-server-secret-key', mode: 'builtin' });
});

test('rejects an invalid built-in token without falling back to a supplied user key', () => {
  const result = resolveApiCredential({
    builtinTokenHeader: 'wrong-token',
    authorizationHeader: 'Bearer sk-user-own-key',
    ...serverConfig,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, 'invalid_builtin_access_token');
});

test('uses a visitor-owned API key when no built-in token header is present', () => {
  assert.deepEqual(resolveApiCredential({
    authorizationHeader: 'Bearer sk-user-own-key',
    ...serverConfig,
  }), { ok: true, apiKey: 'sk-user-own-key', mode: 'byok' });
});

test('rejects built-in mode if the server access token is not configured', () => {
  const result = resolveApiCredential({
    builtinTokenHeader: 'some-token',
    configuredBuiltinApiKey: 'sk-server-secret-key',
    configuredBuiltinAccessToken: '',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'builtin_auth_not_configured');
});

test('rejects a valid access token when the server-side API key is missing', () => {
  const result = resolveApiCredential({
    builtinTokenHeader: 'user-access-token-very-secret',
    configuredBuiltinApiKey: '',
    configuredBuiltinAccessToken: 'user-access-token-very-secret',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, 'builtin_api_key_not_configured');
});

test('requires a valid user key when neither built-in token nor user key is supplied', () => {
  const result = resolveApiCredential({ ...serverConfig });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'missing_api_credential');
});
