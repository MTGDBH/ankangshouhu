# 前端版本与入口

本目录按用户界面版本存放 HTML 源码。浏览器仍使用原来的根路径 URL，由 `server/src/routes/pages.js` 映射到这里；页面内指向 `assets/` 的资源路径无需修改。

| 目录 | 页面 | 状态与用途 | 浏览器入口 |
|---|---|---|---|
| `app/` | `mobile.html`、`family.html` | 当前 Pro 主界面：老人移动端、家属/医生协同端 | `/mobile`、`/family` |
| `auth/` | `login.html`、`register.html` | 当前登录与注册 | `/login.html`、`/register.html` |
| `desktop/` | 14 个独立功能页 | 旧版桌面流程，继续提供功能和回归兼容 | `/index.html` 等同名路径 |
| `demo/` | `showcase.html`、`dev.html` | 展示页与开发导航 | `/showcase.html`、`/dev.html` |
| `archive/mobile-v1/` | 早期 CSS、JS 与蓝牙适配脚本 | 不再被页面引用，仅供历史对照 | 无公开入口 |

`assets/css/pro-*.css`、`assets/js/pro-*.js` 主要供 Pro 主界面和鉴权页使用；`assets/css/styles.css`、`assets/css/pro-legacy.css`、`assets/js/api.js`、`assets/js/auth.js`、`assets/js/main.js` 主要供桌面版使用。当前在用的共享资源继续放在仓库根目录 `assets/`。

新增页面时，同时更新 `server/src/routes/pages.js` 中的公开页面映射，并检查 `server/test/integration/test_static_asset_boundary.mjs`。不要把整个仓库根目录作为静态目录。
