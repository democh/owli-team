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
# 构建期堆上限：宿主内存 <4G 时 vite/tsc 并行构建容易 OOM（小机型可下调）
ARG NODE_MAX_OLD_SPACE_SIZE=3072
ENV NODE_OPTIONS=--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}
# 可选 npm 镜像（境内构建：--build-arg NPM_REGISTRY=https://registry.npmmirror.com）
ARG NPM_REGISTRY=https://registry.npmjs.org
# 依赖层：仅拷贝清单，清单不变时复用缓存
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --registry=${NPM_REGISTRY}
# 源码层
COPY . .
RUN npm run build

# ---------- 运行阶段：生产依赖 + 构建产物 + 运行时资产 ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 可选 APT 镜像（境内构建：--build-arg APT_MIRROR=mirrors.aliyun.com）
ARG APT_MIRROR=
# 可选 npm 镜像（与构建阶段保持一致）
ARG NPM_REGISTRY=https://registry.npmjs.org
# git：Worktree / Git 工具集；ca-certificates：访问真实 LLM 的 HTTPS；
# python3 + pip：uv / uvx 的安装载体（uvx 型 MCP 服务器依赖它）；curl：拉取 uv wheel
RUN if [ -n "${APT_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip curl \
  && rm -rf /var/lib/apt/lists/*
# uv / uvx：mcp-server-time、arxiv-mcp-server、markitdown-mcp 等 Python MCP 的运行时
# （镜像内无 uv 时这些服务器会以 spawn uvx ENOENT 连接失败）
# 索引走阿里云 PyPI 镜像；npm 走 npmmirror，避免 npx 型 MCP 首次拉包超时
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/ \
    UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    UV_LINK_MODE=copy
# 已知坑：部分网络下 pip 直连索引会卡在 wheel 下载（curl 拉同一镜像可达 30MB/s+），
# 因此先用 curl 取与当前架构匹配的 uv wheel，再本地安装
RUN set -eux; \
  url=$(curl -fsSL https://mirrors.aliyun.com/pypi/simple/uv/ \
    | grep -oE 'packages/[^"]*\.whl' \
    | grep "$(uname -m)" \
    | grep -E 'py3-none' \
    | grep -v musllinux \
    | grep manylinux \
    | tail -1); \
  test -n "$url"; \
  fn=$(basename "$url"); \
  curl -fsSL -o "/tmp/$fn" "https://mirrors.aliyun.com/pypi/$url"; \
  pip3 install --no-cache-dir --break-system-packages "/tmp/$fn"; \
  rm -f "/tmp/$fn"; \
  uv --version; uvx --version
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace @multi-agent/server --include-workspace-root --registry=${NPM_REGISTRY} \
  && npm cache clean --force
# 构建产物：server/dist（tsup，@multi-agent/shared 已内联）+ client/dist（vite）
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
# 运行时资产：Agent 资产包 + 技能库（config.ts 按 ROOT_DIR 解析，缺一不可）
COPY agents agents
COPY skills skills
# MCP JSON 直配（${VAR:-默认} 变量在容器启动时展开，可覆盖 data 目录下的存储路径）
COPY mcp.json mcp.json
# 数据与工作区（建议以卷挂载持久化；Linux 宿主需 sudo chown -R 1000:1000）
RUN mkdir -p data workspace && chown -R node:node data workspace
# 预热 MCP 运行时依赖：uvx / npx 首次运行要联网装包，而 MCP 连接超时写死 15s（MCP_CONNECT_TIMEOUT_MS），
# 冷启动必然失败。注意 MCP 子进程只继承 getDefaultEnvironment()（PATH / HOME 等），
# 不继承镜像里的自定义 ENV，所以镜像源与缓存必须落到 HOME 下的配置文件与默认目录：
#   ~/.npmrc（npmmirror）、~/.config/uv/uv.toml（阿里云 PyPI）、~/.cache/uv、~/.npm/_npx
USER node
RUN set -eux; \
  npm config set registry https://registry.npmmirror.com; \
  mkdir -p /home/node/.config/uv; \
  printf '[[index]]\nurl = "https://mirrors.aliyun.com/pypi/simple/"\ndefault = true\n' > /home/node/.config/uv/uv.toml; \
  uvx --from mcp-server-time python -c pass; \
  uvx --from arxiv-mcp-server python -c pass; \
  uvx --from markitdown-mcp python -c pass; \
  npm exec --yes --package=@dangahagan/weather-mcp@latest -- node -e 0; \
  npm exec --yes --package=yfinance-mcp -- node -e 0

USER node
EXPOSE 8787
# 健康检查（/api/health 在鉴权保护下，配了 AUTH_TOKEN 时携带）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const u='http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health';const h=process.env.AUTH_TOKEN?{authorization:'Bearer '+process.env.AUTH_TOKEN}:undefined;fetch(u,{headers:h}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/index.js"]
