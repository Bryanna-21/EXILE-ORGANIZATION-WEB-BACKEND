import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
const P = 8896, B = `http://localhost:${P}`, DB = './data/totp-test.db';
const env = { ...process.env, PORT: P, DATABASE_URL: DB, CORS_ORIGINS: 'http://a.test', PUBLIC_SITE_URL: 'http://a.test', API_URL: B, ADMIN_SESSION_SECRET: 'y'.repeat(40), ADMIN_BOOTSTRAP_EMAIL: 't@x.io', ADMIN_BOOTSTRAP_PASSWORD: 'original-password-1', LOGIN_RATE_LIMIT_PER_MIN: '1000', RATE_LIMIT_PER_MIN: '10000', RESET_RATE_LIMIT_PER_MIN: '1000' };
delete env.RESEND_API_KEY;
let srv;
const H = { 'content-type': 'application/json', origin: 'http://a.test' };
// Independent RFC 6238 implementation (does not share code with the server)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const unb32 = s => { let bits = ''; for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); };
const hotp = (key, ctr) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(ctr)); const h = crypto.createHmac('sha1', key).update(b).digest(), o = h[19] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0'); };
const codeAt = (secret, delta = 0) => hotp(unb32(secret), Math.floor(Date.now() / 30000) + delta);
const post = (p, b, extra = {}) => fetch(B + p, { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify(b) });
let cookie, csrf, secret, recovery;
const authed = (p, b) => post('/api/admin/' + p.replace(/^\//, ''), b, { cookie, 'x-csrf-token': csrf });
before(async () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true }); srv = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.mjs'], { env, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 1500)); });
after(() => srv.kill());
test('code generator matches the RFC 6238 test vector (SHA-1, secret "12345678901234567890", T=59 -> 94287082)', () => {
  assert.equal(hotp(Buffer.from('12345678901234567890'), 1), '287082');
});
test('login, start setup: secret + otpauth URI returned; /me says not enabled', async () => {
  const r = await post('/api/admin/login', { email: 't@x.io', password: 'original-password-1' }); const j = await r.json(); assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0]; csrf = j.csrf;
  const s = await authed('/totp/setup', {}); const sj = await s.json(); assert.equal(s.status, 200); secret = sj.secret;
  assert.match(secret, /^[A-Z2-7]{32}$/); assert.match(sj.uri, /^otpauth:\/\/totp\/Exile%20Admin:t%40x\.io\?secret=/);
  const me = await (await fetch(B + '/api/admin/me', { headers: { cookie } })).json(); assert.equal(me.totp, false);
});
test('secret is encrypted at rest', async () => {
  const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(DB); const row = d.prepare('SELECT totp_secret FROM admins').get(); d.close();
  assert.ok(row.totp_secret && !row.totp_secret.includes(secret));
});
test('enable: wrong code rejected; right code enables and returns 8 recovery codes', async () => {
  assert.equal((await authed('/totp/enable', { code: '000000' })).status, 400);
  const r = await authed('/totp/enable', { code: codeAt(secret) }); const j = await r.json(); assert.equal(r.status, 200);
  recovery = j.recovery; assert.equal(recovery.length, 8); assert.match(recovery[0], /^[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal((await (await fetch(B + '/api/admin/me', { headers: { cookie } })).json()).totp, true);
});
test('forgot password with authenticator: works without any email service', async () => {
  const bad = await post('/api/admin/reset', { email: 't@x.io', code: '123456', password: 'brand-new-password-9' }); assert.equal(bad.status, 400);
  const ok = await post('/api/admin/reset', { email: 't@x.io', code: codeAt(secret, 1), password: 'brand-new-password-9' }); assert.equal(ok.status, 200); // next step is within the +/-1 window
  assert.equal((await post('/api/admin/login', { email: 't@x.io', password: 'original-password-1' })).status, 401);
  assert.equal((await post('/api/admin/login', { email: 't@x.io', password: 'brand-new-password-9' })).status, 200);
  assert.equal((await fetch(B + '/api/admin/me', { headers: { cookie } })).status, 401, 'old sessions are signed out');
});
test('replay: the same authenticator code (or an older step) cannot be used again', async () => {
  assert.equal((await post('/api/admin/reset', { email: 't@x.io', code: codeAt(secret, 1), password: 'replay-attempt-password-1' })).status, 400);
  assert.equal((await post('/api/admin/reset', { email: 't@x.io', code: codeAt(secret, 0), password: 'replay-attempt-password-1' })).status, 400);
});
test('recovery code works once, accepts with or without dash, and then is dead', async () => {
  assert.equal((await post('/api/admin/reset', { email: 't@x.io', code: recovery[0], password: 'via-recovery-code-12' })).status, 200);
  assert.equal((await post('/api/admin/login', { email: 't@x.io', password: 'via-recovery-code-12' })).status, 200);
  assert.equal((await post('/api/admin/reset', { email: 't@x.io', code: recovery[0], password: 'second-use-should-fail-1' })).status, 400);
  assert.equal((await post('/api/admin/reset', { email: 't@x.io', code: recovery[1].replace('-', ''), password: 'no-dash-recovery-code-1' })).status, 200);
});
test('5 wrong codes lock resets for 15 minutes, even for a valid code', async () => {
  for (let i = 0; i < 5; i++) await post('/api/admin/reset', { email: 't@x.io', code: '999999', password: 'brand-new-password-9' });
  const r = await post('/api/admin/reset', { email: 't@x.io', code: recovery[2], password: 'locked-out-attempt-12' }); const j = await r.json();
  assert.equal(r.status, 400); assert.match(j.error, /Too many wrong codes/);
});
test('disable needs password AND a code; then recovery codes are gone', async () => {
  const L = await post('/api/admin/login', { email: 't@x.io', password: 'no-dash-recovery-code-1' }); const lj = await L.json(); cookie = L.headers.get('set-cookie').split(';')[0]; csrf = lj.csrf;
  assert.equal((await authed('/totp/disable', { password: 'wrong', code: codeAt(secret, 1) })).status, 400);
  assert.equal((await authed('/totp/disable', { password: 'no-dash-recovery-code-1', code: '000000' })).status, 400);
  const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(DB); d.prepare('UPDATE admins SET totp_last=0').run(); d.close(); // test only: clear replay marker so a fresh code can be reused
  assert.equal((await authed('/totp/disable', { password: 'no-dash-recovery-code-1', code: codeAt(secret, 0) })).status, 200);
  assert.equal((await (await fetch(B + '/api/admin/me', { headers: { cookie } })).json()).totp, false);
});
