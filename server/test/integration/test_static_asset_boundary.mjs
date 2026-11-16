// 旧 URL 仍提供各自的页面，只公开渲染后的视图与浏览器资源。
// 整个项目（健康数据库、后端源码、私有模型包）不能经 HTTP 无鉴权读取。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function probe(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return res.status;
}

const pages = [
  'mobile', 'family', 'login', 'register', 'index', 'agent', 'alerts', 'assessment',
  'care', 'confidence', 'intervention', 'knowledge', 'metric', 'monitoring',
  'prediction', 'privacy', 'profile', 'settings', 'showcase', 'dev',
];
const pageUrls = [...pages.map(name => `/${name}.html`), '/mobile', '/family'];
const publicAssets = new Set(['/assets/css/styles.css', '/assets/js/main.js']);
for (const url of pageUrls) {
  const response = await fetch(base + url);
  assert.equal(response.status, 200, url);
  assert.match(response.headers.get('content-type'), /^text\/html/, url);
  const html = await response.text();
  assert.match(html, /<title>[^<]+<\/title>/, url);
  assert.doesNotMatch(html, /<template data-view=|<!-- (?:shared-|view-)|class="local-entry"/, url);
  for (const [, asset] of html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)) publicAssets.add(asset);
}
for (const url of publicAssets) assert.equal(await probe(url), 200, url);

// 2) 内部内容必须被阻断。使用 Git 跟踪的真实文件，确保全新检出时也能证明 404。
const internalPaths = [
  '/server/data/seed.js',
  '/frontend/index.html',
  '/frontend/assets/css/desktop-base.css',
  '/server/src/index.js',
  '/server/src/db.js',
  '/server/package.json',
  '/ml/model_bundle.py',
  '/ml/prediction_contract.json',
  '/elderly-health-rag/output/dense_index.json',
  '/README.md',
  '/docs/final-delivery.md',
  '/docs/testing.md',
  '/docs/AGENT_ARCHITECTURE.md',
  '/tests/test_runtime_service.py',
  '/scripts/run_python_tests.py',
  '/Dockerfile',
];
for (const path of internalPaths) {
  if (!fs.existsSync(repoRoot + path.slice(1))) throw new Error(`测试前置失败：本地不存在 ${path}`);
  const status = await probe(path);
  if (status !== 404) throw new Error(`内部路径未被阻断：${path} -> ${status}`);
}

// 3) 目录穿越与编码绕过同样要挡住
for (const path of ['/../.gitignore', '/..%2f.gitignore', '/%2e%2e/.gitignore', '/server/../.gitignore']) {
  const status = await probe(path);
  if (status === 200) throw new Error(`目录穿越未被阻断：${path} -> ${status}`);
}

// 4) 业务 API 不能被静态边界误伤（守卫放行 /api/*）
const apiStatus = await probe('/api/health');
if (apiStatus !== 200) throw new Error(`/api/health 被静态边界误挡：${apiStatus}`);

console.log(JSON.stringify({
  pass: true,
  public_assets_served: publicAssets.size,
  page_urls_served: pageUrls.length,
  internal_paths_blocked: internalPaths.length,
  api_unaffected: true,
}));
