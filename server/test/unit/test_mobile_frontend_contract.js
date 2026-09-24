import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const mobile = read('../../../mobile.html');
const family = read('../../../family.html');
const login = read('../../../login.html');
const register = read('../../../register.html');
const core = read('../../../assets/js/pro-core.js');
const authJs = read('../../../assets/js/pro-auth.js');
const mobileJs = read('../../../assets/js/pro-mobile.js');
const familyJs = read('../../../assets/js/pro-family.js');
const chartJs = read('../../../assets/js/pro-charts.js');
const chartCss = read('../../../assets/css/pro-charts.css');
const css = read('../../../assets/css/pro-tailwind.css');
const server = read('../../src/index.js');

for (const js of [core,authJs,mobileJs,familyJs,chartJs]) new Function(js);
for (const html of [login,register]) {
  assert.match(html, /assets\/css\/pro-auth\.css/);
  assert.match(html, /assets\/js\/pro-auth\.js/);
  assert.doesNotMatch(html, /assets\/js\/(api|main)\.js|index\.html/);
}
assert.match(register, /value="caregiver"/);
assert.match(authJs, /location\.replace\(destination\(result\.user\.role\)\)/);
assert.match(mobileJs, /register\.html\?next=%2Fmobile/);
for (const html of [mobile,family]) {
  assert.match(html, /assets\/css\/pro-tailwind\.css/);
  assert.match(html, /assets\/css\/fontawesome\.min\.css/);
  assert.match(html, /assets\/js\/pro-core\.js/);
  assert.match(html, /assets\/js\/pro-charts\.js/);
  assert.match(html, /assets\/css\/pro-charts\.css/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|tailwind\.config|https:\/\/cdnjs/);
}
assert.match(mobile, /assets\/js\/pro-mobile\.js/);
assert.match(family, /assets\/js\/pro-family\.js/);
assert.ok(css.length > 10000, 'compiled local styles missing');
assert.ok(chartCss.includes('.pro-chart'));
const chartContext = {window:{Pro:{esc:value=>String(value)}}};
vm.runInNewContext(chartJs, chartContext);
const sampleChart = chartContext.window.ProCharts.line({title:'血压',unit:'mmHg',secondary:true,points:[
  {value:130,value2:80,recorded_at:'2026-09-01T08:00:00Z'},
  {value:138,value2:84,recorded_at:'2026-09-02T08:00:00Z'},
]});
assert.match(sampleChart, /<svg/);
assert.match(sampleChart, /<path/);
assert.match(sampleChart, / C[\d.]+,[\d.]+ [\d.]+,[\d.]+ [\d.]+,[\d.]+/);
assert.doesNotMatch(sampleChart, /<circle/);
assert.match(sampleChart, /138\/84 mmHg/);
assert.match(chartContext.window.ProCharts.bars({title:'记录',counts:[{type:'bp',count:4}],total:4}), /pro-bar-track/);
assert.match(chartContext.window.ProCharts.line({title:'血压',points:[]}), /暂无可绘制/);
assert.match(chartContext.window.ProCharts.line({title:'血压',points:[{value:130,recorded_at:'2026-09-01T08:00:00Z'}]}), /再记录一次后即可形成曲线/);
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
