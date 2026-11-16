# 前端

- [`index.html`](index.html) 是唯一的页面源文件。在文件里搜索 `data-view="mobile"`、`data-view="family"` 或其他页面名，就能找到相应界面。
- [`assets/css/`](assets/css/) 是样式，[`assets/js/`](assets/js/) 是业务脚本。桌面公共脚本叫 `desktop-ui.js`，基础样式叫 `desktop-base.css`。
- [`assets/screenshots/`](assets/screenshots/) 是展示页用到的界面截图。

双击 `index.html` 会看到本地入口和启动命令。从项目根目录运行 `.\scripts\Start-Local.ps1 -SkipSetup` 后，即可打开 [老人端](http://localhost:3001/mobile)、[家属端](http://localhost:3001/family) 或 [登录页](http://localhost:3001/login.html)。页面通过本机 Node 服务调用 API，修改 HTML 后重启服务可看到更新。

[页面渲染代码](../server/src/lib/renderPage.js) 根据地址读取对应视图并加载公共资源。现有的 `/agent.html`、`/prediction.html` 等入口继续可用。文件名使用小写短横线，按功能命名。
