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
## Vercel deployment (current)
Vercel functions have no persistent disk, so the database is hosted Turso (libSQL). `api/index.mjs` is the serverless entry and `vercel.json` rewrites every path to it. Env vars (Vercel -> Project -> Settings -> Environment Variables): `NODE_ENV=production`, `DATABASE_URL` (libsql://...), `DATABASE_AUTH_TOKEN`, `ADMIN_SESSION_SECRET` (32+ chars), `API_URL`, `PUBLIC_SITE_URL`, `CORS_ORIGINS`, `COOKIE_SAMESITE=None`, `ALLOWED_DOWNLOAD_HOSTS`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` (remove after first login). Migrations run on cold start. Limits: the rate limiter is per-instance memory, so it is weak on serverless.
(Old Wasmer notes removed.)

## Frontend / domain
Set `CORS_ORIGINS` to the frontend + admin origins, `PUBLIC_SITE_URL` to the site URL (used in QR codes, sitemap). Changing domain = changing env vars only. If admin and API are on different sites use `COOKIE_SAMESITE=None` (HTTPS required).
## Production security checklist
Strong `ADMIN_SESSION_SECRET` (enforced >=32 in production) · HTTPS only · correct `CORS_ORIGINS` · restrict `ALLOWED_DOWNLOAD_HOSTS` · put the API behind a proxy that sets `x-forwarded-for` (rate limits and IP hashes use it) · rotate admin password · keep admin site unindexed (`noindex` already set).
## Backup / recovery
Stop or use `sqlite3 data/exile.db ".backup backup.db"` on a schedule; store off-host; restore by replacing the file and restarting.
## Known limitations
No file upload (media = registered external URLs; use object storage/CDN), in-memory rate limiter (single instance), journal content is plain text (escaped), QR image is generated in the browser via cdnjs `qrcodejs`.
