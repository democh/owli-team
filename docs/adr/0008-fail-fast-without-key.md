# ADR 0008：无 Key 处理——启动即报错

- 状态：Amended（M10 起 `LLM_MOCK=true` 为显式例外）
- 引入：v1 决策，M10 修订
- 相关：[design.md §7.4](../design.md)、[operations.md §6](../operations.md)

## 背景

`LLM_API_KEY` 未配置时服务如何行为？备选：fail-fast（启动即报错）或静默降级到假数据。

## 决策

**Fail-fast**：未配置 `LLM_API_KEY` 时服务**拒绝启动**并打印缺失项。

**M10 修订**：唯一例外是**显式开启 `LLM_MOCK=true`**——启用脚本化 Mock Provider（`server/src/llm/mock.ts`），供 E2E 与离线演示使用；该开关必须显式配置，不存在任何隐式自动降级。

## 理由

- 静默降级最危险：用户以为在用真模型，实际拿到假回复，排障成本极高；
- 本地应用启动成本低，报错即修（填 Key）的体验优于「能启动但不可用」；
- Mock 需要显式开关：E2E 需要确定性剧本，但生产环境绝不允许误落入 Mock。

## 被否决的方案

- **无 Key 时自动用 Mock**：生产配置事故时会静默给出假结果；
- **允许启动、首次调用时再报错**：问题暴露太晚，用户需要多步操作才发现配置缺失。

## 影响

- `npm run llm:ping "你好"` 提供冒烟命令验证连通性；
- 启动日志打印模型 / 端点（如 `LLM: deepseek-flash @ https://api.deepseek.com/v1`，Mock 时加注）。
