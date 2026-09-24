# 测试、CI 与验收

本仓库的统一测试入口是 `server/scripts/run-tests.mjs`。测试使用临时数据库和临时报告目录，设置 UTF-8、关闭 Python 字节码写入，并比较测试前后的 `git status --porcelain`；若测试修改跟踪文件或产生未跟踪文件，验收失败。

受保护的正式产物不会作为测试输出目标：

- `elderly-health-rag/output/`
- `reports/`
- `ml/reports/`
- `server/data/app.db`

## 环境要求

- Node.js `>=22 <23`；`server/package.json`、`.nvmrc` 和 CI 均以 Node 22 为准。
- CI 使用 Python 3.13。本地完整测试可使用仓库现有 `.venv`，但必须能安装 `requirements-test.txt`。
- Windows 生产/演示安装脚本使用 Python 3.14 x64；这是本地推理部署要求，不应与 CI 的 Python 3.13 测试环境混写。

## 首次安装测试依赖

```powershell
Set-Location 'D:\BIGCHUANG\-\server'
npm ci

Set-Location ..
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
```

若仓库已有可用 `.venv`，无需重建。

## 一键核心验收

```powershell
Set-Location 'D:\BIGCHUANG\-\server'
npm test
```

`npm test` 依次覆盖：

1. Node 单元测试；
2. 隔离数据库上的 Node 集成测试；
3. Python 单元测试；
4. GraphRAG 构建隔离与安全回归；
5. Curve 防泄漏/回归包装器；
6. 运行时与容器卫生安全测试；
7. Node 语法、Python 语法与 UTF-8 检查；
8. 测试前后 Git 工作区不变检查。

## 分组验收

在 `server` 目录运行：

```powershell
npm run test:unit
npm run test:integration
npm run test:graphrag
npm run test:curve
npm run test:security
npm run test:syntax
npm run test:pending
```

## 测试目录约定

| 目录 | 内容 | 运行方式 |
|---|---|---|
| `server/test/unit/` | 进程内断言，可调用 Python 工具 | `npm run test:unit` |
| `server/test/integration/` | 需临时服务与隔离数据库 | `npm run test:integration` |
| `server/test/evaluate/` | 离线评测脚本，产物写入 `reports/` | 手动运行 |
| `server/test/e2e/` | 端到端验收（`final_acceptance`），需服务已在运行 | 手动运行 |

新增测试文件后，需要在 `server/scripts/run-tests.mjs` 的 `unitTests` 或 `integrationTests` 数组中登记，否则不会被 `npm test` 执行。

## 环境隔离

`npm test` 会在以下两点上主动与开发机环境隔离，避免"本机碰巧通过"：

- **LLM 密钥**：单元与集成测试均清空 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `LLM_API_KEY`，强制走 Mock 与真实工具兜底；否则 `server/.env` 里的真实密钥会让断言 Mock 行为的用例失败。
- **Python 解释器**：统一通过 `HTN_PYTHON` 指向仓库 `.venv`。未设置该变量时 `server/src/services/pythonRuntime.js` 会退化成裸 `python`，使结果取决于全局解释器是否装有 numpy/pandas。
- **私有模型包**：`ml/models/` 被 `.gitignore` 排除，GitHub Actions 的全新检出不含模型。核心验收会运行公开代码的测试和无模型降级断言；依赖真实模型的 `test_htn_predictor`、`test_population_prediction`、`test_tool_calling` 仅在已安装模型包清单时运行。需要验收预测数值时，先按部署文档安装签名模型包，再运行 `npm run test:unit`；CI 通过不代表模型数值验收通过。

## 历史遗留测试

`npm run test:pending` 运行 5 个与当前实现不一致的历史集成测试（GraphRAG 证据持久化、健康摘要、风险资料完整度、趋势预警）。它们既不在 `npm test` 中、也不应被直接删除，需逐个重写断言或正式废弃：

- `server/test/integration/test_graph_grounding.mjs`
- `server/test/integration/test_graphrag_ckd.mjs`
- `server/test/integration/test_health_summary.mjs`
- `server/test/integration/test_risk_profile.mjs`
- `server/test/integration/test_trend_alerts.mjs`

该分组只汇总现状，不因失败而中断，因此不阻塞主验收流程。已实测：Mock 与真实 DeepSeek 下均失败，说明并非模型配置问题。

Python 入口也可在仓库根目录直接运行：

```powershell
.\.venv\Scripts\python.exe scripts\run_python_tests.py unit
.\.venv\Scripts\python.exe scripts\run_python_tests.py graphrag
.\.venv\Scripts\python.exe scripts\run_python_tests.py curve
.\.venv\Scripts\python.exe scripts\run_python_tests.py security
.\.venv\Scripts\python.exe scripts\run_python_tests.py syntax
```

## 重点能力对应测试

| 能力 | 直接证据 |
|---|---|
| 注册、bcrypt 迁移、锁定、会话过期、登出 | `server/test/integration/test_auth_integration.mjs` |
| 家属授权、只读摘要、问卷代录、禁止直接代写测量值 | `server/test/integration/test_care_permissions.mjs` |
| 设备同步写入 `source=device` | `server/test/integration/test_device_sync.mjs` |
| 权限矩阵 | `server/test/unit/test_permission_matrix.js` |
| 智能体工具与行动不自动执行 | `server/test/unit/test_agent_orchestrator_v2.js`、`server/test/integration/test_agent_tools.mjs` |
| 复测随访闭环 | `server/test/unit/test_agent_followup_v3.js`、`server/test/integration/test_quality_followup_review.mjs` |
| 静态资源边界（内部路径不泄漏） | `server/test/integration/test_static_asset_boundary.mjs` |
| Curve | `tests/test_curve_regression_wrappers.py` 及 `ml/curve/test_*.py` |
| GraphRAG 隔离与安全门槛 | `tests/test_graphrag_isolation.py` |
| 容器不携带密钥、数据库或缓存产物 | `tests/test_container_hygiene.py` |

统一 `npm test` 是文档所承诺的一键核心验收；上表部分专项脚本用于更细粒度审计，并非全部包含在核心入口中。

## 手动生成临时验证产物

GraphRAG 构建必须明确使用临时路径；只有有意刷新正式报告时才使用 `--update-docs`：

```powershell
$graphOut = Join-Path $env:TEMP 'evicare-graphrag-output'
$graphReport = Join-Path $env:TEMP 'evicare-graphrag-reports\index-stats.json'
.\.venv\Scripts\python.exe elderly-health-rag\graphrag_index.py build `
  --output-path $graphOut `
  --report-path $graphReport
```

Curve 时间验证同样写入临时目录：

```powershell
$curveOut = Join-Path $env:TEMP 'evicare-curve\metrics.json'
$curveReport = Join-Path $env:TEMP 'evicare-curve\report.md'
.\.venv\Scripts\python.exe ml\curve\temporal_validation.py `
  --out $curveOut `
  --report-path $curveReport
```

合成场景只验证算法行为、拒绝逻辑和覆盖计算，不支持真实准确率、临床有效性或外部验证宣称。

## 启动冒烟检查

```powershell
Set-Location 'D:\BIGCHUANG\-'
.\scripts\Start-Local.ps1 -SkipSetup
Invoke-RestMethod http://localhost:3001/api/health
Invoke-WebRequest http://localhost:3001/login.html -UseBasicParsing | Select-Object StatusCode
.\scripts\Stop-Local.ps1
```

预期：健康检查 `ok=true`，登录页 HTTP 状态为 `200`。模型包或 LLM 未配置时可以是明确的降级状态，不应伪装为已安装或真实在线调用。

## Docker 验收

```powershell
Set-Location 'D:\BIGCHUANG\-'
docker build -t evicare-local .
docker run --rm -p 3001:3001 -e LOGIN_RATE_STORE=sqlite evicare-local
```

另开终端执行 `Invoke-RestMethod http://localhost:3001/api/health`。`LOGIN_RATE_STORE=sqlite` 仅用于单实例本地容器验收；生产模式默认要求 Redis 和 `REDIS_URL`。

## CI

`.github/workflows` 当前只运行 Node 22 + Python 3.13，不再宣称 Node 20 矩阵。CI 依次执行所有分组测试；Docker job 依赖测试 job，通过后构建镜像并检查镜像内不包含 `.env`、SQLite 数据库或 `.pyc`，非 PR 事件再推送 GHCR。

## 结果解释

- **工程测试通过**：证明当前仓库代码路径在隔离环境可运行。
- **内部验证通过**：证明固定内部数据集、合成夹具或研究队列切分下的指标可复现。
- **不代表**：真实临床有效性、持证医生审核、独立地区外部验证或真实用户可用性结论。

## 2026-08-28 实测记录

- `npm test`：PASS；Node 24 自动切换到 Node 22.16.0，全部 Node/Python/GraphRAG/Curve/安全/语法分组通过，Git 状态未被测试改变。
- `Start-Local.ps1 -SkipSetup` + `/api/health` + `/login.html` + `Stop-Local.ps1`：PASS；健康检查成功、登录页 HTTP 200、服务正常停止。
- Docker 镜像实机构建：未执行（当前主机无 Docker CLI）；容器卫生自动测试已通过，但不得据此宣称实机镜像构建通过。

完整记录见 `reports/documentation-capability-audit-20260828.md`。
