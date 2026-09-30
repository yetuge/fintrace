# 运行 Agent 工作台

FinTrace 使用 Pi Runtime 执行 Agent 任务。公开研究首页无需后端，以下步骤用于启动认证、会话、工具与工作区功能。金融演示资料不会自动注入 Agent，也没有金融数据源自动抓取功能。

## 安装与启动

建议 Node.js 24、npm。`better-sqlite3` 与 `node-pty` 是原生依赖，缺少预编译包时需要对应平台的 C/C++ 构建工具。GNU Make 用于可选的维护脚本，npm 启动不依赖 Make。Docker 仅在容器执行模式下需要。

```bash
npm ci
npm --prefix web ci
npm --prefix container/agent-runner ci
npm run build:all
npm start
```

服务地址为 `http://127.0.0.1:3000`。首页进入案例展示，访问 `/chat` 使用 Agent 工作台；首次访问完成管理员初始化，再配置自己的模型 Provider。运行数据与凭证保存于被 Git 忽略的 `data/`。

开发模式：

```bash
npm run dev:all
```

后端为 3000，前端为 5173。`npm run build:web` 生成包含真实工作台路由的 Web 构建，`npm run build:showcase` 生成静态展示构建，两者均写入 `web/dist/`，后执行的构建覆盖前者。

## 运行配置

运行底座提供 Host 与 Docker 两种执行模式。使用容器模式时需要可用的 Runner 镜像，构建方式见 `container/Dockerfile`；通过 `CONTAINER_IMAGE` 指定自己的镜像。

模型与渠道配置见设置页；API 与权限实现见 [API 文档](API.md) 和 [权限矩阵](ACL-MATRIX.md)。
