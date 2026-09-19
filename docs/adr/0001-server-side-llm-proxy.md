# ADR 0001：LLM 调用位置——服务端代理

- 状态：Accepted
- 引入：v1
- 相关：[design.md §7](../design.md)

## 背景

应用需要调用 OpenAI 兼容的 LLM（DeepSeek / OpenAI / Ollama）。备选架构：浏览器直连 LLM 端点，或经 Node 后端代理。

## 决策

**LLM 调用全部经服务端代理**（`server/src/llm/`）：前端只与本地后端通信，后端以 `LLM_BASE_URL` / `LLM_API_KEY` 发起流式请求，再经 SSE 把增量转发给前端。

## 理由

- API Key 永不进入浏览器（不进前端 bundle、不进网络请求、不怕页面泄露）；
- 后端可统一做韧性治理（重试 / 超时 / 并发限流 / usage 成本，ADR 21）与工具循环编排；
- 前端与模型协议解耦：换模型 / 换端点只改服务端配置。

## 被否决的方案

- **浏览器直连 LLM**：Key 必须下发到前端，无法做统一重试与成本统计；CORS 依赖模型厂商配置，不可控。

## 影响

- 后端成为唯一出口：所有 Agent 相关的模型请求都走 `LlmProvider` 抽象（`chatStream`）；
- 生产形态天然支持单端口托管（前端静态资源 + API 同进程）。
