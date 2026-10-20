import { timingSafeEqual } from 'node:crypto';
import { extractBearerKey } from './validation.mjs';

export function resolveApiCredential({
  authorizationHeader,
  builtinTokenHeader,
  configuredBuiltinApiKey = '',
  configuredBuiltinAccessToken = '',
}) {
  // Presence of the dedicated header explicitly selects built-in-key mode.
  // Never fall back to a user-supplied Authorization header when this token is wrong.
  if (builtinTokenHeader !== undefined) {
    if (typeof builtinTokenHeader !== 'string') {
      return {
        ok: false,
        status: 403,
        error: 'invalid_builtin_access_token',
        message: '内置 API 访问 Token 无效；未发起 DeepSeek 请求。请检查 Token，或移除 Token 后使用自己的 API Key。',
      };
    }

    const provided = Buffer.from(builtinTokenHeader.trim(), 'utf8');
    const expected = Buffer.from(
      typeof configuredBuiltinAccessToken === 'string' ? configuredBuiltinAccessToken.trim() : '',
      'utf8',
    );

    if (expected.length === 0) {
      return {
        ok: false,
        status: 503,
        error: 'builtin_auth_not_configured',
        message: '服务端尚未配置 BUILTIN_API_ACCESS_TOKEN，无法使用内置 API Key。请移除访问 Token 后使用自己的 API Key。',
      };
    }

    const matches = provided.length === expected.length
      && provided.length > 0
      && timingSafeEqual(provided, expected);
    if (!matches) {
      return {
        ok: false,
        status: 403,
        error: 'invalid_builtin_access_token',
        message: '内置 API 访问 Token 无效；未发起 DeepSeek 请求。请检查 Token，或移除 Token 后使用自己的 API Key。',
      };
    }

    const apiKey = typeof configuredBuiltinApiKey === 'string' ? configuredBuiltinApiKey.trim() : '';
    if (!apiKey) {
      return {
        ok: false,
        status: 503,
        error: 'builtin_api_key_not_configured',
        message: '服务端尚未配置 DEEPSEEK_API_KEY，无法使用内置 API。请联系管理员，或移除访问 Token 后使用自己的 API Key。',
      };
    }

    return { ok: true, apiKey, mode: 'builtin' };
  }

  const apiKey = extractBearerKey(authorizationHeader);
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      error: 'missing_api_credential',
      message: '请填写授权用户的内置 API 访问 Token，或配置自己的 DeepSeek API Key。',
    };
  }
  return { ok: true, apiKey, mode: 'byok' };
}
