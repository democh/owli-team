---
name: api-design
description: 接口设计规范：当需要设计或评审 REST API 时使用
tags: [api, backend]
---

# REST 接口设计规范

## 使用步骤

1. 明确资源与操作，先写「名词 + 方法」清单。
2. 按规范补齐入参 / 出参 / 错误码。
3. 产出接口表交付。

## 规范要点

- 路径用复数名词：`/api/sessions/:id/runs`；动作用 HTTP 方法表达。
- 统一错误响应：`{ error: string }`，文案面向用户可读。
- 列表接口默认按 `updatedAt` 降序；分页参数统一 `page / pageSize`。
- 幂等：重复提交语义明确（POST 创建需支持去重键或返回既有资源）。
- 时间戳统一 ISO 8601 字符串。

## 输出模板

| 方法 | 路径 | 入参 | 出参 | 错误 |
| ---- | ---- | ---- | ---- | ---- |
| GET  | /api/example | - | `{ items }` | 500 |
