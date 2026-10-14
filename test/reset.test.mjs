import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const P = 8898, MP = 8897, B = `http://localhost:${P}`, DB = './data/reset-test.db';
const mails = [];
const mock = http.createServer((req, res) => { const b = []; req.on('data', d => b.push(d)); req.on('end', () => { mails.push({ auth: req.headers.authorization, ...JSON.parse(Buffer.concat(b)) }); res.end('{"id":"x"}'); }); });
const env = { ...process.env, PORT: P, DATABASE_URL: DB, CORS_ORIGINS: 'http://a.test', PUBLIC_SITE_URL: 'http://a.test', API_URL: B, ADMIN_SESSION_SECRET: 'x'.repeat(40), ADMIN_BOOTSTRAP_EMAIL: 'r@x.io', ADMIN_BOOTSTRAP_PASSWORD: 'original-password-1', LOGIN_RATE_LIMIT_PER_MIN: '100', RESEND_API_KEY: 'k_test', RESEND_API_URL: `http://localhost:${MP}/emails` };
let srv;
const H = { 'content-type': 'application/json', origin: 'http://a.test' };
const post = (p, b) => fetch(B + p, { method: 'POST', headers: H, body: JSON.stringify(b) });
const code = () => mails.at(-1).text.match(/is (\d{6})/)[1];
before(async () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true }); await new Promise(r => mock.listen(MP, r)); srv = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server.mjs'], { env, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 1500)); });
after(() => { srv.kill(); mock.close(); });
test('unknown email: generic 200, no mail sent', async () => { const r = await post('/api/admin/forgot', { email: 'nobody@x.io' }); assert.equal(r.status, 200); assert.equal(mails.length, 0); });
test('known email: code mailed via Resend with bearer key, never returned in response', async () => {
  const r = await post('/api/admin/forgot', { email: 'r@x.io' }); const j = await r.json(); assert.equal(r.status, 200);
  assert.equal(mails.length, 1); assert.equal(mails[0].auth, 'Bearer k_test'); assert.deepEqual(mails[0].to, ['r@x.io']); assert.match(mails[0].text, /\b\d{6}\b/);
  assert.ok(!JSON.stringify(j).match(/\d{6}/), 'code must not leak in response');
});
test('wrong code and weak password are rejected', async () => {
  assert.equal((await post('/api/admin/reset', { email: 'r@x.io', code: '000000', password: 'brand-new-password-9' })).status, 400);
  assert.equal((await post('/api/admin/reset', { email: 'r@x.io', code: code(), password: 'short' })).status, 400);
});
test('correct code resets password; old fails, new works; code is single-use', async () => {
  const c = code();
  assert.equal((await post('/api/admin/reset', { email: 'r@x.io', code: c, password: 'brand-new-password-9' })).status, 200);
  assert.equal((await post('/api/admin/login', { email: 'r@x.io', password: 'original-password-1' })).status, 401);
  assert.equal((await post('/api/admin/login', { email: 'r@x.io', password: 'brand-new-password-9' })).status, 200);
  assert.equal((await post('/api/admin/reset', { email: 'r@x.io', code: c, password: 'another-password-77' })).status, 400);
});
test('5 wrong guesses burn the code even if the 6th is right; new code works; max 3 per hour', async () => {
  await post('/api/admin/forgot', { email: 'r@x.io' }); const c = code(); const wrong = c === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) await post('/api/admin/reset', { email: 'r@x.io', code: wrong, password: 'brand-new-password-9' });
  assert.equal((await post('/api/admin/reset', { email: 'r@x.io', code: c, password: 'yet-another-pass-12' })).status, 400);
  const before = mails.length; await post('/api/admin/forgot', { email: 'r@x.io' }); assert.equal(mails.length, before + 1); // 3rd code this hour
  await post('/api/admin/forgot', { email: 'r@x.io' }); assert.equal(mails.length, before + 1); // 4th silently suppressed
});
