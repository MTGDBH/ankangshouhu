// 静态资源边界回归：页面 URL 保持根路径，源码移到 frontend/ 后不能直接暴露该目录。
// 整个项目（健康数据库、后端源码、私有模型包）不能经 HTTP 无鉴权读取。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function probe(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return res.status;
}

// 1) 前端资源必须仍可公开访问，否则界面直接坏掉
const publicAssets = new Map([
  ['/index.html', 'frontend/desktop/index.html'],
  ['/login.html', 'frontend/auth/login.html'],
  ['/mobile.html', 'frontend/app/mobile.html'],
  ['/family.html', 'frontend/app/family.html'],
  ['/assets/css/styles.css', 'assets/css/styles.css'],
  ['/assets/js/api.js', 'assets/js/api.js'],
]);
for (const [url, file] of publicAssets) {
  if (!fs.existsSync(repoRoot + file)) throw new Error(`测试前置失败：本地不存在 ${file}`);
  const status = await probe(url);
  if (status !== 200) throw new Error(`前端资源被误挡：${url} -> ${status}`);
}
let pageCount = 0;
for (const section of ['app', 'auth', 'desktop', 'demo']) {
  for (const file of fs.readdirSync(repoRoot + `frontend/${section}`)) {
    if (!file.endsWith('.html')) continue;
    const url = `/${file}`;
    const status = await probe(url);
    if (status !== 200) throw new Error(`页面旧地址失效：${url} -> ${status}`);
    pageCount += 1;
  }
}
if (pageCount !== 20) throw new Error(`页面数量异常：${pageCount}`);

// 2) 内部内容必须被阻断。使用 Git 跟踪的真实文件，确保全新检出时也能证明 404。
const internalPaths = [
  '/server/data/seed.js',
  '/frontend/app/mobile.html',
  '/frontend/desktop/index.html',
  '/server/src/index.js',
  '/server/src/db.js',
  '/server/package.json',
  '/ml/model_bundle.py',
  '/ml/prediction_contract.json',
  '/elderly-health-rag/output/dense_index.json',
  '/README.md',
  '/FINAL_DELIVERY.md',
  '/TESTING.md',
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
  page_urls_served: pageCount,
  internal_paths_blocked: internalPaths.length,
  api_unaffected: true,
}));
