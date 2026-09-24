import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const mobile = read('../../../mobile.html');
const family = read('../../../family.html');
const core = read('../../../assets/js/pro-core.js');
const mobileJs = read('../../../assets/js/pro-mobile.js');
const familyJs = read('../../../assets/js/pro-family.js');
const css = read('../../../assets/css/pro-tailwind.css');
const server = read('../../src/index.js');

for (const js of [core,mobileJs,familyJs]) new Function(js);
for (const html of [mobile,family]) {
  assert.match(html, /assets\/css\/pro-tailwind\.css/);
  assert.match(html, /assets\/css\/fontawesome\.min\.css/);
  assert.match(html, /assets\/js\/pro-core\.js/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|tailwind\.config|https:\/\/cdnjs/);
}
assert.match(mobile, /assets\/js\/pro-mobile\.js/);
assert.match(family, /assets\/js\/pro-family\.js/);
assert.ok(css.length > 10000, 'compiled local styles missing');
for (const endpoint of ['/api/auth/me','/api/auth/login','/api/health/summary','/api/health/metrics','/api/todos/today','/api/alerts','/api/chat','/api/care/invitations']) {
  assert.ok(mobileJs.includes(endpoint), `mobile endpoint missing: ${endpoint}`);
}
for (const endpoint of ['/api/care/subjects','/api/care/accept','/api/care/seniors/','/api/chat']) {
  assert.ok(familyJs.includes(endpoint), `family endpoint missing: ${endpoint}`);
}
assert.match(core, /replace\(\/\[&<>"'\]\//, 'dynamic content must be escaped');
assert.match(server, /app\.get\('\/mobile'/);
assert.match(server, /app\.get\('\/family'/);
assert.match(server, /req\.user\?\.role/);
assert.doesNotMatch(server, /cdn\.tailwindcss\.com|unsafe-eval/);
console.log('Pro frontend contract: PASS');
