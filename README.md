# DeepSeek Web to Markdown

A clean-room, local-first web-to-Markdown workspace inspired by the publicly observable workflow of [DeepSeek 网页转 Markdown](https://deepseek2md.aichris.cc/). This independent project does not copy the original site's private implementation or assets and is not affiliated with DeepSeek or WiseMindAI.

## Features

- Batch capture: paste one HTTP(S) URL per line, deduplicate input, run requests sequentially, and stop an active batch.
- Same-origin API service: the Node.js service forwards Fetch and balance requests to DeepSeek, avoiding browser-to-DeepSeek CORS limitations.
- Persistent URL cache: successful Fetch responses are saved on disk and reused for the same normalized URL, API key, and upstream endpoint. Repeated requests avoid another DeepSeek Fetch call and duplicate billing.
- Duplicate protection: already-saved browser articles are reused without making an API request; concurrent requests for the same URL share one upstream request.
- Bring your own key (BYOK): visitors can enter their own DeepSeek API key.
- Gated built-in key: operators can configure `DEEPSEEK_API_KEY` and `BUILTIN_API_ACCESS_TOKEN` on the server. Only requests with the matching access token use the built-in key; other visitors must provide their own key.
- Invalid built-in tokens are rejected with HTTP 403 and never fall back to a visitor's API key or trigger an upstream request.
- Local-first storage: articles are saved in browser IndexedDB and restored after refresh. The API key and API service URL are saved in browser localStorage.
- Markdown workspace: edit the title and source, preview changes immediately, switch between split, edit-only, and preview-only layouts, and see real save status instead of a permanent “saved” label.
- Article management: search the local library, select all filtered results or individual articles, bulk-delete selected articles, and export selected articles individually or as a ZIP.
- Export: download the current Markdown, trigger one download per saved article, or package the full library into a ZIP archive.
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
npm run typecheck
npm run build
npm test
npm start
~~~

The production smoke test runs after the frontend build and verifies that `/`, a built JavaScript asset, and `/api/health` all return successful responses.

The production server serves the built frontend and API on the same port. The default port is 4173; hosting platforms can set PORT. For local production preview, run npm run build followed by npm run preview.

## API endpoints

- GET /api/health — service health; no key required.
- POST /api/fetch — body: { "url": "https://example.com/article" }; accepts either `Authorization: Bearer YOUR_DEEPSEEK_API_KEY` for BYOK or `X-Builtin-API-Token: YOUR_ACCESS_TOKEN` for authorized built-in-key access.
- GET /api/balance — queries the selected account balance; accepts the same two authentication modes.
- When `X-Builtin-API-Token` is present, it explicitly selects built-in-key mode. A wrong token is rejected with HTTP 403 even if an Authorization header is also supplied.

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
- DEEPSEEK_API_KEY — optional server-side DeepSeek key used only in built-in-key mode.
- BUILTIN_API_ACCESS_TOKEN — shared secret required to use `DEEPSEEK_API_KEY`; generate a strong random value (for example, `openssl rand -hex 32`) and share it only with authorized users.
- DEEPSEEK_FETCH_ENDPOINT — trusted HTTPS DeepSeek-compatible Fetch endpoint.
- API_RATE_LIMIT_MAX — requests per client per window (default 120).
- API_RATE_LIMIT_WINDOW_MS — rate-limit window in milliseconds (default 600000).
- URL_CACHE_DIR — persistent disk directory for successful URL responses (default `./data/url-cache` relative to the project root).
- URL_CACHE_MEMORY_ENTRIES — maximum in-memory cache entries (default 128; disk entries are retained).
- ALLOWED_ORIGINS — comma-separated frontend origins allowed to call the API cross-origin. Same-origin calls work without this setting.
- TRUST_PROXY — set true only when running behind a trusted reverse proxy that sets X-Forwarded-For; enables client-IP-based rate limiting.

## Deploy with Docker Compose (recommended)

The repository includes `docker-compose.yaml` (and the `.yml` compatibility alias for Dokploy). It builds the application, explicitly enables production static serving, exposes container port `4173`, verifies both the frontend root page and `/api/health`, and mounts a named Docker volume so the URL cache survives container replacement and image updates.

~~~sh
docker compose up -d --build
docker compose ps
docker compose logs -f app
~~~

Open `http://localhost:4173`. To change the host port, set `APP_PORT` in your shell or `.env` file (for example, `APP_PORT=8080` exposes the app on port 8080 while the container still listens on 4173).

To update after new commits, run `docker compose up -d --build` again. The named volume `deepseek-web-to-markdown-url-cache` is retained when containers are recreated. **Do not run `docker compose down -v` unless you intentionally want to delete the persistent cache**; losing it can cause old URLs to be requested again.

For Dokploy, use Compose Path `./docker-compose.yml` (the repository keeps this compatibility filename alongside `docker-compose.yaml` because some Dokploy versions fail to locate the `.yaml` extension). Route traffic to container port `4173` and keep the named volume mounted at `/app/data`. Keep both Compose files identical when editing deployment settings. To enable built-in-key access, set `DEEPSEEK_API_KEY` and `BUILTIN_API_ACCESS_TOKEN` in Dokploy's environment-variable settings. Do not commit real values to the repository. If either value is missing, built-in-key mode is unavailable; BYOK continues to work. Cache files are retained rather than evicted, so reserve disk space as the library grows. The in-flight duplicate guard is per process; use one API replica unless you add a shared cache with distributed locking.

### Run directly with Docker (alternative)

~~~sh
docker build -t deepseek-web-to-markdown .
docker volume create deepseek-url-cache
docker run --rm -p 4173:4173 -v deepseek-url-cache:/app/data deepseek-web-to-markdown
~~~

## Security and privacy

- A visitor-owned API key and the optional built-in access token are saved in this browser's localStorage. Use HTTPS in production and only configure a service you trust.
- The built-in DeepSeek key and its access token remain server-side environment variables and are never sent to the browser or upstream response.
- The API service does not persist or log API keys or access tokens and does not accept an arbitrary upstream endpoint from the browser.
- Cache filenames are SHA-256 hashes of the normalized URL, upstream endpoint, and API key; the raw API key is not stored. Cache data is isolated by API key and endpoint.
- Successful Fetch responses are retained on disk indefinitely to prevent repeat billing. Protect the persistent cache volume because it contains captured webpage content.
- Requests are rate-limited in memory. For multi-instance deployments, use an external shared rate limiter or gateway-level limits.
- Target URLs must use HTTP(S); local hostnames, credentials in URLs, and common private/reserved IP ranges are rejected. This is a defense-in-depth measure, not a substitute for upstream network isolation.
- Captured articles remain in browser IndexedDB. Clearing site data removes them.
- DeepSeek calls may incur charges. Check your account quota before large batches.

## Project structure

~~~text
server/
  index.mjs             API proxy and production static server
  url-cache.mjs         Persistent URL response cache and cache-key hashing
  url-cache.test.mjs    Cache normalization, persistence, and corruption tests
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
