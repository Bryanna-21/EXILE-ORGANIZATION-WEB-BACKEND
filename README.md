# Exile Organization — Backend API

Zero-dependency Node (>= 22.5) server using built-in `node:sqlite`. Public API + authenticated admin API + tracked download routes.

## Local development
```
cp .env.example .env   # then export vars (e.g. `set -a; . ./.env; set +a`)
npm run migrate        # optional: migrations also run automatically on boot
ADMIN_BOOTSTRAP_EMAIL=you@example.com ADMIN_BOOTSTRAP_PASSWORD='a-long-passphrase' npm run create-admin
npm start              # http://localhost:8787
npm test               # 4 integration tests (auth, CSRF, URL validation, download tracking, SQLi/XSS payloads)
```
## Architecture
`src/server.mjs` = router, auth, generic CRUD, download tracking, stats. `migrations/*.sql` are applied in order and recorded in `_migrations`. Public routes: `GET /api/{products,research_entries,exile_log_entries,journal_posts,portfolio_projects,links}[/slug]`, `/api/portfolio`, `/api/settings`, `/api/qr/:product/:platform`, `/download/:product/:platform`, `/sitemap.xml`, `/health`. Admin routes live under `/api/admin/*` (cookie session + `x-csrf-token` on writes).
## Environment variables
See `.env.example` (all documented there). Never commit real secrets.
## First SuperAdmin
Run `npm run create-admin` with `ADMIN_BOOTSTRAP_EMAIL/PASSWORD` (12+ chars). Re-running resets that admin's password. Change it afterwards in Admin → Account. Roles: `ROLES` map in server.mjs (only SUPERADMIN exists; add EDITOR/ANALYST there).
## Adding a product + release + QR
Admin → Products (already seeded, status literal) → Apps: add `product_id` + `platform` (e.g. `android`) → Releases: add `application_id`, `version`, `url`. `/download/<slug>/<platform>` now resolves the newest active release; QR (Apps → QR) encodes `PUBLIC_SITE_URL/download/<slug>/<platform>` so it stays valid when releases change. Download URLs must be https (in production) and on `ALLOWED_DOWNLOAD_HOSTS`.
## Download analytics
Each hit on the download route stores: product, version, platform, target host, referrer, user agent, `ip_hash` (SHA-256 of IP + date + secret; raw IP never stored; rotates daily), country (`cf-ipcountry` header if present), timestamp. `is_unique` = first hit from that hash on that release in 24h. "Attempts" = redirects served; successful completion cannot be observed by a redirect.
## Wasmer deployment
**Wasmer Edge runs Node 24 via Edge.js (beta), which has no `node:sqlite`.** The server auto-falls back to `node-sqlite3-wasm` (declared in package.json, installed at build). Set these env vars on the app: `DB_DRIVER=wasm`, `DATABASE_URL=/data/exile.db`, `NODE_ENV=production`, `ADMIN_SESSION_SECRET` (32+ chars), `PUBLIC_SITE_URL`, `API_URL`, `CORS_ORIGINS` (frontend + admin origins, no trailing slash), `COOKIE_SAMESITE=None`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`. Add a persistent volume in `app.yaml`: `volumes: [{name: data, mount: /data}]`, otherwise the database resets on every deploy. With no shell, the first SuperAdmin is created automatically at boot when no admin exists and the bootstrap vars are set; remove `ADMIN_BOOTSTRAP_PASSWORD` afterwards. Watch the app logs for `DB driver: ...`.
(Original notes:)
Build: `npm install --omit=dev` (no dependencies). Start: `npm start`. Set env vars from `.env.example` in the Wasmer dashboard, `NODE_ENV=production`, and point `DATABASE_URL` at persistent storage. Health check: `GET /health`. **Not yet verified on Wasmer** — confirm that your Wasmer runtime supports Node >= 22.5 and `node:sqlite`; if not, swap the ~10 `db.*` calls for a Postgres client (schema is plain SQL).
## Frontend / domain
Set `CORS_ORIGINS` to the frontend + admin origins, `PUBLIC_SITE_URL` to the site URL (used in QR codes, sitemap). Changing domain = changing env vars only. If admin and API are on different sites use `COOKIE_SAMESITE=None` (HTTPS required).
## Production security checklist
Strong `ADMIN_SESSION_SECRET` (enforced >=32 in production) · HTTPS only · correct `CORS_ORIGINS` · restrict `ALLOWED_DOWNLOAD_HOSTS` · put the API behind a proxy that sets `x-forwarded-for` (rate limits and IP hashes use it) · rotate admin password · keep admin site unindexed (`noindex` already set).
## Backup / recovery
Stop or use `sqlite3 data/exile.db ".backup backup.db"` on a schedule; store off-host; restore by replacing the file and restarting.
## Known limitations
No file upload (media = registered external URLs; use object storage/CDN), in-memory rate limiter (single instance), journal content is plain text (escaped), QR image is generated in the browser via cdnjs `qrcodejs`.
