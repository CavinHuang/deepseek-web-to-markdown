# DeepSeek Web to Markdown

A clean-room, local-first web-to-Markdown workspace inspired by the publicly observable workflow of [DeepSeek 网页转 Markdown](https://deepseek2md.aichris.cc/). This independent project does not copy the original site's private implementation or assets and is not affiliated with DeepSeek or WiseMindAI.

## Features

- Batch capture: paste one HTTP(S) URL per line, deduplicate input, run requests sequentially, and stop an active batch.
- Same-origin API service: the Node.js service forwards Fetch and balance requests to DeepSeek, avoiding browser-to-DeepSeek CORS limitations.
- Bring your own key (BYOK): enter your own DeepSeek API key in the UI. The browser sends it to your configured API service over HTTPS; the service forwards it upstream but does not persist or log it.
- Local-first storage: articles are saved in browser IndexedDB and restored after refresh. The API key and API service URL are saved in browser localStorage.
- Markdown workspace: edit the title and source, preview changes immediately, and switch between split, edit-only, and preview-only layouts.
- Export: download the current Markdown, trigger one download per saved article, or package the library into a ZIP archive.
- Responsive UI and sanitized Markdown preview.
- API health endpoint, request size limits, upstream timeout, URL validation, CORS allowlist, and in-memory rate limiting.

## Requirements

- Node.js 22 recommended (Node.js 20+)
- A DeepSeek API key with access to the Fetch endpoint

## Local development

~~~sh
npm install
npm run dev
~~~

Vite starts at http://localhost:4173. The API service runs at http://localhost:4313 and Vite proxies /api requests to it.

## Test and build

~~~sh
npm test
npm run typecheck
npm run build
npm start
~~~

The production server serves the built frontend and API on the same port. The default port is 4173; hosting platforms can set PORT. For local production preview, run npm run build followed by npm run preview.

## API endpoints

- GET /api/health — service health; no key required.
- POST /api/fetch — body: { "url": "https://example.com/article" }; requires Authorization: Bearer YOUR_DEEPSEEK_API_KEY.
- GET /api/balance — queries the DeepSeek account balance; requires the same Bearer header.

The default upstream endpoint is https://api.deepseek.com/v1/tools/fetch. Override it with DEEPSEEK_FETCH_ENDPOINT if your trusted upstream uses a compatible API. The balance route uses /user/balance on the same upstream origin.

Example:

~~~sh
curl -X POST http://localhost:4173/api/fetch \
  -H "Authorization: Bearer YOUR_DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/article"}'
~~~

## Configuration

Copy .env.example to .env if your deployment tooling loads environment files. The Node server itself does not automatically read .env files; configure these variables in your shell, Docker, or deployment platform.

- PORT — listen port (production default 4173; API-only development default 4313).
- DEEPSEEK_FETCH_ENDPOINT — trusted HTTPS DeepSeek-compatible Fetch endpoint.
- API_RATE_LIMIT_MAX — requests per client per window (default 120).
- API_RATE_LIMIT_WINDOW_MS — rate-limit window in milliseconds (default 600000).
- ALLOWED_ORIGINS — comma-separated frontend origins allowed to call the API cross-origin. Same-origin calls work without this setting.
- TRUST_PROXY — set true only when running behind a trusted reverse proxy that sets X-Forwarded-For; enables client-IP-based rate limiting.

## Deploy with Docker

~~~sh
docker build -t deepseek-web-to-markdown .
docker run --rm -p 4173:4173 deepseek-web-to-markdown
~~~

For Dokploy or another container platform, use the repository Dockerfile and expose the port supplied by the platform. The service requires no server-side DeepSeek key because it uses BYOK.

## Security and privacy

- The API key is saved in this browser's localStorage and sent in the Authorization header to the API service for each request. Use HTTPS in production and only configure a service you trust.
- The API service does not persist or log API keys and does not accept an arbitrary upstream endpoint from the browser.
- Requests are rate-limited in memory. For multi-instance deployments, use an external shared rate limiter or gateway-level limits.
- Target URLs must use HTTP(S); local hostnames, credentials in URLs, and common private/reserved IP ranges are rejected. This is a defense-in-depth measure, not a substitute for upstream network isolation.
- Captured articles remain in browser IndexedDB. Clearing site data removes them.
- DeepSeek calls may incur charges. Check your account quota before large batches.

## Project structure

~~~text
server/
  index.mjs             API proxy and production static server
  validation.mjs        URL and bearer-key validation
  validation.test.mjs   API input validation tests
src/
  App.tsx               Main workspace UI
  main.tsx              React entry point
  styles.css            Responsive styles
  lib/
    db.ts               IndexedDB persistence
    deepseek.ts         Browser client for the local API service
    download.ts         Markdown and ZIP exports
~~~

## License

MIT. See LICENSE.
