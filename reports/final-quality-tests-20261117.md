# 06 最终质量审查测试报告

实测日期为 2026 年 11 月 17 日。Windows x64，源码工作目录基线 `575393e` 加当前 02–05 变更。测试写入临时目录与合成 SQLite 库。日志下列字段经过摘录，仅保留状态、统计和返回契约。现有应用数据库未读取或写入。

## 可执行证据

| 验证 | 实际结果 |
| --- | --- |
| 隔离 Node 安装 | Node 22.23.2。临时目录按锁文件运行 `npm ci --no-audit --no-fund`，安装 115 个包。原生 `better-sqlite3` 的 SQLite 版本为 3.49.2。 |
| 隔离 Python 安装 | 新建 Python 3.14.6 虚拟环境并安装 `requirements-test.txt`。安装退出 0，`pip check` 返回 `No broken requirements found`。 |
| 隔离启动 | 全新源码副本和新依赖启动成功。`DEMO_SEED=0` 时初始用户数为 0。`/api/health` 和 `/api/health/dependencies` 成功，登录页 200。无私有包的预测状态为 `degraded`。 |
| 核心回归 | 在 `server` 目录运行 `npm test`，退出 0。覆盖 Node 单元、集成、Python、GraphRAG、曲线、安全和语法测试，Git 状态在测试前后相同。输出包含 `V1 workflows PASS`、`V2 research policy PASS` 和 `V3 temporal policy PASS`。 |
| V2/V3 接口 | 新装依赖的隔离 V2、V3 实例分别运行 `v2_quality_agent.mjs` 和 `v3_temporal_memory.mjs`，均退出 0。 |
| 基础端到端 | 两个研究开关关闭时，`final_acceptance.mjs` 和 `pro_smoke.mjs` 均退出 0。前者使用本地工具模式。脚本尾行固定文字 “DeepSeek trend” 不能作为云端成功证据。 |
| 开关组合与浏览器 | 两个研究开关打开时，桌面和手机 Chrome 均显示历史答复，并可点击核验原始测量。旧 `final_acceptance.mjs` 在此配置下退出 1，其允许的来源字段缺少实际返回的 `quality_policy`。V2/V3 专用验收仍通过。 |
| SQLite | 干净启动、V2、V3 三套临时库均为 `wal`，`PRAGMA integrity_check` 为 `ok`，`PRAGMA foreign_key_check` 返回零条。 |
| GraphRAG | 认证后的实际查询返回 `index_version=2026-08-26.v9`、`graph_mode=local_hybrid`、6 个命中和 6 个引用。 |
| 本地真实模型 | llama.cpp b12466 与 Qwen2.5-1.5B-Instruct Q4_K_M。校验 SHA-256 `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`。真实管家接口返回 `provider=custom`、`model=evicare-qwen25-15b-q4km`、`call_status=success`、33 字符答复，探针退出 0。 |
| 配置的云端模型 | 当前 DeepSeek 配置收到 HTTP 401，管家返回 `call_status=fallback`、`fallback_reason=LLM_HTTP_401`，并有 40 字符降级答复。成功探针按定义退出 1。 |
| V2 研究产物 | 隔离目录生成 189 条数据，划分摘要与原件一致。504 条策略与消融重新运行，正式与首轮各 210 条保存的模型日志重新计分。指标吻合，运行耗时存在预期波动。另用 Qwen 实跑每组 2 条验证样本，共 10 条，服务错误 0，输出有效 8 条。 |
| V3 研究产物 | 隔离目录生成 204 条数据，划分摘要、最优权重与原件一致。固定测试指标和 816 条逐例结果重跑，两个产物与原件的 SHA-256 一致。 |
| 机密与卫生 | 文件路径卫生检查通过。197 个当前文本的常见密钥特征检测得到 3 个文件名匹配，人工核对均是普通报告路径。未扫描历史对象、未覆盖所有凭据格式。 |
| Docker 和生产服务 | 本机无 Docker 或 Podman 命令。当前版本镜像构建与内检、Linux 容器、生产 Redis/TLS、生产持久卷恢复均未执行。 |

## 官方 npm 依赖审计

默认镜像返回 404，随后显式使用 npm 官方 registry 成功获取结果。审计退出码 1，表示存在 3 个受影响的传递包。级别来自 registry 的结果。整改后需要重新锁定、回归和复扫。

| 依赖 | 锁定版本 | 级别 | 官方公告 |
| --- | --- | --- | --- |
| `proxy-addr` | 2.0.7 | 严重 | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |
| `body-parser` | 1.20.6 | 高危 | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) |
| `qs` | 6.15.3 | 中危 | [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) · [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) · [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) |

## 遗留测试

`npm run test:pending` 独立执行，得到 1 通过 / 4 未通过。此分组以报告退出码 0。

| 测试 | 结果 |
| --- | --- |
| `test_graph_grounding.mjs` | 未通过，`response card is not structured` |
| `test_graphrag_ckd.mjs` | 未通过，`chat graph evidence not persisted` |
| `test_health_summary.mjs` | 未通过，`health summary agent response unavailable` |
| `test_risk_profile.mjs` | 未通过，`risk completeness did not improve` |
| `test_trend_alerts.mjs` | 通过 |

## 复现入口

在隔离工作目录运行。实测程序应只连接测试库和合成输入。V2 与 V3 研究脚本默认会更新当前目录的输出，复跑时使用工作副本。

```powershell
Set-Location server
npm.cmd ci
npm.cmd test
npm.cmd run test:pending
npm.cmd audit --omit=dev --json --registry=https://registry.npmjs.org
Set-Location ..
node research/v2/dataset.mjs
node research/v2/run.mjs
node research/v2/score.mjs
node research/v3/dataset.mjs
node research/v3/evaluate.mjs
```

端到端脚本按服务环境分别运行。[V2 接口验收](../server/test/e2e/v2_quality_agent.mjs) · [V3 接口验收](../server/test/e2e/v3_temporal_memory.mjs) · [真实模型验收](../server/test/e2e/v1_live_model.mjs)

V2 真实验证集预跑使用 `node research/v2/run.mjs --real --split=validation --all --limit=2 --out=<隔离目录>`，并设置本地模型端点及版本变量。本轮验证了缺少 `--all` 时脚本沿用正式测试变体过滤，生成 0 行但成功退出，因此验收应检查逐组行数和有效输出。[运行器](../research/v2/run.mjs)

[最终审查和发布阻断](final-project-quality-review-20261117.md) · [V1 验收与旧库迁移](v1-acceptance-20261117.md) · [V2 复现与日志](../research/v2/PROTOCOL.md) · [V3 复现与日志](../research/v3/REPORT.md)
