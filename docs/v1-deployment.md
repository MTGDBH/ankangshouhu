# V1 部署说明

## 本地运行

从仓库根目录执行以下 PowerShell 命令。项目使用 Node.js 22、Python 和 SQLite。现有前端由 Express 同源托管。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\ml\requirements.txt
Set-Location server
npm.cmd ci
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
$env:HTN_PYTHON = (Resolve-Path ..\.venv\Scripts\python.exe).Path
npm.cmd start
```

首次创建本地配置时才复制 `.env.example`。已有 `.env` 应继续保留。用浏览器打开 `http://localhost:3001`，检查 `GET /api/health`。Windows 上可继续使用仓库现有的安装和启动脚本。

| 设置 | 用途 |
| --- | --- |
| `PORT`、`CORS_ORIGIN` | 服务端口和允许来源。测试或自定义端口需要同步配置来源。 |
| `DB_PATH` | SQLite 文件路径，默认 `server/data/app.db`，相对路径按 server 目录解析。改版会在启动时补充字段与索引。 |
| `DEMO_SEED` | 本地评审可以用 `1` 在空库生成明确标为演示的数据。对外部署用 `0` 和新库，避免植入演示账号。 |
| `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` | 服务端的 DeepSeek 配置。需要使用 OpenAI 兼容接入时，按模板设置 `OPENAI_*` 或 `LLM_*`。配置优先级为 DeepSeek、OpenAI、通用。 |
| `COOKIE_SECURE`、`TRUST_PROXY` | HTTPS 部署使用安全 Cookie。仅在可信反向代理后开启代理信任。 |

模型凭据保存在服务器环境。项目可在无模型凭据时运行，管家使用能核对数据的本地规则和工具。验收成功调用须另跑 `test/e2e/v1_live_model.mjs`。脚本会创建一个合成账号并发出一条真实请求，适合在临时测试库运行。

## 容器

仓库根目录包含 `Dockerfile`，镜像同时启动 Node 服务和 Python 运行时。将 SQLite 数据目录映射到持久卷。

```powershell
docker build -t evicare-local .
docker volume create evicare-v1-data
docker run --name evicare-v1 --env-file .\server\.env -e DEMO_SEED=0 -e DB_PATH=/app/server/data/app.db -p 127.0.0.1:3001:3001 -v evicare-v1-data:/app/server/data evicare-local
```

对外提供服务时，通过 HTTPS 反向代理转发到服务端口，设置实际来源。预测模型包按仓库主 README 的私有模型包流程安装。缺包时健康录入、查询和基础工具仍可使用，预测接口按现有门禁显示受限。

## 数据保留与恢复

服务停止后备份 SQLite 文件及同名 WAL 和 SHM（如果存在），或在服务在线时用 SQLite 的在线备份功能生成一致副本。恢复时先停服务，使用单个一致的备份恢复至新的数据库目录，确认 `DB_PATH` 后启动并核对健康检查和记录数量。首次在旧数据上升级前保留原库备份。

请求日志可以用 `X-Request-Id` 定位。测量审计只记录对象、录入者、记录编号、版本、操作及改动字段名称。测试和访问日志应与生产数据库分开保存。
