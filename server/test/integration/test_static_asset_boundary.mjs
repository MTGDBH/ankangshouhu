// 静态资源边界回归：ROOT_DIR 是仓库根，若直接 express.static(ROOT_DIR)，
// 整个项目（健康数据库、后端源码、私有模型包）都会无鉴权地通过 HTTP 暴露。
// 本用例锁定"只公开 根目录 *.html + assets/ + 截图/，其余一律 404"的边界。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function probe(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return res.status;
}

// 1) 前端资源必须仍可公开访问，否则界面直接坏掉
const publicAssets = ['/index.html', '/login.html', '/assets/css/styles.css', '/assets/js/api.js'];
for (const asset of publicAssets) {
  if (!fs.existsSync(repoRoot + asset.slice(1))) throw new Error(`测试前置失败：本地不存在 ${asset}`);
  const status = await probe(asset);
  if (status !== 200) throw new Error(`前端资源被误挡：${asset} -> ${status}`);
}

// 2) 内部内容必须被阻断。使用 Git 跟踪的真实文件，确保全新检出时也能证明 404。
const internalPaths = [
  '/server/data/seed.js',
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
  public_assets_served: publicAssets.length,
  internal_paths_blocked: internalPaths.length,
  api_unaffected: true,
}));
