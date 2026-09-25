# ADR 0215：仪式订阅（P4-A）——场景 ritual 声明 · 一键订阅 · 到点建会话并注入 opener

- 状态：Accepted
- 引入：工作生活一体专项 P4 第一批（2026-09-23）
- 相关：[shared/src/types.ts](../../shared/src/types.ts)（RitualDeclaration / RitualSubscription）· [server/src/schedule/service.ts](../../server/src/schedule/service.ts) · [server/src/store/rituals.ts](../../server/src/store/rituals.ts) · [server/src/routes/rituals.ts](../../server/src/routes/rituals.ts) · [server/src/store/migrations.ts](../../server/src/store/migrations.ts)（v31）· [server/tests/ritual-subscriptions.test.ts](../../server/tests/ritual-subscriptions.test.ts) · [client/tests/m-ritual-subscribe.test.tsx](../../client/tests/m-ritual-subscribe.test.tsx)

## 背景

「工作生活一体」专项（docs/work-life-fusion-design.md）的 P4 包含今日时间线首页与仪式化订阅模板。订阅模板是其中首个可独立闭环的能力：场景包以 `_group.yaml` 声明 `ritual`（title / cron / opener / members?），用户一键订阅后由调度到点自动开一场**新会话**并注入 opener——把「每天 22:00 塔罗」「周日 20:00 复盘」这类仪式从人工操作变为常驻能力。M35 定时任务（run / remind）绑定**既有会话**，无法覆盖「到点新建会话」语义；ritual schema 已在 prompts.ts 预埋。

## 决策

1. **独立表 `ritual_subscriptions`（迁移 v31）**：不扩 scheduled_tasks（其 session_id 语义 = 会话内任务、按会话鉴权）；订阅在触发时才物化会话；按 `user_id` 隔离（兼容模式 'local'，与素材库同口径）；
2. **订阅数据服务端独裁**：请求体只收 `sceneId` / `spaceId`；title / cron / opener / members 由服务端从 `_group.yaml` 声明与场景 chain 解析并**快照落库**（声明后续修改不影响已订阅；members 缺省 = chain，空 = 空编制走 PRS 零选择开场）；
3. **执行路径 = 调度同轮**（ScheduleService.tick 内新增 fireRitual）：到期 → spawnRitualSession（建会话，标题 `${title} · MM-DD`；落 opener 用户消息）→ `engine.launch` 进入协作运行 → 结算推进 next + 留痕 `last_session_id`；**补跑窗口同 M35**（延迟超 `scheduleCatchupMs` 只推进不引爆）；生成/启动失败 `settle` 留痕 `last_error`；
4. **幂等与上限**：同用户同场景订阅幂等（返回既有）；上限 10 个/用户（Pro 分层预留放开位）；
5. **API**：`GET/POST/DELETE /api/rituals`（本人资源；多用户跨用户 404 由 store 层 WHERE user_id 兜底；未装配 503）；
6. **前端入口**：新建会话对话框场景卡「订阅 / 已订阅」toggle（仅声明 ritual 的场景渲染；客户端只上报 sceneId / spaceId）；
7. **check:agents 校验**：`PromptLibrary.validate()` 对声明做 cron 合法性 + members 跨引用检查。

## 被否决的方案

- **扩 scheduled_tasks 加 ritual kind**：session_id 非空 + 会话级 CRUD 鉴权与「触发时新建会话」语义冲突，加列会污染 M35 语义；
- **每次触发复用固定会话**：与「仪式 = 一次次重开」的产品语义相背（每日塔罗应新局），且会话无限膨胀、历史混杂；
- **客户端提交 cron / opener**：可伪造任意调度与注入文本；服务端独裁才能集中管控与校验；
- **自建第二个 tick 调度器**：与 M35 双轮询竞态（同一到期时刻两处触发），复用同轮更稳；
- **订阅时强制 members 非空**（必须显式编制）：与「零选择开场」的 PRS 语义冲突——空编制是合法输入。

## 边界与后续

- 今日时间线首页 / 通知空间化分级 / 订阅编辑（改 cron）属 P4 后续批次；
- 测试：server `ritual-subscriptions.test.ts` 7 例（订阅校验 / 幂等 / 上限 / 归属隔离 / 到期触发 / 补跑窗口 / 未到期不触发）· client `m-ritual-subscribe.test.tsx` 2 例（订阅退订 toggle / 未声明不渲染）；
- 镜像面：本 ADR + `docs/adr/README.md` 索引、`docs/api.md` §26、design.md §120、agents/CHANGELOG v101、`docs/work-life-fusion-design.md` 头部（实施落位/待办）。
