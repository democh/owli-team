# ADR 0159：3D 工作台与 DesignScene 契约——three 栈懒加载边界 · 场景 JSON 唯一事实源 · design-scenes 读写通道（M65-B）

- 状态：Accepted
- 引入：M65 批二（2026-09-19）
- 相关：docs/design-studio-design.md（§3 红线 / §6–§7）· ADR 0064 / 0118（回填纪律）· M31 媒体生成 · [shared/src/types.ts](../../shared/src/types.ts)（DesignScene v1）· [client/src/components/studio/](../../client/src/components/studio/) · [server/src/routes/design-scenes.ts](../../server/src/routes/design-scenes.ts)

## 背景

M65-A 已落 interior 场景资产与 studio 面板注册骨架。M65-B 需把工作台从骨架升级为可用闭环：加载 agent 产出的场景数据 → 3D / 平面渲染 → 编辑（家具 / 材质 / 光照）→ 保存回工作区。三个待决问题：① three 栈与首屏包体的边界；② 场景数据的契约与坐标 / 单位；③ 读写通道（前端保存）与并发（agent 重写 vs 用户编辑）。

## 决策

1. **three 栈懒加载边界（沿用设计红线 §6.2）**：`three@0.175` + `@react-three/fiber@8.18`（React 18 兼容线，v9 需 React 19）+ `@react-three/drei@9.122` 锁定版本；唯一动态导入入口 `studio-lazy.tsx`（StudioSurface）；vite `three-stack` 独立 chunk（B0 实测 gzip 230.82KB ≤ 240KB 预算）；首屏入口零增量。**纪律：任何文件不得静态 import StudioCanvas**（`import type` 允许——编译期擦除）。
2. **DesignScene v1 为唯一事实源（shared 契约）**：单位 mm；俯视坐标 (x, y) 北向上 → 三维 (x, -z)（北 = -Z）；rooms 多边形 / openings 挂墙 / furniture 13 类封闭程序化族 / materials 命名材质板 / lights 日光球坐标（0° = 北）。**解析宽容原则**：顶层结构错误报错（错误卡 + 重试）；条目级非法过滤并计数（不阻塞整体加载）。
3. **读写通道**：读 = artifacts content（raw=1，M6 通道零新增）；写 = 新增 `design-scenes` 路由（PUT）——路径白名单（`design/<名>.scene.json` 单层）+ 2MB 上限 + QuotaService 闸门 + **乐观锁**（`ifUnmodifiedSince` mtimeMs，不符 409 带最新 mtime）+ 写后 artifact 广播。
4. **编辑操作纯函数化**：全部编辑（置入 / 移动 / 旋转 / 删除 / 材质换色 / 光照）为 `design-scene-model` 不可变纯函数（可单测、零 WebGL）；渲染层与面板层只消费，不做第二套逻辑。
5. **v1 范围修订（相对设计文档，诚实登记）**：门窗为贴墙标记板（真洞口布尔运算列 v2）；自由多边形绘制与平面拖拽编辑列 v2（平面视图 v1 为只读展示 + 选中，坐标级编辑经 3D 操作条）；快照 v1 为 PNG 导出（存工作区与图生图联动归 M65-C）；快照依赖 `preserveDrawingBuffer`。

## 理由

- 懒加载 + 独立 chunk 是首屏零增量的唯一工程解（包体预算已在 B0 实测锚定，改版前有量化基线）；
- DesignScene 放 shared 而非 client / server 各自定义：agent（write_file）与工作台（读写）、消息卡（未来 layout 缩略图）三方共用一份契约，避免漂移；
- 宽容解析而非严格拒绝：agent 产出的 JSON 可能带冗余 / 瑕疵，用户视角「部分可用」优于「整文件失败」（与 M54 盘卡表格回退同一纪律）；
- 乐观锁而非版本库：场景文件可由成员（agent）重写，409 + 最新 mtime 让用户显式决策（加载新版 / 覆盖），与画布 baseVersion 先例同构但更轻（mtime 而非版本号）；
- 编辑纯函数化：WebGL 在 jsdom 不可测，把全部业务逻辑挡在渲染层之外（测试全量覆盖）。

## 被否决与边界

- **泛化 artifacts PUT 写通道**：审计面大（任何工作区文件可写）；独立 `design-scenes` 前缀白名单更收敛；
- **房间多边形挤出（ExtrudeGeometry 封闭体）**：内视角看不到内部（顶部封闭）——改用外露墙带 + 地板分离；
- **门窗真洞口（布尔运算）**：需 CSG 依赖与凹凸多边形处理，v1 收益不成比例；
- **场景数据存 localStorage**：不可协作、不可交付（文件体系是唯一事实源）；
- **双份 @types/three 并存**（根 0.186 + client 0.175）：TS 名义类型冲突不可编译——统一为 0.186（与 three 本体 0.175 的运行兼容性经全量构建验证）。

## 影响

- 共享：`shared/src/types.ts`（DesignScene v1 + DESIGN_SCENE_VERSION + FURNITURE_KINDS）；
- 前端：`studio/`（design-scene-model / furniture-parts / StudioCanvas 重写 / StudioPlanView / use-design-scene / studio-lazy props 透传）、`scene/panels/StudioPanel`（完整版）、`index.css`（studio 段）、`vite.config.ts`（THREE_STACK_RE）、`client/package.json`（three 栈 + @types/three 归一 0.186）；
- 服务端：`routes/design-scenes.ts`（新建）+ `routes/index.ts`（挂载）；
- 测试：client m65-scene-model（6）/ m65-studio-panel（6）/ m65-b0 更新（3）；server design-scenes（5）；client 全量 1079 全绿。
