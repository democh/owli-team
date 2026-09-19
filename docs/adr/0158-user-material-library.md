# ADR 0158：用户素材库——per-user 私人素材与独立菜单管理页面（M68）

- 状态：Accepted
- 引入：M68（2026-09-19）
- 相关：[docs/material-library-design.md](../material-library-design.md)（必要性评估 + 详细设计 + 实施回写）· ADR 0134（多用户基座）· ADR 0147（用户配额）· ADR 0148（个人资源 scope/owner_id 先例）· ADR 0059（M31 画布"全局素材库扩展位"）· [server/src/library/service.ts](../../server/src/library/service.ts) · [client/src/components/console/MaterialsConsole.tsx](../../client/src/components/console/MaterialsConsole.tsx)

## 背景

画布与媒体链路盘点出两个待定方向：**产物审批流** 与 **用户素材库**（M31 时代预留"全局素材库扩展位"，当时单用户）。

- 产物审批流调研结论：**现有能力已覆盖 80%**——`APPROVAL_TOOLS` 环境配置把 `media_generate/media_video` 列入即"生成前审批"（挂审批卡才创建任务，M7 全套既有）；"生成后确认才落画布"缺需求证据——**不新建**（如需要，P2 把 approvalTools 纳入运行期设置）。
- 用户素材库：现有一切媒体资产绑定会话工作区（上传 `workspace/<sid>/canvas/media/up-*` / 生成 `gen-*`），换会话即归零，"下载→重传"是内容创作的高频摩擦；M57 多用户后"全局库"语义必须细化——**per-user 私人库**（跨用户共享涉及权限/配额/内容安全全栈新设计，且无场景证据）。

## 决策

1. **归属模型（同 ADR 0148 纪律）**：`owner_id` 一律服务端从登录身份取（不信请求体）；单用户兼容模式固定段 `'local'`（两种部署均可用）；列表 / 内容 / 删除 / to-canvas 全链路 owner 过滤，非属主一律 404（不泄漏存在性）。**admin 不提供"浏览他人素材"**（文件内容隐私级高于连接元数据；治理走存储用量统计）。
2. **独立菜单管理页面**（用户明确要求）：ActivityRail 新增「素材库」**全员可见**入口（个人资源非管理面，区别于 Agent/Skill/MCP 管理）；主区全幅 `MaterialsConsole`（页头容量条 / 搜索 / 类型筛选 / 网格卡片 / 预览灯箱 / 上传（多选 + 拖拽）/ hover 操作：放入画布 · 下载 · 删除）+ 命令面板入口。
3. **存储布局**：`workspace/_library/u_<uid>/<id><ext>`（`_` 前缀保留段不与 `s_*` 会话目录冲突；位于 workspace 内 → 配额与备份面自然对齐）；迁移 **v19**（materials 表；owner_id 无 FK——账号删除显式级联 `removeOf`：行全删 + 属主目录整清）。
4. **上传与内容**：`POST /api/library/uploads`（raw ≤200MB；**上传单独路径**——raw 中间件仅挂该路径，避 `/items` 子路由被误拦；`x-file-name` 携原名；图片/视频白名单与画布上传同口径）；内容流 `GET /items/:id/content`（`res.sendFile` 原生 Range/206 + MIME 白名单）；展示名安全化（去路径分隔/控制字符，≤120 字保留扩展名）。
5. **配额治理（小扩展一处）**：`QuotaServiceDeps.libraryUserDirOf` 注入（`storageBytesOf` 增计素材目录）；新增 `assertUserStorageAllowed(userId, extraBytes)` 用户级闸门（M31 会话上传闸门改为其代理，行为不变）；容量条 `GET /api/library/usage`（limitMb 命中配额时下发；>80% 琥珀 / >95% 玫瑰）。
6. **copy-on-use（引用即入仓）**：`POST /items/:id/to-canvas { sessionId }`（会话可访问校验）→ 拷贝为会话工作区 `library/ref-<ts>-<id><ext>` → 返回 `{ path, kind }`；前端 `library-store.toCanvas` 复用 `canvas-store.sendArtifact` 落节点（图片/视频直出）。**跨根引用一步化解**：画布 / 生成面板 / agent 沙箱全部按会话工作区解析，零内核改动。

## 理由

- **per-user 而非共享**：M57 的隔离纪律一以贯之（0148 同构）；素材是"个人文件资产"，共享库的复杂性远超潜在收益；
- **放 workspace 内而非 data/**：配额统计、备份快照、磁盘治理三面零分裂——仅需统计源加一项（已做）；
- **copy-on-use 而非引用**：跨工作区路径解析要动沙箱/生成/画布全链路内核，拷贝一个轻量文件一步到位（素材多为 KB-MB 级）；
- **独立菜单 vs 设置页内嵌**：用户明确要求"单独的菜单页面做管理"；且素材有独立工作流（浏览/预览/批量），内嵌会挤压设置页信息架构；
- **复用清单**：上传白名单/raw 模式（M31）、配额闸门（M57 P3）、sendFile Range（交付件内容流同款）、console 组件族、ActivityRail 导航体系——零新增依赖。

## 被否决的方案

- **全局共享素材库**（跨用户可见）：权限/配额/内容安全全需新设计，无共享场景证据；
- **admin 浏览他人素材**（不沿用 0148 的 admin 例外）：文件内容隐私级更高；治理走用量统计；
- **素材存 `data/library/`**：配额统计改口径 + 备份面分裂；
- **存量会话素材自动迁移入库**：一次性拷贝风暴 + 去重困难——改为按需「存为素材」（P2）；
- **画布节点直接引用素材库路径**（跨根引用）：需动沙箱/生成/画布内核——copy-on-use 化解；
- **产物审批流平台级新建**：`APPROVAL_TOOLS` 配置即覆盖生成前审批（见背景）。

## 影响

- 服务端：`store/materials.ts`（迁移 v19 + MaterialStore）· `library/service.ts`（上传/双清/内容/copy-on-use/级联）· `routes/library.ts`（6 端点）· `routes/index.ts`（ApiDeps.library + 挂载）· `index.ts`（装配 + raw 中间件 + quota 注入）· `quota/service.ts`（libraryUserDirOf + assertUserStorageAllowed）· `routes/users.ts`（删除账号级联）；
- 共享：`shared/src/types.ts`（LibraryItem / LibraryUsage）；
- 前端：`stores/library-store.ts` · `components/console/MaterialsConsole.tsx` · `ActivityRail / AppLayout / CommandPalette` · `ui-store`（AppView 'materials' + APP_VIEWS）；
- 文档：本 ADR · `docs/material-library-design.md`（评估+设计+实施回写）· `docs/api.md §23` · README 索引；
- 测试：server `m68-library`（8）· client `m68-materials`（7）· E2E `m68-library`（2）。

## 验证

- server 8/8 · client 7/7 · E2E（隔离 8795 + e2e-ux）：管理页面全流程（上传→筛选→删除双清）与放入画布（入仓副本 `library/ref-*` 落节点）——见收口记录；typecheck / lint 干净。

## 适用与失效条件

- 适用：多用户与单用户兼容两种部署（素材库均可用）；P2 扩展点：生成产物「存为素材」· 交付件「存为素材」· 生成面板素材选图槽 · 批量操作 · 孤儿对账（行/文件互查）；
- 失效条件：若引入"团队共享素材"需求，需在 owner 之外增加 ACL 面（复用会话共享矩阵），本 ADR 的 per-user 模型是基线而非终态；
- 已知边界：素材删除不回收已入仓的会话副本（copy-on-use 语义——副本归会话交付件体系）；无去重（P3）；文档类素材不支持（P2/P3 评估）。
