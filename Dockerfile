# syntax=docker/dockerfile:1
#
# 多 Agent 研发团队 · 生产镜像（单端口托管 API + 前端静态资源）
#
# 构建：docker build -t multi-agent .
# 运行：见 docker-compose.yml 与 README「Docker 部署」。
#
# 设计要点：
# - 基础镜像 node:24：持久化依赖 Node 内置 node:sqlite（22.5+，无需原生编译工具链）；
# - 运行阶段安装 git：repo / worktree 模式与 git_* 工具依赖系统 git；
# - 容器内以 BIND_ALL=true 监听 0.0.0.0（端口映射前置条件），鉴权靠 AUTH_TOKEN（compose 强制）；
# - 浏览器首次访问 /?token=<AUTH_TOKEN> 种 cookie 后即可正常使用（HTTP + WS 均校验）。

# ---------- 构建阶段：全量依赖 + server(tsup) + client(vite) ----------
FROM node:24-slim AS build
WORKDIR /app
# 构建产物不需要浏览器（根 devDependencies 含 @playwright/test，跳过下载可大幅提速）
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# 依赖层：仅拷贝清单，清单不变时复用缓存
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
# 源码层
COPY . .
RUN npm run build

# ---------- 运行阶段：生产依赖 + 构建产物 + 运行时资产 ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# git：Worktree / Git 工具集；ca-certificates：访问真实 LLM 的 HTTPS
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force
# 构建产物：server/dist（tsup，@multi-agent/shared 已内联）+ client/dist（vite）
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
# 运行时资产：Agent 资产包 + 技能库（config.ts 按 ROOT_DIR 解析，缺一不可）
COPY agents agents
COPY skills skills
# 数据与工作区（建议以卷挂载持久化；Linux 宿主需 sudo chown -R 1000:1000）
RUN mkdir -p data workspace && chown -R node:node data workspace
USER node
EXPOSE 8787
# 健康检查（/api/health 在鉴权保护下，配了 AUTH_TOKEN 时携带）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const u='http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health';const h=process.env.AUTH_TOKEN?{authorization:'Bearer '+process.env.AUTH_TOKEN}:undefined;fetch(u,{headers:h}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/index.js"]
