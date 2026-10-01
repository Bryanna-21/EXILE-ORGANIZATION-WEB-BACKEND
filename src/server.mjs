import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const E = process.env, num = (v, d) => Number(v) || d;
const PROD = E.NODE_ENV === 'production';
const PORT = num(E.PORT, 8787);
const DB_PATH = E.DATABASE_URL || './data/exile.db';
const SECRET = E.ADMIN_SESSION_SECRET || '';
const CORS = (E.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC = (E.PUBLIC_SITE_URL || '').replace(/\/$/, '');
const API = (E.API_URL || '').replace(/\/$/, '');
const HOSTS = (E.ALLOWED_DOWNLOAD_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const TTL = num(E.SESSION_TTL_HOURS, 12) * 3600e3;
if (PROD && SECRET.length < 32) { console.error('ADMIN_SESSION_SECRET must be >=32 chars in production'); process.exit(1); }

// ---------- DB adapter + migrations ----------
// node:sqlite is unavailable on Wasmer Edge (Edge.js); fall back to node-sqlite3-wasm there.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
async function openDb() {
  const want = (E.DB_DRIVER || 'auto').toLowerCase();
  if (want !== 'wasm') {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const d = new DatabaseSync(DB_PATH); d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
      console.log('DB driver: node:sqlite');
      return { all: (s, a) => d.prepare(s).all(...a), get: (s, a) => d.prepare(s).get(...a), run: (s, a) => d.prepare(s).run(...a), exec: s => d.exec(s) };
    } catch (e) { if (want === 'node') throw e; console.warn('node:sqlite unavailable, falling back to node-sqlite3-wasm'); }
  }
  const mod = await import('node-sqlite3-wasm'); const Database = mod.Database ?? mod.default?.Database ?? mod.default;
  const d = new Database(DB_PATH); d.exec('PRAGMA foreign_keys=ON;');
  console.log('DB driver: node-sqlite3-wasm');
  return { all: (s, a) => d.all(s, a), get: (s, a) => d.get(s, a) ?? undefined, run: (s, a) => d.run(s, a), exec: s => d.exec(s) };
}
const db = await openDb();
const q = (sql, ...a) => db.all(sql, a), one = (sql, ...a) => db.get(sql, a), run = (sql, ...a) => db.run(sql, a);
export function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations(name TEXT PRIMARY KEY)');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (one('SELECT 1 x FROM _migrations WHERE name=?', f)) continue;
    db.exec('BEGIN'); try { db.exec(fs.readFileSync(new URL(f, dir), 'utf8')); run('INSERT INTO _migrations VALUES(?)', f); db.exec('COMMIT'); console.log('migrated', f); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
migrate();

// ---------- crypto ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = pw => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
const checkPw = (pw, h) => { const [, s, k] = h.split('$'); const d = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(d, Buffer.from(k, 'hex')); };
const DUMMY = hashPw('dummy-password-for-timing');

if (process.argv.includes('--migrate-only')) process.exit(0);
if (process.argv.includes('--create-admin')) {
  const email = (E.ADMIN_BOOTSTRAP_EMAIL || '').toLowerCase(), pw = E.ADMIN_BOOTSTRAP_PASSWORD || '';
  if (!email.includes('@') || pw.length < 12) { console.error('Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD (>=12 chars).'); process.exit(1); }
  const ex = one('SELECT id FROM admins WHERE email=?', email);
  if (ex) run('UPDATE admins SET password_hash=?,failed=0,locked_until=0 WHERE id=?', hashPw(pw), ex.id); else run('INSERT INTO admins(email,password_hash) VALUES(?,?)', email, hashPw(pw));
  console.log(ex ? 'SuperAdmin password reset.' : 'SuperAdmin created.'); process.exit(0);
}

// Auto-bootstrap: only when NO admin exists and bootstrap env vars are set (useful where there is no shell).
{ const em = (E.ADMIN_BOOTSTRAP_EMAIL || '').toLowerCase(), pw = E.ADMIN_BOOTSTRAP_PASSWORD || '';
  if (!one('SELECT 1 x FROM admins') && em.includes('@') && pw.length >= 12) { run('INSERT INTO admins(email,password_hash) VALUES(?,?)', em, hashPw(pw)); console.log('First SuperAdmin created. Remove ADMIN_BOOTSTRAP_PASSWORD from env now.'); } }

// ---------- helpers ----------
class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m = 'Invalid input') => new HttpError(400, m);
const audit = (admin, action, entity, id, meta) => run('INSERT INTO audit_logs(admin_id,action,entity,entity_id,meta) VALUES(?,?,?,?,?)', admin?.id ?? null, action, entity, String(id ?? ''), JSON.stringify(meta ?? {}));
const hits = new Map();
const limited = (key, max) => { const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < 60e3); h.push(now); hits.set(key, h); return h.length > max; };
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 60e3)) hits.delete(k); }, 60e3).unref();
const validUrl = (u, { allowRelative = false } = {}) => { if (typeof u !== 'string' || u.length > 2048) return false; if (allowRelative && /^\/[^/\\]/.test(u)) return true; try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) && !x.username; } catch { return false; } };
const downloadOk = u => { if (!validUrl(u)) return false; const h = new URL(u).hostname.toLowerCase(); if (PROD && new URL(u).protocol !== 'https:') return false; return !HOSTS.length || HOSTS.some(a => h === a || h.endsWith('.' + a)) || (API && h === new URL(API).hostname); };

// ---------- generic content config ----------
const CFG = {
  products: { key: 'slug', pub: 'published=1', order: 'sort,id' },
  applications: {}, app_releases: {},
  exile_log_entries: { pub: 'published=1', order: 'date DESC,id DESC' },
  research_entries: { key: 'slug', pub: 'published=1', order: 'date DESC,id DESC' },
  journal_posts: { key: 'slug', pub: 'published=1', order: 'date DESC,id DESC' },
  portfolio_projects: { pub: 'published=1', order: 'sort,id' },
  links: { pub: 'active=1', order: 'id' },
  media: {},
};
for (const [t, c] of Object.entries(CFG)) c.cols = q(`PRAGMA table_info(${t})`).map(r => r.name).filter(n => !['id', 'created_at', 'updated_at'].includes(n)).concat([]);
const JSONCOLS = new Set(['screenshots', 'skills', 'technologies', 'experience', 'education', 'achievements', 'publications']);
function clean(t, body, partial) {
  const c = CFG[t], out = {};
  for (const k of c.cols) {
    if (!(k in body)) continue;
    let v = body[k];
    if (v === '' || v === undefined) v = null;
    if (v !== null && typeof v === 'object') v = JSON.stringify(v);
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (typeof v === 'string' && v.length > 200000) throw bad(`${k} too long`);
    if (v !== null && /(^|_)url$/.test(k)) { if (!validUrl(v, { allowRelative: t === 'media' || k === 'icon_url' || k === 'cover_url' || k === 'image_url' })) throw bad(`Invalid URL in ${k}`); if (t === 'app_releases' && !downloadOk(v)) throw bad('Download host not allowed'); }
    if (k === 'slug' && !/^[a-z0-9-]{1,80}$/.test(v || '')) throw bad('slug must be lowercase letters, digits, hyphens');
    out[k] = v;
  }
  if (!partial) for (const r of q(`PRAGMA table_info(${t})`)) if (r.notnull && r.dflt_value === null && !r.pk && !r.name.endsWith('_at') && out[r.name] == null) throw bad(`${r.name} is required`);
  return out;
}
const pubRow = r => { if (!r) return r; for (const k of JSONCOLS) if (typeof r[k] === 'string') try { r[k] = JSON.parse(r[k]); } catch {} return r; };

// ---------- request plumbing ----------
const ip = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const body = req => new Promise((res, rej) => { let n = 0; const b = []; req.on('data', d => { n += d.length; if (n > 1e6) { rej(new HttpError(413, 'Request too large')); req.destroy(); } else b.push(d); }); req.on('end', () => { if (!b.length) return res({}); try { const j = JSON.parse(Buffer.concat(b)); if (typeof j !== 'object' || j === null || Array.isArray(j)) throw 0; res(j); } catch { rej(bad('Invalid JSON')); } }); });
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(a => a[0]).map(([k, ...v]) => [k, v.join('=')]));
function send(res, status, data, extra = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(data)); }
function sessionOf(req) { const t = cookies(req).exile_sid; if (!t) return null; const s = one('SELECT s.*,a.email,a.role FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE token_hash=?', sha(t)); if (!s || s.expires_at < Date.now()) return null; return s; }
const cookie = (v, maxAge) => `exile_sid=${v}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=${E.COOKIE_SAMESITE || 'Lax'}${PROD || E.COOKIE_SAMESITE === 'None' ? '; Secure' : ''}`;
const ROLES = { SUPERADMIN: ['*'] }; // extend: EDITOR: ['content'], ANALYST: ['stats'] ...
const can = (role, perm) => (ROLES[role] || []).some(p => p === '*' || p === perm);

// ---------- downloads ----------
function download(req, res, product, platform) {
  const row = one(`SELECT p.id pid,a.id aid,r.id rid,r.version,r.url FROM products p JOIN applications a ON a.product_id=p.id JOIN app_releases r ON r.application_id=a.id
    WHERE p.slug=? AND a.platform=? AND p.published=1 AND r.active=1 ORDER BY r.id DESC LIMIT 1`, product.toLowerCase(), platform.toLowerCase());
  if (!row) return send(res, 404, { error: 'No active release for this product/platform.' });
  if (!downloadOk(row.url)) return send(res, 502, { error: 'Download unavailable.' });
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  const h = sha(`${ip(req)}|${day}|${SECRET}`).slice(0, 24); // daily-rotating salted hash; raw IP never stored
  const dup = one('SELECT 1 x FROM download_events WHERE ip_hash=? AND release_id=? AND ts>?', h, row.rid, now - 864e5);
  const ref = (req.headers.referer || '').slice(0, 300) || null;
  run('INSERT INTO download_events(product_id,release_id,platform,version,target,referrer,user_agent,ip_hash,country,is_unique,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    row.pid, row.rid, platform.toLowerCase(), row.version, new URL(row.url).hostname, ref, (req.headers['user-agent'] || '').slice(0, 300), h, req.headers['cf-ipcountry'] || null, dup ? 0 : 1, now);
  res.writeHead(302, { location: row.url, 'cache-control': 'no-store' }); res.end();
}

// ---------- stats ----------
function stats() {
  const n = (w) => one(`SELECT COUNT(*) c FROM download_events ${w}`).c, since = d => `WHERE ts>${Date.now() - d * 864e5}`;
  return {
    products: one('SELECT COUNT(*) c FROM products').c, applications: one('SELECT COUNT(*) c FROM applications').c,
    attempts_total: n(''), unique_total: n('WHERE is_unique=1'), today: n(since(1)), week: n(since(7)), month: n(since(30)),
    by_product: q('SELECT p.name,COUNT(*) attempts,SUM(is_unique) uniques FROM download_events d JOIN products p ON p.id=d.product_id GROUP BY p.id ORDER BY attempts DESC'),
    by_platform: q('SELECT platform,COUNT(*) attempts,SUM(is_unique) uniques FROM download_events GROUP BY platform ORDER BY attempts DESC'),
    by_version: q('SELECT p.name,d.version,COUNT(*) attempts FROM download_events d JOIN products p ON p.id=d.product_id GROUP BY p.id,d.version ORDER BY attempts DESC LIMIT 50'),
    by_country: q('SELECT COALESCE(country,\'unknown\') country,COUNT(*) attempts FROM download_events GROUP BY 1 ORDER BY 2 DESC LIMIT 20'),
    daily: q(`SELECT date(ts/1000,'unixepoch') day,COUNT(*) attempts,SUM(is_unique) uniques FROM download_events ${since(30)} GROUP BY 1 ORDER BY 1`),
    recent: q('SELECT p.name product,d.platform,d.version,d.country,d.is_unique,d.ts FROM download_events d LEFT JOIN products p ON p.id=d.product_id ORDER BY d.id DESC LIMIT 20'),
    recent_admin: q('SELECT a.email,l.action,l.entity,l.entity_id,l.ts FROM audit_logs l LEFT JOIN admins a ON a.id=l.admin_id ORDER BY l.id DESC LIMIT 15'),
  };
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname.replace(/\/+$/, '') || '/', m = req.method, origin = req.headers.origin;
  const sec = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'cross-origin-resource-policy': 'cross-origin', ...(PROD ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}) };
  for (const [k, v] of Object.entries(sec)) res.setHeader(k, v);
  if (origin && CORS.includes(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('access-control-allow-credentials', 'true'); res.setHeader('vary', 'Origin'); res.setHeader('access-control-allow-headers', 'content-type,x-csrf-token'); res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS'); }
  if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (limited('g|' + ip(req), num(E.RATE_LIMIT_PER_MIN, 120))) throw new HttpError(429, 'Too many requests');
    if (p === '/health') { let dbok = true; try { one('SELECT 1'); } catch { dbok = false; } return send(res, dbok ? 200 : 503, { status: dbok ? 'ok' : 'degraded', db: dbok ? 'ok' : 'down' }); }
    let mm;
    if (p === '/sitemap.xml') { const u = ['', '/products', '/research', '/log', '/portfolio', '/journal', '/careers', '/about', '/contact', ...q('SELECT slug FROM products WHERE published=1').map(r => '/products/' + r.slug), ...q('SELECT slug FROM journal_posts WHERE published=1').map(r => '/journal/' + r.slug)]; res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${u.map(x => `<url><loc>${PUBLIC}${x}</loc></url>`).join('')}</urlset>`); }
    if ((mm = p.match(/^\/download\/([a-z0-9-]+)\/([a-z0-9-]+)$/)) && m === 'GET') return download(req, res, mm[1], mm[2]);

    // ---- public API ----
    if (!p.startsWith('/api/admin')) {
      if (m !== 'GET') throw new HttpError(405, 'Method not allowed');
      res.setHeader('cache-control', 'public, max-age=30');
      const seg = p.split('/').filter(Boolean); // api, table, key
      if (seg[0] !== 'api') throw new HttpError(404, 'Not found');
      const t = seg[1];
      if (t === 'settings') { const o = Object.fromEntries(q('SELECT key,value FROM site_settings').map(r => [r.key, r.value])); if (o.show_public_stats === '1') o.total_downloads = one('SELECT COUNT(*) c FROM download_events WHERE is_unique=1').c; return send(res, 200, o); }
      if (t === 'portfolio') return send(res, 200, { ...pubRow(one('SELECT * FROM portfolio WHERE id=1')), projects: q(`SELECT * FROM portfolio_projects WHERE ${CFG.portfolio_projects.pub} ORDER BY sort,id`) });
      if (t === 'qr' && seg[3]) { const rel = one('SELECT 1 x FROM products p JOIN applications a ON a.product_id=p.id WHERE p.slug=? AND a.platform=? AND p.published=1', seg[2], seg[3]); if (!rel) throw new HttpError(404, 'QR unavailable'); return send(res, 200, { url: `${PUBLIC}/download/${seg[2]}/${seg[3]}`, direct: `${API}/download/${seg[2]}/${seg[3]}` }); }
      const c = CFG[t]; if (!c?.pub) throw new HttpError(404, 'Not found');
      if (t === 'journal_posts' || t === 'research_entries' || t === 'exile_log_entries' || t === 'links' || t === 'products' || t === 'portfolio_projects') {
        const lim = Math.min(num(url.searchParams.get('limit'), 50), 100), off = Math.max(num(url.searchParams.get('offset'), 0), 0);
        if (seg[2] && c.key) {
          const r = pubRow(one(`SELECT * FROM ${t} WHERE ${c.key}=? AND ${c.pub}`, seg[2])); if (!r) throw new HttpError(404, 'Not found');
          if (t === 'products') r.applications = q(`SELECT a.platform,a.kind,r.version,r.release_date FROM applications a JOIN app_releases r ON r.application_id=a.id AND r.id=(SELECT MAX(id) FROM app_releases WHERE application_id=a.id AND active=1) WHERE a.product_id=?`, r.id);
          return send(res, 200, r);
        }
        const rows = q(`SELECT * FROM ${t} WHERE ${c.pub} ORDER BY ${c.order} LIMIT ? OFFSET ?`, lim, off).map(pubRow);
        if (t === 'products') for (const r of rows) r.platforms = q('SELECT a.platform FROM applications a JOIN app_releases r ON r.application_id=a.id AND r.active=1 WHERE a.product_id=? GROUP BY a.platform', r.id).map(x => x.platform);
        return send(res, 200, rows);
      }
    }

    // ---- admin API ----
    const ap = p.replace(/^\/api\/admin/, '') || '/';
    if (ap === '/login' && m === 'POST') {
      if (limited('l|' + ip(req), num(E.LOGIN_RATE_LIMIT_PER_MIN, 8))) throw new HttpError(429, 'Too many attempts');
      if (origin && !CORS.includes(origin)) throw new HttpError(403, 'Forbidden');
      const b = await body(req), a = one('SELECT * FROM admins WHERE email=?', String(b.email || '').toLowerCase());
      const locked = a && a.locked_until > Date.now();
      const ok = checkPw(String(b.password || ''), a ? a.password_hash : DUMMY) && a && !locked;
      if (!ok) { if (a && !locked) { const f = a.failed + 1; run('UPDATE admins SET failed=?,locked_until=? WHERE id=?', f, f >= 5 ? Date.now() + 15 * 60e3 : 0, a.id); if (f >= 5) run('UPDATE admins SET failed=0 WHERE id=?', a.id); } throw new HttpError(401, locked ? 'Account temporarily locked' : 'Invalid credentials'); }
      run('UPDATE admins SET failed=0 WHERE id=?', a.id);
      const tok = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
      run('DELETE FROM admin_sessions WHERE expires_at<?', Date.now());
      run('INSERT INTO admin_sessions(admin_id,token_hash,csrf,expires_at) VALUES(?,?,?,?)', a.id, sha(tok), csrf, Date.now() + TTL);
      audit(a, 'login', 'admin', a.id);
      return send(res, 200, { email: a.email, role: a.role, csrf }, { 'set-cookie': cookie(tok, TTL / 1000) });
    }
    const s = sessionOf(req); if (!s) throw new HttpError(401, 'Unauthorized');
    const admin = { id: s.admin_id, role: s.role };
    if (!can(admin.role, 'content')) throw new HttpError(403, 'Forbidden');
    if (ap === '/me') return send(res, 200, { email: s.email, role: s.role, csrf: s.csrf });
    if (m !== 'GET') { if (req.headers['x-csrf-token'] !== s.csrf || (origin && !CORS.includes(origin))) throw new HttpError(403, 'CSRF check failed'); }
    if (ap === '/logout' && m === 'POST') { run('DELETE FROM admin_sessions WHERE id=?', s.id); audit(admin, 'logout', 'admin', admin.id); return send(res, 200, { ok: true }, { 'set-cookie': cookie('', 0) }); }
    if (ap === '/stats') return send(res, 200, stats());
    if (ap === '/system') return send(res, 200, { api: 'ok', db: one('SELECT 1 x').x === 1 ? 'ok' : 'down', storage: 'external URLs (no local uploads)', node: process.version });
    if (ap === '/audit') return send(res, 200, q('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100'));
    if (ap === '/password' && m === 'POST') { const b = await body(req), a = one('SELECT * FROM admins WHERE id=?', admin.id); if (!checkPw(String(b.current || ''), a.password_hash) || String(b.next || '').length < 12) throw bad('Wrong current password or new password shorter than 12 chars'); run('UPDATE admins SET password_hash=? WHERE id=?', hashPw(b.next), a.id); run('DELETE FROM admin_sessions WHERE admin_id=? AND id<>?', a.id, s.id); audit(admin, 'password_change', 'admin', a.id); return send(res, 200, { ok: true }); }
    if (ap === '/portfolio' && (m === 'GET' || m === 'PUT')) {
      if (m === 'GET') return send(res, 200, pubRow(one('SELECT * FROM portfolio WHERE id=1')));
      const b = await body(req), cols = q('PRAGMA table_info(portfolio)').map(r => r.name).filter(n => n !== 'id' && n in b), o = {};
      for (const k of cols) { let v = b[k]; if (v !== null && typeof v === 'object') v = JSON.stringify(v); if (v && /url$/.test(k) && !validUrl(v)) throw bad(`Invalid URL in ${k}`); o[k] = v === '' ? null : v; }
      if (cols.length) run(`UPDATE portfolio SET ${cols.map(c => c + '=?').join(',')} WHERE id=1`, ...cols.map(c => o[c]));
      audit(admin, 'update', 'portfolio', 1); return send(res, 200, pubRow(one('SELECT * FROM portfolio WHERE id=1')));
    }
    if (ap === '/settings') {
      if (m === 'GET') return send(res, 200, Object.fromEntries(q('SELECT key,value FROM site_settings').map(r => [r.key, r.value])));
      if (m === 'PUT') { const b = await body(req); for (const [k, v] of Object.entries(b)) { if (!/^[a-z_]{1,40}$/.test(k)) throw bad('bad key'); run('INSERT INTO site_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v).slice(0, 20000)); } audit(admin, 'update', 'site_settings', '', { keys: Object.keys(b) }); return send(res, 200, { ok: true }); }
    }
    if ((mm = ap.match(/^\/qr\/(\d+)$/)) && m === 'POST') { run('INSERT INTO qr_codes(application_id) VALUES(?) ON CONFLICT(application_id) DO UPDATE SET regenerated_at=CURRENT_TIMESTAMP', +mm[1]); audit(admin, 'qr_regenerate', 'applications', mm[1]); return send(res, 200, { ok: true }); }
    const seg = ap.split('/').filter(Boolean), t = seg[0], c = CFG[t];
    if (!c) throw new HttpError(404, 'Not found');
    if (m === 'GET' && !seg[1]) { const lim = Math.min(num(url.searchParams.get('limit'), 50), 200), off = Math.max(num(url.searchParams.get('offset'), 0), 0); return send(res, 200, { total: one(`SELECT COUNT(*) c FROM ${t}`).c, rows: q(`SELECT * FROM ${t} ORDER BY id DESC LIMIT ? OFFSET ?`, lim, off).map(pubRow) }); }
    if (m === 'POST' && !seg[1]) { const o = clean(t, await body(req), false), ks = Object.keys(o); const r = run(`INSERT INTO ${t}(${ks.join(',')}) VALUES(${ks.map(() => '?').join(',')})`, ...ks.map(k => o[k])); audit(admin, 'create', t, r.lastInsertRowid, { id: o.slug || o.title || o.version }); return send(res, 201, pubRow(one(`SELECT * FROM ${t} WHERE id=?`, r.lastInsertRowid))); }
    if (seg[1] && /^\d+$/.test(seg[1])) {
      const id = +seg[1]; if (!one(`SELECT 1 x FROM ${t} WHERE id=?`, id)) throw new HttpError(404, 'Not found');
      if (m === 'GET') return send(res, 200, pubRow(one(`SELECT * FROM ${t} WHERE id=?`, id)));
      if (m === 'PUT') { const o = clean(t, await body(req), true); if (t === 'products') o.updated_at = new Date().toISOString(); const ks = Object.keys(o); if (ks.length) run(`UPDATE ${t} SET ${ks.map(k => k + '=?').join(',')} WHERE id=?`, ...ks.map(k => o[k]), id); audit(admin, t === 'app_releases' ? 'release_update' : 'update', t, id, { fields: ks }); return send(res, 200, pubRow(one(`SELECT * FROM ${t} WHERE id=?`, id))); }
      if (m === 'DELETE') { run(`DELETE FROM ${t} WHERE id=?`, id); audit(admin, 'delete', t, id); return send(res, 200, { ok: true }); }
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (/UNIQUE/.test(e.message)) return send(res, 409, { error: 'Already exists' });
    if (/FOREIGN KEY/.test(e.message)) return send(res, 400, { error: 'Invalid reference' });
    console.error(e); send(res, 500, { error: 'Internal error' });
  }
});
server.listen(PORT, () => console.log(`Exile API on :${PORT}`));
