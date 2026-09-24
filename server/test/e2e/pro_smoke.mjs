import assert from 'node:assert/strict';

const base = process.env.PRO_SMOKE_BASE || 'http://localhost:3017';
async function call(path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(base + path, {method, headers: {...(cookie ? {cookie} : {}), ...(body ? {'content-type':'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
  const data = (response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text();
  return {status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] || ''};
}
assert.equal((await call('/api/health')).status, 200);
assert.equal((await call('/mobile')).status, 200);
assert.equal((await call('/family')).status, 200);
assert.equal((await call('/assets/js/pro-mobile.js')).status, 200);
assert.equal((await call('/assets/js/pro-family.js')).status, 200);
assert.equal((await call('/api/care/subjects')).status, 401);

const senior = await call('/api/auth/login', {method:'POST', body:{identifier:'张奶奶', password:'123456'}});
assert.equal(senior.status, 200, JSON.stringify(senior.data));
assert.ok(senior.cookie);
const health = await call('/api/health/metrics', {cookie:senior.cookie});
assert.equal(health.status, 200);
assert.ok(health.data.bp);
const name = `Pro测试家属${Date.now()}`;
const caregiver = await call('/api/auth/register', {method:'POST', body:{name, password:'test-123456', role:'caregiver'}});
assert.equal(caregiver.status, 201, JSON.stringify(caregiver.data));
assert.ok(caregiver.cookie);
assert.deepEqual((await call('/api/care/subjects', {cookie:caregiver.cookie})).data.items, []);
const invitation = await call('/api/care/invitations', {method:'POST', cookie:senior.cookie, body:{member_role:'caregiver'}});
assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
const accepted = await call('/api/care/accept', {method:'POST', cookie:caregiver.cookie, body:{code:invitation.data.code}});
assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
const subjects = await call('/api/care/subjects', {cookie:caregiver.cookie});
assert.equal(subjects.status, 200);
assert.equal(subjects.data.items.length, 1);
assert.equal(subjects.data.items[0].senior.name, '张奶奶');
assert.ok(subjects.data.items[0].recent_health?.length);
const summary = await call(`/api/care/seniors/${subjects.data.items[0].senior.id}/summary`, {cookie:caregiver.cookie});
assert.equal(summary.status, 200);
console.log('Pro smoke: public pages, auth, health data, care invitation, authorized summary PASS');
