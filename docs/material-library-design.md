# 用户素材库 与 产物审批流——必要性评估与详细设计

> **状态**：已实施（2026-09-19，M68 P1 收口）——实现与本文一致，差异见文末「实施回写」（同日增补：素材种类扩展至音频，含管理页筛选与播放）
> **关联**：M31 画布（design.md §49，预留"全局素材库扩展位"）· M57 多用户基座（ADR 0134）· ADR 0147（用户配额）· ADR 0148（个人资源：scope/owner_id 先例）· M33 附件上传（白名单 / 文件名安全化）· M62（BROWSER_MAX_* 环境配额先例）

## 1. 背景：两个候选方向的定位

| 方向 | 一句话 | 来源 |
| --- | --- | --- |
| **A. 产物审批流** | 生成 → 确认 → 落画布（单人 HITL 把关） | ADR 0146 失效条件预留 |
| **B. 用户素材库** | per-user 私人素材库（跨会话复用上传 / 收藏的图片视频）+ 独立菜单管理页面 | M31"全局素材库扩展位"（当时单用户） |

## 2. 方向 A 评估：产物审批流 —— 必要性低，现有能力覆盖 80%

### 2.1 现状盘点（已核实）

- **生成前审批已零代码可用**：`APPROVAL_TOOLS`（env 列表，engine `approvalGate` 显式清单分支）——把 `media_generate,media_video` 写入即"agent 触发生成前挂起审批卡，批准后才创建任务"。审批卡 / 挂起恢复 / 超时拒绝全套既有（M7）。
- **agent 决策本就受控**：media 工具为 deferred（需 tool_search 激活）+ 全角色白名单 + 提示词纪律；乱生成的概率低。
- **产物已有完备追溯**：产物必落交付件（`artifact:updated`）+ 画布占位节点（jobId 谱系）——不存在"未经审视进入系统"的路径。

### 2.2 "生成后确认才落画布"（形态 B）为何不建议

- 落画布是**展示行为**而非入库行为（产物已在交付件体系）；确认步骤只增加摩擦不增安全；
- ADR 0146 已留改造路径（"占位→候选→确认"），当前无需求证据，避免过度工程。

### 2.3 建议（如确需）

| 级别 | 措施 | 成本 |
| --- | --- | --- |
| 立即可用 | 文档示例：`APPROVAL_TOOLS=media_generate,media_video` | 0 |
| 可选增强（P2） | 把 `approvalTools` 纳入运行期设置（设置页多选）——支持不改 env 的热调整 | 小（RuntimeSettings 白名单 + 设置项） |
| 不建议 | 平台级"产物候选区 / 审批工作台" | 大且无场景 |

**结论 A：不做新功能；写入文档与设置示例即可（若需要，P2 小增强）。**

## 3. 方向 B 评估：用户素材库 —— 必要性成立，建议做（per-user）

### 3.1 痛点（现状链路全断）

现有一切媒体资产绑定**会话工作区**：上传落 `workspace/<sid>/canvas/media/up-*`、生成落 `gen-*`（皆= 会话交付件）。跨会话复用只有"人工找旧会话 → 下载 → 到新会话重新上传"——素材墙是会话级的，换会话即归零。内容创作场景（图片/视频素材反复使用）下这是**高频摩擦**。

### 3.2 为什么必须 per-user（而不是"全局共享"）

M57 多用户后"全局库"语义危险：共享素材 = 跨用户文件可见 + 权限/配额/内容安全全都要新设计。**正解与 ADR 0148（个人连接）同构**：`owner_id` 归属，仅属主可见；admin 不提供"浏览他人素材"（文件内容比连接元数据敏感——治理用**存储用量统计**替代，见 §7）。

### 3.3 设计原则

1. **用户级归属**：`owner_id`（服务端取登录身份；成员与 admin 一样只看自己的——与 0148"admin 管理台可看 personal"不同，理由：文件内容隐私级别更高，且素材无"管理排障"诉求）；
2. **管理页面独立菜单**（用户明确要求）：ActivityRail 全员可见入口 + 主区全幅 `MaterialsConsole`（与 Skill/Agent 管理同模式，但**非 admin 专属**）；
3. **copy-on-use（引用即入仓）**：素材存用户库；放入画布 / 作为生成输入时**拷贝**进会话工作区（`workspace/<sid>/library/ref-*`）——画布节点 / 生成面板 / agent 沙箱全部按会话工作区解析，零跨根路径改造；
4. **零新增依赖、复用既有能力**：上传（express.raw ≤200MB / 扩展名白名单 / slug 化——同 M31 upload）、配额闸门（`quota.check`——M31 已示范）、Range 内容流（同交付件预览）、管理页组件族（console/*）、缩略图（原生 img/video）。
5. **治理内建**：存储计入用户 `maxStorageMb` 配额（统计源=workdir 体积 + **素材目录**——`QuotaService.storageBytesOf` 增计 `_library/u_<uid>` 一处小扩展，实施回写）。

### 3.4 存储与数据模型

**目录布局**（workspace 内下划线保留段，不与 `s_*` 会话目录冲突；配额统计自动覆盖）：

```
workspace/
├── s_xxxx/                    # 会话工作区（现状）
│   └── library/ref-<ts>-<slug>.<ext>   # copy-on-use 入仓（P1 新增子目录）
├── _library/                  # 素材库根（新增）
│   └── u_<uid>/               # 按用户（同 WorkspaceService.userScopedDir 口径）
│       ├── mat_ab12cd34.png
│       └── mat_ef56gh78.mp4
└── ...
```

**迁移（v19 待核——实施时全仓核对：当前最大 v18）**：

```sql
CREATE TABLE materials (
  id            TEXT PRIMARY KEY,          -- mat_<uuid8>
  owner_id      TEXT NOT NULL,
  name          TEXT NOT NULL,             -- 展示名（原名安全化后；≤120 字）
  kind          TEXT NOT NULL,             -- image | video | audio（doc 类 P2 扩展）
  ext           TEXT NOT NULL,             -- .png / .mp4 …
  mime          TEXT,
  size_bytes    INTEGER NOT NULL,
  rel_path      TEXT NOT NULL UNIQUE,      -- u_<uid>/<id><ext>（相对 _library 根；仅 [a-z0-9-./]，防穿越）
  source        TEXT NOT NULL,             -- upload | generate | artifact（收藏来源）
  src_session_id TEXT,                     -- 可选：收藏自哪个会话（无外键——会话可删）
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_materials_owner ON materials(owner_id, created_at DESC);
```

### 3.5 API（`/api/library/*`，登录态；owner 一律服务端取，不信请求体——0148 纪律）

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/library/items?query=&kind=&limit=&cursor=` | 我的素材列表（元数据，不含内容；新→旧；query 对 name 子串） |
| POST | `/api/library/uploads` | 上传（raw 二进制 ≤200MB；`x-file-name` header 携原名；白名单扩展名；**复用存储配额闸门**）；返回条目。（上传单独路径：raw 中间件仅挂 `/api/library/uploads`，其余素材库端点走全局 JSON 解析——避 `/items` 下子路由被 raw 误拦） |
| DELETE | `/api/library/items/:id` | 删除（行 + 文件；非属主 404——不泄漏存在性） |
| GET | `/api/library/items/:id/content` | 内容流（Range；`Content-Type` 白名单；owner 校验） |
| POST | `/api/library/items/:id/to-canvas` | **copy-on-use**：`{ sessionId }`（须可访问）→ 拷贝到 `workspace/<sid>/library/ref-…` → 返回 `{ path, kind }`；前端按 `sendArtifact` 同逻辑落节点 |
| GET | `/api/library/usage` | 我的素材用量（条数 / 字节；与全局使用量卡同口径，可并入 `/api/usage/me`） |

> 服务端组件：`server/src/library/service.ts`（store：DB + 文件写入/删除/拷贝 + 配额闸门调用）+ `server/src/routes/library.ts`；`shared`：`LibraryItem` 类型 + api.md 契约。

### 3.6 前端：独立菜单页面（用户要求）

**导航（ActivityRail）**：基础列表加「素材库」（`Images` 图标，**全员可见**——个人资源非管理面；与"工作台"同级、管理组之上）：

```ts
// ActivityRail.tsx：items = [{ view:'workspace'…}, { view:'materials', label:'素材库', icon: Images }, ...(isAdmin ? ADMIN_ITEMS : [])]
// ui-store：AppView 增 'materials'；AppLayout 分发 <MaterialsConsole />（window.workspace 之外的全幅视图，同 console 族）
```

**`MaterialsConsole`（P1 功能面）**：

- **头部**：标题「素材库」+ 条目数 + **容量条**（`usedMb / maxStorageMb`，超 80% 变琥珀——同上下文电池颜色纪律；无配额时不显示）+ 「上传素材」按钮（多选，拖拽到页面亦可）；
- **工具行**：搜索框（name 子串）＋ 类型筛选（图片/视频/音频；**默认选中第一个「图片」**——2026-09-20 修订：移除「全部」项 + 默认首项，点选过滤 / 再点取消回全部）＋ 排序（最新/最大）；
- **网格**：卡片（图片=缩略图直显 / 视频=`<video preload=metadata>` 静帧 / 音频=音符占位）；悬停操作条：「放入当前会话画布」·「下载」·「删除」（危险色）；点击卡片 → **预览灯箱**（复用消息图片 Lightbox 交互；视频 / 音频带播放）；
- **批量（P2）**：多选 → 批量删除；
- **空态**：引导文案「上传的图片 / 视频会保存在这里，跨会话随取随用」+ 上传按钮。

**画布侧集成（P1 最小闭环）**：
- 「放入画布」→ 调 `to-canvas`（入仓）→ 复用 `sendArtifact` 式落节点（图片直出 / 视频直出；位置=视口中心）；无当前会话 → toast 引导；
- （P2）生成面板输入槽位增「从素材库选取」（选择器复用同一列表 API；选后入仓取路径）；画布上传时勾选「同时存入素材库」。

### 3.7 治理与安全清单

| 面 | 措施 |
| --- | --- |
| 归属 | 列表/内容/删除/to-canvas 全链路 `owner_id` 过滤；非属主一律 404（口径同 0148） |
| 上传 | 扩展名白名单（图片 / 视频 / 音频——与附件通道 `util/mime.ts` 同口径）＋ 原名 slug 化（`util/paths` 同款）＋ 单文件 200MB |
| 内容流 | Range + 白名单 Content-Type；绝不 inline 渲染不可信类型 |
| 配额 | 复用 `quota.check`（workspace 体积含 `_library` → 统计零改动）；超限 403 文案引导 |
| 磁盘 | 删除双清（行+文件）；**用户删除级联** `_library/u_<uid>/` 整目录清理（入 users 删除链路，同 0148 `removePersonalOf` 模式）；孤儿对账（行/文件互查）列 P2 |
| 备份 | `workspace/` 已在备份/快照惯例内（`data/*backup*` 同源）——`_library` 自动覆盖 |
| 迁移兼容 | 兼容模式（单用户）owner 缺省段为 `u_<admin>`（同 workspace 现有回退口径）；存量会话素材**不自动入库**（避免一次性拷贝风暴）——用户按需「存为素材」（P2） |

### 3.8 分期

| 期 | 内容 | 预估 |
| --- | --- | --- |
| **P1** | 迁移 + service/路由 + MaterialConsole（列表/上传/网格/预览/删除/容量条）+ ActivityRail 入口 + 放入画布（to-canvas 入仓）+ 单测/组件测/E2E | 中（1 个批次） |
| P2 | 生成产物「存为素材」· 交付件「存为素材」· 生成面板选图槽 + 画布上传同时入库 · 批量操作 · 孤儿对账 | 中 |
| P3 | 去重（hash）· 标签 · 文档类素材 · 素材库内直接发起生成 | 视需求 |

### 3.9 被否决

- **全局共享素材库**（跨用户可见）：权限/配额/内容安全全需新设计，且无共享场景证据；
- **admin 浏览他人素材**（0148 的 admin 例外不沿用）：文件内容隐私级高于连接元数据；治理走用量统计；
- **素材存 `data/library/` 而非 workspace**：存储配额统计需改统计源、备份面分裂——放 workspace 内一切零改动；
- **存量会话素材自动迁移入库**：一次性拷贝风暴 + 去重困难，改为按需收藏；
- **画布节点直接引用素材库路径**（跨根引用）：沙箱/生成/agent 全部按会话工作区解析，跨根要动内核——copy-on-use 一步化解。

## 4. 结论与建议

| 方向 | 必要性 | 建议 |
| --- | --- | --- |
| A 产物审批流 | **低**（配置即覆盖 80%） | 不新建；文档示例；可选 P2 把 approvalTools 纳入运行期设置 |
| B 用户素材库 | **成立**（跨会话素材复用是真实高频摩擦；per-user 隔离有 0148 现成模式） | **建议按 P1 实施**（独立菜单管理页面 + 上传/预览/删除/放入画布 + 配额治理） |

**已确认约束**（源自本轮需求）：按用户区分（per-user owner 隔离）✅ · 独立菜单页面管理 ✅（ActivityRail 全员入口 + MaterialsConsole 全幅视图）。

## 5. 实施回写（M68 P1，2026-09-19）

- **与设计的差异**：① 上传端点取 `POST /api/library/uploads`（见 §3.5 注）；② 存储配额统计为非零改动（`QuotaServiceDeps.libraryUserDirOf` 注入 + `storageBytesOf` 增计；新增 `assertUserStorageAllowed(userId, extra)` 用户级闸门，M31 会话上传闸门改为其代理）；③ 单用户兼容模式 owner 固定 `'local'`（素材库两种部署均可用，与用量体系的"兼容模式空数据"策略不同——后者仍维持）。
- **落位**：`server/src/store/materials.ts`（迁移 v19）· `server/src/library/service.ts` · `server/src/routes/library.ts`（+ApiDeps.library / raw 中间件 / users 删除级联）· `client/src/stores/library-store.ts` · `client/src/components/console/MaterialsConsole.tsx` · `ActivityRail / AppLayout / CommandPalette / ui-store(AppView)` · `api.md §23`。
- **验证**：server `m68-library`（8：属主隔离 / 白名单 / 配额透传 / 双清 / copy-on-use / 账号级联）；client `m68-materials`（7：store 四链路 + 页面空态 / 网格 / 筛选 / 入画布）；E2E `m68-library`（2：管理页面全流程 / 放入画布入仓断言）。

### 5.1 后续增补（2026-09-19）

- **音频素材支持**：素材种类由「图片 / 视频」扩展为「图片 / 视频 / 音频」——白名单 / MIME 与附件通道（`util/mime.ts`：mp3 / wav / ogg / m4a / flac / aac）同口径；`kind=audio` 贯通 store / service / 路由筛选；管理页新增「音频」筛选、音符占位缩略图与音频灯箱播放（`<audio controls>`）；`to-canvas` 对音频落 artifact 引用节点（画布无音频直出节点，维持最小闭环）。验证：server `m68-library` 10 例 / client `m68-materials` 8 例全绿。
- **预置样例素材（大自然主题）**：为演示预置 41 项免费素材——图片 19（Pexels：雪山 / 森林 / 海滩 / 星空 / 极光 / 沙漠 / 野生动物等）、视频 7（水母深海 / 林间瀑布 / 溪流 / 草原 / 地球卫星视角 / 花朵与昆虫微距）、音频 15（自然声 12：大雨 / 雨打树叶 / 雷鸣 / 海浪 / 溪流 / 瀑布 / 林间风 / 篝火 / 鸟鸣 / 蟋蟀 / 猫头鹰 / 鲸歌；背景音乐 3：宁静森林 / 自然 / 开放电影原声），来源与许可记录于 `data/library-import/manifest.json`（暂存媒体已清，仅保留来源清单）。
- **乐器声音补充**：追加 19 项乐器素材——单音采样 12（tonejs-instruments：钢琴 / 木吉他 / 电吉他 / 小提琴 / 大提琴 / 长笛 / 萨克斯 / 小号 / 竖琴 / 木琴 / 单簧管 / 管风琴；采样来源含 VSCO 2 CE / Iowa / Karoryfer，清单见 `data/library-import/sample-source-info.txt`）、乐器曲目 5（opengameart：情感钢琴 / 小提琴独奏 / 排笛 / 幽静竖琴（CC-BY）/ 吉他小夜曲）、其他 2（MDN 木吉他扫弦 CC0 / moodist 颂钵 Pixabay）。库内合计 60 项 / 290.3 MB。
- **筛选 chip 移除「全部」项 + 默认第一个（2026-09-20）**：类型筛选 = 图片 / 视频 / 音频，**默认选中第一个「图片」**（点选过滤、再点同类取消——回全量请求不带 `kind` 参数）；首载即按默认筛选请求（不做「先全量再切换」）；上传 / 删除后的对账刷新沿用当前筛选（`lastFilter`，不回落全量）；空态按「库为空」（usage 计数 0 → 引导上传）与「筛选 / 搜索无命中」（→「没有匹配的素材」）分流；客户端测试同步断言（`m68-materials`）。
