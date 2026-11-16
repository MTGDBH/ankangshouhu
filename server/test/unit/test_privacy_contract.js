import { renderPage } from '../../src/lib/renderPage.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DATA_CATEGORIES, DELETION_CONFIRM_TEXT, PRIVACY_FORBIDDEN_EXPORT_KEYS, serializeExport } from '../../src/services/privacyService.js';

assert.equal(DATA_CATEGORIES.length, 8);
assert.equal(DELETION_CONFIRM_TEXT, '确认删除我的账号');
for (const required of ['password', 'token', 'api_key', 'secret']) assert.ok(PRIVACY_FORBIDDEN_EXPORT_KEYS.includes(required));
const sample = { profile: { name: '张奶奶' }, health: { measurements: [{ note: '含,逗号和"引号"' }] } };
assert.match(serializeExport(sample, 'json').body, /张奶奶/);
const csv = serializeExport(sample, 'csv').body;
assert.match(csv, /^\uFEFFcategory,path,value/); assert.match(csv, /含,逗号和""引号""/);
const html = renderPage('privacy');
const js = fs.readFileSync(new URL('../../../frontend/assets/js/privacy.js', import.meta.url), 'utf8');
for (const text of ['系统保存了什么', '谁访问过', '导出 JSON', '导出 CSV', '数据保留与删除范围', '再次确认删除', '不宣称已获得']) assert.ok(html.includes(text), `privacy UI missing ${text}`);
for (const endpoint of ['/api/privacy/overview', '/api/privacy/authorizations', '/api/privacy/access-records', '/api/privacy/exports', '/api/privacy/deletion-requests']) assert.ok(js.includes(endpoint), `privacy client missing ${endpoint}`);
console.log('Privacy data contract, export serialization and frontend disclosures: PASS');
