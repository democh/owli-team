# ADR 0007：角色定义——prompts/*.md 文档驱动

- 状态：Superseded → [ADR 0028](0028-agent-packages-scenes.md)（M15：单包目录 `agents/<场景>/<id>/` 取代平铺结构；「文档驱动 + 热更新」原则保留）
- 引入：v1
- 相关：[design.md §21](../design.md)、ADR 15、ADR 28

## 背景

7 个研发角色（PM / 架构 / 设计 / 前端 / 后端 / QA / DevOps）的系统提示词如何组织？备选：硬编码在服务端代码里，或用独立文档承载。

## 决策

**提示词为独立 Markdown 文档**（`prompts/_protocol.md` 通用协议 + `prompts/<id>.md` 角色文档）：

- front-matter 承载元数据：`id` / `name` / `role` / `capabilities` / `avatar` / `handoff` / `tools` / `skills` / `temperature` / `model`；
- 正文即人设与职责描述；
- 服务端启动时加载 + **监听文件变更，改完即生效、无需重启**；
- `npm run check:prompts` 校验 front-matter 合法性。

## 理由

- 提示词迭代是本项目最高频的改动：文档化让「改人设」与「改代码」解耦，非开发者也能参与；
- front-matter 让角色能力（工具白名单 / 可转交对象 / 预载技能）声明式化，引擎按清单过滤（最小权限）；
- 变更即时生效让调参闭环极短（配合 M9 的 prompt 版本化与 eval 门禁）。

## 被否决的方案

- **提示词硬编码在 TS 代码里**：改一个字都要重编译重启；无法做文档评审与 diff 追踪。

## 影响

- `prompts/` 成为与 `server/` 并列的一等目录；
- M9 引入 `prompts/CHANGELOG.md` 记录每次改动与对应 eval 分数（ADR 26）。
