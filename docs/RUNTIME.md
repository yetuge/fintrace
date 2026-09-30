# 运行 Agent 工作台

FinTrace 使用 Pi Runtime 执行 Agent 任务。Web 客户端需要后端服务；执行研究任务还需要配置模型 Provider 和相关工具。

## 安装与启动

建议 Node.js 24、npm。`better-sqlite3` 与 `node-pty` 是原生依赖，缺少预编译包时需要对应平台的 C/C++ 构建工具。Docker 仅在容器执行模式下需要。

```bash
npm ci
npm --prefix web ci
npm --prefix container/agent-runner ci
npm run build:all
npm start
```

服务地址为 `http://127.0.0.1:3000`，首页进入工作台。首次访问完成管理员初始化，再配置自己的模型 Provider。运行数据与凭证保存在被 Git 忽略的本地目录。

开发模式：

```bash
npm run dev:all
```

后端为 3000，前端为 5173。`npm run build:web` 生成 Web 客户端至 `web/dist/`，由后端提供静态资源和 API。

## 运行配置

工作台提供 Host 与 Docker 两种执行模式。使用容器模式时需要可用的 Runner 镜像，构建方式见 `container/Dockerfile`；通过 `CONTAINER_IMAGE` 指定自己的镜像。

模型与渠道配置见设置页；API 与权限实现见 [API 文档](API.md) 和 [权限矩阵](ACL-MATRIX.md)。研究数据源与工具通过 Skills、MCP 或插件配置。
