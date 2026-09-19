# 家装设计工作室与风水阳宅专项设计（M65–M66）：3D 空间设计 · 效果图链路 · 堪舆点评

> 状态：**设计定稿（评审完毕）**（2026-09-19 · 设计版本 v1.2——评审批一：五项决策落档（§14.5）+ 方案书轻量打印视图（§7.7）；批二：媒体连接现状落档（未配置 · 保留扩展 · 首发走降级链路）+ §5 / §7 / §10 按本文设计定稿）
> 实施注记（2026-09-19）：**M65-B0 ✅**（three@0.175 / R3F 8.18 / drei 9.122；three-stack gzip 230.82KB ≤ 240KB）+ **M65-A ✅**（interior 资产 + eval 33 + studio 注册骨架；CHANGELOG v75）+ **M65-B ✅**（DesignScene 契约 + 三层实现 + design-scenes 通道；ADR 0159 / v77）+ **M65-C ✅**（三容器族 + 三卡片 + 打开通道 + 快照入库 + 打印视图；ADR 0167 / v82 / E2E m65-studio 1/1）+ **M66-A ✅**（fengshui 场景 + 司南/察隅 + luopan_pan 工具（golden 5）+ eval 34 + 禁词四层扫描；ADR 0168 / v83）+ **M66-B ✅**（罗盘第五盘卡 + 双盘 + 合规色带 + 九宫叠图；ADR 0171 / v85 / E2E m66-fengshui 1/1）+ **M66 续完善 ✅**（择日盘 zeri_pan（第六件套；历法基础 + 建除 golden）+ 兼向判定（A 级门槛）+ 叠图旋转对齐；ADR 0175 / v88 / E2E m66-fengshui 2/2）+ **M66 v3 ✅**（叠图自动找正：指北交互 + 快照识别；ADR 0178 / v90）——**专项全部完成（含 v2 三件 + v3 自动找正）**；编号落位实测回写：**ADR 自 0178 起 / CHANGELOG 自 v90**。
> 范围：**2 个新场景 / 5 个新角色 / 3 个技能 / 2 个预设**（interior 家装设计工作室 · fengshui 堪舆阳宅）＋ **3D 技术基座**（three.js 栈 + studio 工作台面板）＋ **设计容器族三支**（`layout` / `styleboard` / `render`）＋ **消息内方案预览卡**＋ **图生图效果链路**（复用 M31 `media_generate` image2image）＋ **风水工具化**（`luopan_pan` 罗盘排盘 + 第五盘卡 + 九宫叠图）
> 关联：[docs/scene-chat-design.md](scene-chat-design.md)（M37 基座 / M38 容器族纪律）· [docs/scene-expansion-design.md](scene-expansion-design.md)（四形态 + 六面板 + 容器族体系）· [docs/pan-interactive-design.md](pan-interactive-design.md)（盘面交互先例 · ADR 0131）· [docs/canvas-agent-linkage-design.md](canvas-agent-linkage-design.md)（画布联动）· M31 媒体生成（`media_generate` / 画布落位 / 工作流模板）
> 编号核对（2026-09-19 **开工前实测**——落笔期快照已过时，按既有教训全仓重核）：最新 ADR **0153**（0148–0153 = 个人资源 / M39 三件套 / 画布完善 / BYOK）/ design.md **§97**（§95 个人资源 · §96 BYOK · §97 生产型渲染包 M39）/ CHANGELOG **v73**（M39 资产侧）/ eval **32**；里程碑 **M63 已被「命理占星深化」专项占用**（[docs/metaphysics-deepening-design.md](metaphysics-deepening-design.md)，M63-A 已实施）、**M64 为 pk-game 批二预告**（未落盘）。本专项预定（**保持 M65 / M66**，其余顺延）：ADR **自 0159 起**（0154–0158 已被 pk-game M64 / 个人 MCP / 素材库占用）、design.md **自 §100 起**（§98 对抗博弈主面 M64 / §99 个人 MCP）、CHANGELOG **自 v75 起**（v74 已被 M63 盘面深化实际占用；M65-A 已落 v75）、eval **自 33 起**（新增 2 任务）。并发让位口径：与 metaphysics 深化（预告 §94+ / ADR 0148+ / v74+——其实施前将全仓重核）与 pk-game 批二（预告 M64）按「先落盘先保持、后落盘顺延、四处索引对齐」处置（§15.1）。
> 仓库无 Git：动手前按 `data/*-backup-<date>/` 惯例做目录快照；清理 / 回滚不可恢复。

---

## 1. 背景与目标

### 1.1 用户诉求（原文拆解）

| # | 诉求原文 | 设计承接 |
| --- | --- | --- |
| 1 | 基于 three.js 等专业前端 3D 库，实现专业的 3D 设计师 agent 和家装设计师 agent | 新场景 `interior`：`visualizer`（3D 可视化设计师）+ `interior-designer`（主案设计师）＋ `space-planner`（空间规划师）；three.js + @react-three/fiber 栈（§6） |
| 2 | 添加设计专有的场景，和专有的 chat 展示区，有很强的交互性 | `interior` 场景 + `studio` 工作台面板（第 7 类面板，§7）＋ 设计容器族三支 + 消息内方案预览卡（§8） |
| 3 | 能根据用户的诉求上传的图片生成对应的效果 | 附件上传（M33 已有）→ 视觉理解 → `media_generate` image2image（M31 已有）→ `::: render` 效果图卡 + 画布落位 + 迭代（§9） |
| 4 | 新增专业的风水阳宅专家 agent 能做专业的点评 | 新场景 `fengshui`：`yangzhai-master`（阳宅堪舆师）+ `plan-surveyor`（户型解析师）；`luopan_pan` 工具 + 第五盘卡 + 九宫叠图（§10） |
| 5 | 详细设计 + 专业设计文档与评估 | 本文档（§1–§15，含工作量 / 风险 / 收益评估） |

### 1.2 现状与缺口（一页判断，2026-09-19 快照）

| 维度 | 现状 | 缺口 |
| --- | --- | --- |
| 家装设计 | `housing.reno-designer`（筑居）＝**工程视角**：预算分配 / 施工排期 / 验收清单 | **设计生产视角全空白**：需求研判 → 风格体系 → 空间规划 → 效果呈现的方案链路无承接；「好看且好住」的视觉决策无载体 |
| 3D 能力 | 零。画布为 React Flow 2D（节点图）；文档中唯一提及 three.js 处为 pan-interactive §764 —— 当时出于体量考虑选择自绘 SVG 否决引入 | 户型 → 3D 空间可视化 / 家具布置 / 材质光照 / 漫游视角全空白；three.js 栈无接装先例 |
| 效果图生成 | `media_generate`（M31）已具备 text2image / **image2image**（输入图 1–4 张 · 工作区相对路径）+ `workflow_id` 工作流模板 + 异步任务管线 + 产物落交付件 / 画布 | 设计域的 **prompt 工程纪律**、人机联动（3D 截图 → 图生图）、产物在消息流的结构化承接（`render` 卡）空白 |
| 风水堪舆 | `metaphysics` 7 角色（四柱 / 紫微 / 六爻 / 大六壬 / 梅花 / 七政 / 奇门）＋ `astrology` 4 角色；**无堪舆（风水）门类** | 罗盘定向 / 八宅游年 / 玄空飞星 / 户型格局点评全空白；无方位类盘面工具 |
| Chat 展示区 | 四形态（stream / dock / roundtable / arena）+ 6 面板（pool / versus / board / console / coach / chartboard）+ 容器族（idea / score / sources / decision / claim / offer / pan …）体系完备 | 无设计类面板，无 3D 空间承载，无户型 / 风格 / 效果图容器；盘族仅四类（缺方位盘） |
| 技能 | 51 个（含 visual-design / design-system / frontend-design 等通用域） | 家装设计方法论、3D 空间表现与出图、堪舆阳宅三个专属技能空白 |
| 图片输入 | M33 附件：图片上传（最大 200MB / 单条 10 件）→ 视觉通道注入（最近消息优先，png/jpeg/webp/gif）→ 模型可直接「看到」户型图 / 房间照 | 与设计链路的结合（户型图解析 → 布局转译）无协议承接（依赖人设约定，需写入场景协议） |

### 1.3 目标与验收（验收导向）

| 目标 | 验收标准 |
| --- | --- |
| 场景覆盖 | 31 场景全量可用（29 + interior + fengshui）；两场景 guide / agenda / 协议齐备；`check:agents` 通过（119 角色） |
| 3D 基座 | `studio` 面板落地第 7 类面板：three.js 栈全部懒加载（首屏包零增量，独立 chunk）；支持 视角 / 平面编辑 / 家具 / 材质 / 光照 / 快照 / 持久化 七组能力（§7.3） |
| 强交互闭环 | 「上传户型图 → agent 写场景 JSON → 工作台加载微调 → 快照 → 图生图效果图 → 消息 render 卡 → 迭代」全链路可跑通；一切交互只回填草稿（ADR 0064 / 0118） |
| 效果可验 | 图生图链路在有媒体连接的环境下产出效果图（落交付件 + 画布 image 节点 + render 卡展示）；无连接时清晰引导（「设置 → 媒体生成」，绝不静默失败） |
| 风水可验 | `luopan_pan` 工具精确计算（二十四山 / 八宅游年 / 流年飞星）附 golden 案例；盘面走 `::: pan luopan` 结构化输出；先盘后论、禁止心算兜底 |
| 合规红线 | `fengshui` 协议落「文化研习与参考」定位 + 精度边界声明 + 不恐吓 / 不承诺 / 不做结论性建议（口径对齐 ADR 0111） |
| 方案书输出 | 工作台「打印视图」可导出（浏览器存 PDF，零新依赖，§7.7） |
| 零回归 | 四包 typecheck / lint / 双端 vitest / build / check:agents / check:skills / eval / E2E 全绿；既有 29 场景资产零改动；消息协议 / 编排 / Run 语义零变化 |

---

## 2. 定位与边界（与既有资产切割）

| 既有资产 | 定位 | 与本专项关系 |
| --- | --- | --- |
| `housing.reno-designer`（筑居） | 装修**工程执行**：预算分配 / 施工排期 / 验收清单；收口棒 | **上下游 handoff**：设计定稿（interior）→ 装修规划（housing）；预算冲突回交。资产零改动（仅预设引用） |
| `housing` 场景（择邻 / 家树） | 购房决策链（选房 / 贷款 / 装修预算） | 场景级 handoff：`interior.visualizer → housing.reno-designer`；`interior.interior-designer ↔ housing.home-finder`（户型需求） |
| `metaphysics`（7 角色） | 传统**数术研习**（四柱 / 紫微 / 六爻 / 大六壬 / 梅花 / 七政 / 奇门）+ 排盘工具四件套 | **门类互补**：堪舆（风水）独立成场景（术数一大门类，体系与排盘差异大）；跨场景 handoff（术数联参：命理 ↔ 宅运） |
| `astrology`（4 角色） | 西方占星 | 无关；零交叉 |
| 画布（React Flow） | 自由节点画布 + 媒体节点 + 生成面板 | **复用**：效果图 / 3D 快照经 `place_on_canvas` 落 image 节点（M31 机制零改动）；3D 工作台与画布是两个独立承载（工作台服务于场景，画布服务于全局素材组织） |
| `media_generate`（M31） | 通用媒体生成管道（ComfyUI 等连接） | **零工具改动**：复用 image2image + `workflow_id`；设计域只新增 prompt 纪律（§9.2）与 3D 快照输入管线（§9.3） |
| M34 `fin_game` | 矩阵博弈推演 | 无关；不引入 |
| `blank` / `general` | 单助手直聊 | 无关 |

**范围外（明确不做）**：专业 CAD/BIM（承重结构计算 / 施工图出图）；商品级 3D 建模（导入高模 GLB 渲染 pbr 写真——v2 评估）；AR/VR 预览；工程报价单（housing 域）。

---

## 3. 设计原则与红线

**沿用 M37 §3.1 全部七条**：线性主干不变（视图层派生，不动消息协议）· 流式纪律（流式纯文本、完成态挂载）· 结构键契约 · 安静模式与 reduced-motion 登记 · 统一回填语义（composerInsert + sessionStorage）· 静默降级（绝不报错 / 空白）· 文案精简口径。

**沿用 M52 形态纪律**：`stage` 未声明即 stream；四形态全部为视图层派生，异常一律回退纯对话流；dock 面板「无数据不展示」（M58 口径）。

**新增红线（本专项特有）**：

1. **3D 性能红线**：three.js 栈**全部 dynamic import**（`React.lazy` + 独立 manualChunks，§6.2）——首屏包零增量是硬约束；Canvas `dpr` 上限 `[1, 2]`、静止帧停（`frameloop='demand'`）、面板不可见即暂停渲染；**单会话同一时刻最多 1 个活跃 WebGL 上下文**——消息流内一律不建活 WebGL（预览卡用预渲染快照，§8.2），避免虚拟列表 + 多实例上下文（浏览器上限约 8–16）爆栈。
2. **数据单一事实源**：`DesignScene` JSON（§6.3）是 3D 编辑的唯一事实源；消息容器卡与工作台双向联动**只读派生 + 显式应用**（禁双向绑定死循环）；场景文件缺失时的参数化占位布局（§7.5）为一次性 fallback，不落盘。
3. **风水表述纪律**（`fengshui/_protocol.md`，口径对齐 ADR 0111）：文化研习与参考定位，不承诺预测准确；医疗 / 投资 / 法律 / 婚育 / 生死不做结论性建议；禁止恐吓话术与付费化解暗示；术语附白话释义；结论给「参考区间」不给「必然」。**新增「方位精度边界声明」**：未经现场罗盘 / 专业测量时按用户声明方位推演，结论附「依赖声明精度」；磁偏角修正仅在有数据时启用并注明。
4. **先盘后论延续**：风水点评一律先出盘（`luopan_pan` 工具 → `::: pan luopan` 容器）再解读；禁止模型心算兜底冒充工具结果；盘面派生（前端 SVG）失败回退表格（M54 先例）。
5. **流派口径显式**：八宅（以坐山论宅，门向为参考；与「以门论宅」派差异声明）与玄空（下卦口径；兼向替卦 v1 不做、声明边界）；一切推断标注所用流派与前提。

---

## 4. 总览

### 4.1 场景与角色总账

| 项 | 现状 | 本专项新增 | 落地后 |
| --- | --- | --- | --- |
| 场景 | 29 | +2（interior / fengshui） | 31 |
| 角色 | 114 | +5 | 119 |
| 技能 | 51 | +3（interior-design / 3d-visualization / fengshui） | 54 |
| 预设 | 26 | +2 | 28 |
| 头像资产 | 114 | +5（风格化 3D 卡通 v2，512px） | 119 |
| 面板类型 | 6 | +1（studio 3D 工作台） | 7 |
| 容器族 | idea / phase / score / sources / decision / claim / offer / pan / … | +3（layout / styleboard / render）+ 盘族 +1（luopan） | — |
| 专业工具 | 排盘四件套 + fin_* 等 | +1（luopan_pan 罗盘排盘） | — |
| 前端依赖 | — | +3（three / @react-three/fiber / @react-three/drei；独立 chunk） | — |

### 4.2 批次总览

| 批次 | 主题 | 内容 | 依赖 |
| --- | --- | --- | --- |
| M65-A | 设计资产 | interior 场景（`_group.yaml` / `_protocol.md`）+ 3 角色（四段骨架 + 头像）+ 技能 2 + 预设 1 + mock 触发块 + eval 33 | 无 |
| M65-B | 3D 基座 | three.js 栈接装（B0 版本验证）+ `studio` 面板注册（shared / 注册表 / 就绪判定）+ 场景 JSON schema + 平面编辑 + 3D 渲染 + 家具 / 材质 / 光照 + 快照 + 持久化 API | M65-A（stage 声明）；B0 先行 |
| M65-C | 交互链路 | `layout` / `styleboard` / `render` 容器族 + 消息内方案预览卡 + 图生图联动（3D 快照 → image2image）+ 画布回填 + E2E | M65-B |
| M66-A | 风水资产 | fengshui 场景 + 2 角色 + 技能 1 + 预设 1 + `luopan_pan` 工具（算法 + golden）+ mock + eval 34 | 无（与 M65 可并行） |
| M66-B | 盘面与叠图 | `pan luopan` 第五盘卡（LuopanBoard）+ 九宫叠图元件 + 户型号卡扩展 + E2E | M66-A |

---

## 5. 新增场景详细设计

> 通用规范：目录 `agents/<场景>/`（`_group.yaml` + `_protocol.md` + 各角色包）；角色正文四段骨架（职责 / 工作方式 / 交付契约 / 协作接口）；交付件统一 `docs/<文档类型>-<主题>.md`；handoff 指向真实存在的成员（含跨场景）；工具白名单全员含 `handoff`；人设与协议改动登记 `agents/CHANGELOG.md` 并附 `npm run eval` 无回归结论。

### 5.1 `interior` 家装设计工作室

| 字段 | 值 |
| --- | --- |
| description | 家装设计生产链：需求研判 → 空间规划 → 3D 方案与效果图；与置业工程（housing 预算 / 排期 / 验收）区隔——设计专项，产物是方案与视觉呈现 |
| icon / theme | `armchair`｜青瓷绿 `["#0d9488", "#5eead4"]` |
| objective | 把「住得舒服」翻译成看得见、改得动、能落地的设计方案 |
| chain | `[interior-designer, space-planner, visualizer]` |
| 机制 | `parallel: true`（规划与可视化两线可并行推进）、`parallelMax: 2`；order 119 |
| guide / agenda | 「说说你的家，做一套能落地的设计方案」｜议程：上传户型图做方案 / 客厅改造 / 风格与材质定位 / 生成效果图 |
| stage | `dock`，`panel: studio`（§7） |
| defaultSkills | `[interior-design]` |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| interior-designer | 成竹 | 主案设计师 | 需求研判（居住者画像 / 场景清单）、风格定位（情绪板 + 色材方向）、方案统筹与取舍；先解决好住（收纳 / 动线 / 照明）再谈颜值 | `docs/设计方案-<主题>.md` |
| space-planner | 规方 | 空间规划师 | 户型解析（承重 / 门窗 / 厨卫定位）、功能分区与动线、尺度校验（通道 / 家具最小间距）、收纳体系 | `docs/空间规划-<主题>.md` + `design/plan-<主题>.scene.json`（布局数据） |
| visualizer | 塑光 | 3D 可视化设计师 | 3D 场景搭建（场景 JSON 转译 / 家具布置 / 材质光照）、视角与构图、图生图效果图（prompt 工程 + `media_generate`）、迭代出图 | `docs/出图说明-<主题>.md` + 效果图产物（媒体管道落交付件） |

**协议要点（`_protocol.md`，五段式：铁律 / 协作 / 容器约定 / 交付 / 边界）**：

1. **流程铁律**：需求研判先于风格；空间规划先于效果图（无布局不出图）；好住优先于好看（拍照效果让位于日常体验）。
2. **尺度纪律**：一切尺度标注单位（mm 为主）；通道 / 家具间距给合规区间（如主通道 ≥ 900mm、沙发-茶几 300–450mm）；不臆造承重结构，墙体可拆性存疑一律标注「需现场核实」。
3. **效果一致性声明**：效果图为**示意**表现（材质 / 光照 / 色差以实物为准）；图生图迭代保留 seed 便于复现；3D 方案与原户型图不一致处显式标注差异桩。
4. **预算联动边界**：不做预算测算（回交 housing.reno-designer）；方案超预算风险给「档次替代」选项（好住项不降配，视觉项可降配）。
5. **渲染容器约定**（对齐 M38 / M54 先例）：布局方案走 `::: layout`、风格板走 `::: styleboard`、效果图走 `::: render`（语法与资产输出约定见 §8.1）；3D 场景落盘 `design/*.scene.json` 并在容器「方案源：」字段引用。
6. **图片输入约定**：户型图 / 现场照 / 灵感参考图经附件上传；户型图解析输出「结构转译清单」（房间 / 门窗 / 厨卫 / 存疑项），存疑项显式列出不猜。

**handoff**：`interior-designer → space-planner → visualizer`（生产链）；`visualizer → housing.reno-designer`（设计定稿转装修规划）；`interior-designer → housing.home-finder`（户型需求回交）；`space-planner → fengshui.plan-surveyor`（户型转风水解析，跨场景）。

### 5.2 `fengshui` 堪舆阳宅

| 字段 | 值 |
| --- | --- |
| description | 阳宅堪舆点评：罗盘定向 → 盘面排出（八宅 / 玄空流年）→ 格局分维度点评与改善参考；与数术研习（metaphysics 排盘论命）区隔——宅居环境专项，点评围绕房子不围绕命 |
| icon / theme | `compass`｜朱红金 `["#991b1b", "#fbbf24"]` |
| objective | 以传统堪舆为文化参考做居住环境的格局点评：先盘后论、表述克制、建议可执行 |
| chain | `[plan-surveyor, yangzhai-master]` |
| 机制 | `parallel: false`（先解析后判读，严格串行）；order 120 |
| guide / agenda | 「上传户型图或说说房子的朝向，做一次阳宅点评」｜议程：户型图点评 / 罗盘定向排盘 / 流年飞星参考 / 入宅前格局复核 |
| stage | `dock`，`panel: chartboard`（复用第五盘 luopan，§10.2） |
| defaultSkills | `[fengshui]` |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| plan-surveyor | 察隅 | 户型解析师 | 户型图结构化转译（房间 / 门窗 / 厨卫 / 动线 / 存疑项）、朝向与坐向采集（罗盘读数 / 指南针数据 / 用户声明分级）、为盘面准备输入数据 | `docs/户型解析-<主题>.md` |
| yangzhai-master | 司南 | 阳宅堪舆师 | 排盘（`luopan_pan`：二十四山 / 八宅游年 / 流年飞星）、分维度点评（外局 / 坐向 / 门主灶 / 动线光气水）、改善参考（非恐吓、可执行、标注流派口径） | `docs/堪舆点评-<主题>.md` |

**协议要点（`_protocol.md`）**：

1. **文化参考定位**（红线 §3.3 全量落入协议）：不承诺吉凶必应；不做医疗 / 投资 / 法律 / 婚育 / 生死结论；不恐吓（「大凶」「血光」等词禁用）、不暗示付费化解；术语附白话释义；结论给参考区间与适用前提。
2. **先盘后论**：一律先出盘（工具 + `::: pan luopan`）再解读；盘未出不做推断。
3. **数据分级与精度声明**：坐向数据三级——A 级（现场罗盘 / 专业测量，注明磁偏角修正）、B 级（手机指南针，注明 ±5°–10° 误差）、C 级（用户口头描述「坐北朝南」，按八方位最近似落盘并声明粗精度）；未达标数据不进入玄空兼向判定。
4. **流派显式**：八宅以坐山论宅（声明与门向派差异）；玄空 v1 下卦口径（兼向替卦声明不做）。
5. **改善建议纪律**：给「布局调整 / 采光通风 / 色彩材质 / 陈设」四类可执行参考，不涉结构拆改（回交 interior / housing）；避免一切商业化话术。
6. **隐私**：户型图与住址信息仅用于本次点评。

**handoff**：`plan-surveyor → yangzhai-master`；`yangzhai-master → interior.interior-designer`（改善参考转设计调整）；`yangzhai-master → metaphysics.bazi`（宅运 ↔ 命理联参，跨场景）；`plan-surveyor ← interior.space-planner`（设计户型反向解析）。

---

## 6. 前端 3D 技术基座

### 6.1 选型对比（三层栈）

| 方案 | 组成 | 优势 | 代价 | 结论 |
| --- | --- | --- | --- | --- |
| **A · three.js + R3F + drei（采纳）** | `three` + `@react-three/fiber` v8（锁 v8.x——v9 需 React 19，本项目 React 18）+ `@react-three/drei` v9（OrbitControls / Grid / Html / ContactShadows 等按需 import） | 与 React 18 声明式融合（组件即场景）；drei 提供轨道控制 / 网格 / 阴影现成件；社区标准 | 三层依赖约 170–220KB gzip（独立 chunk，首屏零增量）；需锁版本矩阵（§13.2 B0） | ✅ 采纳 |
| B · Babylon.js | 全功能引擎 | 内置编辑器工具链 | 体量更大（~800KB gzip+）；React 集成弱于 R3F | ❌ 否决（体量红线冲突） |
| C · model-viewer | Web Component | 极简、体积小 | 只读查看器：无场景编辑 / 家具操作 / 光照控制；交互天花板低 | ❌ 否决（不满足「强交互」） |
| D · 纯 three.js 无 R3F | 手写命令式 | 依赖最少（单包） | 与 React 生命周期 / store 联动需自研胶水层，长期维护成本高；团队已在 React 声明式范式 | ❌ 否决（工程经济性差） |

**自绘组件（零新依赖）**：平面编辑（SVG 栅格 + 拖拽）、材质色板、罗盘盘面（§10.2）、九宫叠图（§10.3）、图标（lucide 已有）——与仓库「自绘 SVG 先例」一脉（pan-interactive 决策延续）。

### 6.2 包体与加载策略（首屏零增量硬约束）

| 策略 | 口径 |
| --- | --- |
| 动态导入 | `studio` 面板组件与消息级 3D 相关件一律 `React.lazy(() => import(...))` + `Suspense`（骨架屏）；three 栈只在首次打开工作台时加载 |
| chunk 拆分 | vite `manualChunks`：`three` 栈合并为独立 `three-stack` chunk（three + R3F + drei 同 chunk 避免幽灵重复）；与现有 klinecharts / mermaid / echarts 并列管理 |
| 预算门 | `three-stack` chunk gzip ≤ 240KB（预算值）；client build 输出对比引入前基线（构建日志人工核对，超限即评审）；主包（index）与既有 chunk 零增量 |
| 测试替身 | vitest/jsdom 环境不渲染 WebGL：3D 组件走「逻辑层（纯函数：场景 JSON 读写 / 几何计算 / 相机预设 / 快照序列化）」单测；渲染层组件测以 mock `@react-three/fiber` 的 Canvas 为壳（只验证挂载 / 属性 / 交互回填），避免 jsdom WebGL 缺失 |
| E2E | Playwright（Chromium）默认 SwiftShader 软件渲染可用 WebGL1/2；断言走 `data-*` 锚点与 DOM 状态（视角名 / 选中物 / 快照生成标记），不做像素比对（视觉冒烟另行人工核验截图） |

### 6.3 `DesignScene` JSON schema（v1 · 唯一事实源）

```ts
/** 家装 3D 场景数据（v1）——工作区文件 design/<名>.scene.json；agent 经 write_file 产出，工作台读写 */
interface DesignScene {
  version: 1                     // schema 版本（前向兼容：未知版本只读 + 提示升级）
  name: string                   // 方案名（展示用）
  unit: 'mm'                     // 内部单位：毫米（定点整数，避免浮点漂移）
  origin: 'north-up'             // 坐标系：x 向右（东），y 向上（北），原点为图左上角投影
  rooms: Room[]                  // 房间（多边形 + 材质）
  openings: Opening[]            // 门窗洞口（挂墙）
  furniture: FurnitureItem[]     // 家具实例（程序化几何族）
  walls?: WallSegment[]          // 墙体（缺省由 rooms 相邻边推导；显式给出用于异形墙）
  materials: MaterialPalette     // 材质板（全局命名材质，供 room / furniture 引用）
  lights: SceneLights            // 光照（日光方位 + 环境光）
  camera?: CameraPreset[]        // 命名视角（默认视角集 + 用户收藏）
}
interface Room { id: string; name: string; polygon: [number, number][]; height: number; floor: string; wall: string; ceiling?: string }
interface Opening { id: string; roomId: string; wallIndex: number; type: 'door' | 'window'; offset: number; width: number; height: number; sill?: number }
interface FurnitureItem { id: string; kind: FurnitureKind; label?: string; x: number; y: number; rotation: number; scale?: number; material?: string }
interface MaterialPalette { [name: string]: { color: string; roughness: number; metalness?: number; texture?: 'wood' | 'tile' | 'fabric' | 'wall' } }
interface SceneLights { sunAzimuth: number; sunElevation: number; intensity: number; ambient: number }
interface CameraPreset { id: string; name: string; mode: 'orbit' | 'top' | 'walk'; position: [number, number, number]; target: [number, number, number] }
```

**家具程序化几何族（v1 · `FurnitureKind` 封闭枚举，零资产下载）**：`bed`（床）/ `sofa`（沙发）/ `table-dining`（餐桌）/ `table-coffee`（茶几）/ `chair`（椅）/ `cabinet`（柜体）/ `desk`（书桌）/ `tv-stand`（电视柜）/ `wardrobe`（衣柜）/ `plant`（绿植）/ `lamp`（灯具）/ `rug`（地毯）/ `custom-box`（自定义体块，参数化占位）。每类由基础几何（Box / Cylinder / 组合）参数化拼装，风格化低模——**不引入外部 GLB（v1）**；GLB 导入为 v2 评估项（§15.2 开放问题 1）。

**校验**：`DesignScene` 的 parse 走 zod（shared 定义 schema + 类型导出；`useSrcDataset` 先例复用：内联 data 或 src 取数）；非法数据 → 中文错误卡 + 源码回退（fail-safe，§6.2 先例）。

### 6.4 2D → 3D 管线

```
户型图（用户上传）                 DesignScene（工作区 JSON）              3D 渲染
┌─────────────────┐   视觉理解    ┌──────────────────────┐   挤出几何    ┌──────────────────┐
│ 附件（M33）      │ ───────────→ │ space-planner/visualizer │ ─────────→ │ three.js 场景图   │
│ 视觉通道注入     │  结构转译清单  │ 写 design/*.scene.json  │  墙体/地板/开口 │ 材质/光照/家具    │
└─────────────────┘               └──────────────────────┘              └──────────────────┘
        ↑ 用户可直接在工作台：新建空白场景（栅格绘制墙体）→ 拖放家具 → 材质 → 快照
```

- **平面编辑（SVG 2D，俯视尺度视图）**：1 格 = 100mm；矩形 / 多边形房间绘制（顶点吸附 100mm 栅格）；墙体厚度渲染（缺省 120mm）；门窗洞口在墙面段上拖放（离端 ≥100mm 吸附）；家具俯视轮廓拖放 + 旋转（15° 吸附，可 Shift 自由）。
- **3D 联动**：2D 编辑提交（松手 / 面板切换）即重建 3D 几何（`useMemo` 派生，免 diff）；3D 俯视模式可反向微调家具（落点回写 2D 坐标）。
- **转译纪律（agent 侧）**：户型图解析输出「结构转译清单」——每房间标注「实测 / 估读 / 存疑」三态；估读与存疑项在工作台以虚线轮廓呈现并悬浮标注（防「假精确」）。

### 6.5 渲染与性能

| 项 | 口径 |
| --- | --- |
| 帧循环 | `frameloop='demand'`（交互触发渲染，静止不烧 GPU）；行走模式（walk）期间临时 `'always'` |
| 分辨率 | `dpr={[1, 2]}` 上限锁定；面板窄幅（<420px）时 dpr 上限降 1.5 |
| 几何 | 房间挤出 + 家具合并 BufferGeometry（每房间一次合并）；`ContactShadows` 替代实时阴影（默认）；实时阴影仅「光照推演」模式开启（可切换） |
| 光照推演 | 日光方位按「朝向 + 时刻」计算（本地天文近似公式：赤纬 + 时角 → 高度角 / 方位角）；滑动条拖动 60fps 降级为 30fps 节流（rAF 节流） |
| 不可见暂停 | 面板折叠 / 抽屉收起 / tab 隐藏（`document.hidden`）→ 卸载 Canvas（比参数暂停更彻底；重开时从 DesignScene 重建，无状态丢失） |
| 降级检测 | WebGL 上下文创建失败 → 「静态快照模式」横幅（显示最近快照 + 提示）+ 保留 2D 平面编辑（SVG 零依赖） |

### 6.6 快照与导出

| 产物 | 通道 | 说明 |
| --- | --- | --- |
| 视角快照（PNG） | `canvas.toDataURL`（preserveDrawingBuffer 或 `gl.render` 后同步抓取）→ 前端下载 / 经附件通道回传工作区 `design/snapshot-<ts>.png` | 快照即图生图输入素材（§9.3）；也可经画布上传通道（`POST /sessions/:id/media/upload` 先例）落画布 image 节点 |
| 场景 JSON 导出 | 下载 / 保存回工作区（§7.5） | 版本迭代：`design/plan-a-v2.scene.json`（文件名带版本，前端「另存为」自动建议递增） |
| 出图说明（doc） | agent 交付件 | 快照 → 效果图的参数记录（prompt / seed / workflow_id）写 `docs/出图说明-<主题>.md`，保证可复现 |
| 方案书打印视图 | 浏览器打印（`window.print` + print 样式） | 平面图 + 快照 + 效果图 + 风格板 + 房间清单组合页（§7.7）；零新依赖 |

---

## 7. `studio` 工作台（面板详设 · 第 7 类 StagePanel）

> **实施修订（M65-B，2026-09-19）**：门窗为贴墙标记板（真洞口布尔运算列 v2）；自由多边形绘制与平面拖拽编辑列 v2（平面视图 v1 为只读展示 + 选中，坐标级编辑经 3D 操作条）；快照 v1 为 PNG 导出（存入工作区与图生图联动归 M65-C）；快照依赖 `preserveDrawingBuffer`。以上均已随 ADR 0159 登记。

### 7.1 定位与就绪判定

- **定位**：场景工作区形态保持 **dock**（左对话 + 右工作台，不新增第 5 形态——备选方案否决记录见 §15.2）；`studio` 是面板类型增量（`STAGE_PANELS` +1），承载 3D 编辑与出图辅助。
- **就绪判定**（`panelReady('studio')`，对齐 M58「无数据不展示」）：满足其一即就绪——
  1. 会话内存在 `::: layout` 容器（方案已声明）；
  2. 存在交付件 / 工作区引用中的 `design/*.scene.json`（`artifactsOf` 扫描 `.scene.json` 后缀）；
  3. 附件中存在图片且首条用户消息含设计意图词？（**不做**——避免宽口径误亮，维持 1 + 2）。
- **空态与点亮路径**：面板未就绪时不渲染（宿主零感知）；用户经 guide / agenda chips「上传户型图做方案」发起 → agent 产出 layout 容器或 scene 文件 → 面板自动出现（挂载即带数据）。
- **多方案切换**：面板头部下拉列出会话内全部 `design/*.scene.json`（按产出顺序）+「当前编辑」标记；切换 = 重新加载（未保存改动先确认弹层）。

### 7.2 面板布局（宽幅 ≥420px）

```
┌──────────────────────────────────────────────────────┐
│ [⌂ 俯视] [◔ 轨道] [🚶 漫游] │ 方案: 三室两厅-A ▾ │ 💾 ⤓ 📷   │  ← 工具条（视角切换 / 方案选择 / 保存 / 导出 / 快照）
├──────────────────────────────────────────────────────┤
│                                                      │
│                 3D 视口（WebGL Canvas · 懒加载）        │
│            （俯视模式 = 2D 平面编辑器，同一画布）          │
│                                                      │
├──────────────────────────────────────────────────────┤
│ [家具库 ▦] [材质 ◧] [光照 ☀] [属性 ⚙]                    │  ← 底部页签（互斥展开为右侧属性栏或浮层）
│  └ 家具: 床 / 沙发 / 桌 / 椅 / 柜 / 灯 / 绿植 …（点击置入）   │
│  └ 材质: 地板×6 / 墙面×6 / 织物×4（色板 + 应用对象选择）      │
│  └ 光照: 方位 ○───● ── 高度角 / 强度 / 色温 / 时刻推演        │
└──────────────────────────────────────────────────────┘
```

窄幅（<420px）与底抽屉（<900px 场景抽屉内）：工具条折叠为图标行；家具 / 材质 / 光照改底部横向滑动条；2D 编辑优先（3D 视口可收起）。

### 7.3 能力矩阵（七组）

| # | 能力 | 交互 | 数据回写 |
| --- | --- | --- | --- |
| 1 | 视角 | 俯视 / 轨道 / 漫游三模式切换；漫游 WASD + 拖拽（碰撞墙体制动）；视角书签（`camera` presets） | 视角状态仅本地（sessionStorage `ma:ds:view`），不入场景 JSON（除显式收藏） |
| 2 | 平面编辑 | 俯视模式绘制房间 / 调整多边形顶点 / 拖门窗口 / 墙高；栅格吸附 100mm | `rooms` / `openings`（实时重建 3D） |
| 3 | 家具 | 家具库点击 → 视口中心置入；拖拽移动（吸附 50mm）/ 旋转（15° 吸附）/ 缩放（等比）；删除（Del / 悬浮 ×） | `furniture[]` |
| 4 | 材质 | 色板点击选中 → 高亮应用目标（房间地面 / 墙面 / 家具）→ 确认应用；自定义色（取色器 + 粗糙度滑条） | `materials` + 引用字段 |
| 5 | 光照 | 日光方位 / 高度角滑条（联动双控）；「时刻推演」滑条（06:00–18:00 → 方位海拔联动）；强度 / 色温 | `lights` |
| 6 | 快照 | 📷 按钮：当前视角抓 PNG → 选项（下载 / 存入工作区 / 复制到 Composer 引用 / 送图生图回填模板）；快照元数据（视角 / 时间） | 产物文件 + 回填草稿 |
| 7 | 持久化 | 💾 保存（写回当前 scene 文件，含乐观锁：mtime 检测外部变更提示「文件已被更新，加载新版 / 覆盖」）；⤓ 导出（下载 JSON）；「另存为」（新文件名递增） | `design/*.scene.json`（§7.5 API） |

### 7.4 交互细节（与消息联动）

- **容器 → 工作台**：`::: layout` 卡「在 3D 工作台打开」→ 校验「方案源：」文件存在（`artifacts` content 接口 HEAD 探测）→ 打开并加载；文件缺失 → 按钮置灰 + tooltip「方案文件未生成：让 @规方 产出 design/*.scene.json」。
- **工作台 → 消息**：快照后「回填」动作生成 Composer 草稿模板（例：`基于刚拍的「南向客厅」快照，走图生图出效果图：参考风格 <风格>，主材 <材质>，光照 <暖/冷>；`——模板常量注册表 `lib/ds-templates.ts`，§8.3）；保存场景后「回填」：`方案已更新到 design/plan-a.scene.json（v2）：改动点 —— <用户补述>；`。
- **回填纪律**：一切回填只写 Composer（ADR 0064 / 0118 统一语义：composerInsert + sessionStorage 草稿），不生成本地消息、不直发。
- **流式冻结**（ADR 0114 口径）：工作台数据加载与 layout 卡解析走完成态快照（`useSceneMessages` 冻结口径）；进行中的效果图生成不阻塞工作台操作。
- **定位**：layout / render 卡点击 → `focusMessage` 定位来源消息（SceneCtx.focus 复用）。

### 7.5 持久化 API（新增设计）

| 端点 | 语义 | 守卫 |
| --- | --- | --- |
| `GET /api/sessions/:id/design-scenes` | 列出 `design/*.scene.json`（路径 + mtime + 大小） | 会话存在性 + 归属守卫（M57） |
| `GET /api/sessions/:id/artifacts/content`（既有） | 读取 scene JSON 内容 | 复用 `resolveSafe`（路径穿越防护已有） |
| `PUT /api/sessions/:id/design-scenes` | 保存场景：body `{ path: 'design/xxx.scene.json', data: DesignScene, ifUnmodifiedSince?: mtime }` | zod 校验 `DesignScene`（shared schema）；路径白名单前缀 `design/` + `.scene.json` 后缀；`resolveSafe` 越界拒绝；配额闸门（M57 P3 `quotas.assertUploadAllowed` 复用）；`ifUnmodifiedSince` 不符 → 409（前端弹「文件已被更新」）；写后 `notify:artifact-updated` 广播 |

设计理由：artifacts 路由现为只读（GET-only）——scene 写通道独立成资源（`design-scenes`）比泛化 artifacts PUT 更收敛（审计面小、前缀白名单硬）；canvas PUT 为先例（`server/src/routes/canvas.ts`）。

**占位布局（参数化 fallback）**：layout 容器有房间清单但无 scene 文件时，工作台「打开」降级为——按清单（房间名 + 面积）自动生成矩形排布占位场景（一次性，不落盘；横幅提示「占位布局：可手动调整或让 @规方 产出正式场景文件」）。

### 7.6 降级链与无障碍

| 触发 | 行为 |
| --- | --- |
| WebGL 不可用 | 静态快照模式（最近快照 + 2D 平面编辑保留 + 横幅说明） |
| 窄屏 <900px | 场景抽屉内置工作台（默认收起，M52-A 先例）；2D 优先视图 |
| quiet / reduced-motion | 光照推演动画禁用（滑条直切）；相机过渡禁用（直切） |
| 键盘 | 全部工具条按钮带 `aria-label` + 快捷键注册（V / O / W 视角，D 删除，⌘S 保存）；画布 `tabIndex=0` 可聚焦（聚焦后 WASD 生效，避免全局键位劫持） |
| 错误 | scene JSON 解析失败 → 中文错误卡 + 源码查看入口 + 「重置为新场景」（不覆盖原文件） |

### 7.7 打印视图（方案书 · 轻量，评审批一新增）

- **定位**：家装方案书的标准输出（平面图 + 效果图 + 风格板 + 房间清单合集）以「打印视图」承接——`window.print()` + print 样式表，浏览器直接存 PDF；**零新依赖**（不引 jspdf / 服务端渲染）。
- **入口**：工作台工具条 📄 按钮 → 打印视图预览（弹层 / 覆层）→ 「打印 / 存为 PDF」。
- **内容组合（只读，数据全部来自现有源 · 冻结口径）**：

| 页 | 内容 | 数据源 |
| --- | --- | --- |
| 封面页 | 方案名 · 生成时间 · 场景 · 精度声明 | `DesignScene.name` / 元数据 |
| 方案页 | 俯视平面图（房间名 + 面积标注）+ 房间清单 | DesignScene 缩略图派生 + layout 容器 |
| 效果页 | 快照 × N + 效果图 × N（2×2 网格） | 快照文件 + render 容器（无则整页省略） |
| 风格页 | 色卡 + 质感关键词 | 最近 styleboard 容器（无则省略） |
| 页脚（每页） | 「效果图为示意表现（材质 / 光照 / 色差以实物为准）」+ 数据精度声明 | 固定文案 |

- **打印样式**：`@media print` 隐藏应用外壳（顶栏 / 输入条 / 侧栏 / 操作钮），A4 纵向；`print-only` 组件域；quiet 模式同样输出静态页。
- **交互纪律**：只读组合（不可编辑场景数据）；空态（无快照 / 无效果图 / 无风格板）自动省略对应区块。
- **测试**：组件测（组合 / 空态 / print 类存在）；E2E 断言打印预览挂载 + print 隐藏类应用（真实打印对话框不自动化）。
- **边界**：不做跨会话聚合、不做排版编辑器、不做页眉页脚自定义（v2 评估）。

---

## 8. 设计专有 Chat 展示区

### 8.1 容器族三支（语法 + 渲染 + 资产输出约定）

对齐 M38 容器纪律（`remark-ext.ts` 统一解析 + 单一容器渲染实现 + 资产协议「渲染容器约定」段写入场景协议；mock 触发块三组）：

**`::: layout 方案名`（布局方案卡）**

```
::: layout 三室两厅 · 方案 A
- 客厅 | 22.5㎡ | 南向，沙发墙居中，主通道 1100mm
- 主卧 | 15.2㎡ | 东南，衣柜北墙通顶
- 厨房 | 6.8㎡ | U 型动线，洗切炒三角 1.2m
- 玄关 | 3.2㎡ | 收纳 2.4m 柜体，换鞋凳预留
方案源：design/plan-a.scene.json
:::
```

渲染：`LayoutCard`（房间清单表 + 面积徽标 + 「在 3D 工作台打开」主按钮 + 「方案源」文件 chip）；数据行兼容 `- 键 | 值 | 备注`（第三列可选）。解析走 `panRowsOf` 同构（data-items JSON）。

**`::: styleboard 主题名`（风格板卡）**

```
::: styleboard 原木日式 · 基调
- 主色 | #E8E0D4 | 墙面大面
- 辅色 | #A67B5B | 木作 / 地板
- 点缀 | #4A5D3A | 绿植 / 织物
- 质感 | 哑光木纹 | 低饱和 · 留白 · 暖光
:::
```

渲染：`StyleBoardCard`（色卡块一排，点击复制 HEX；「质感」行渲染为关键词 chips）；非法色值降级为文本行（fail-safe）。

**`::: render 标题`（效果图卡）**

```
::: render 客餐厅效果图 · v2
- 视角 | 南向沙发墙 45°
- 风格 | 原木日式（styleboard 同名）
- 参数 | seed 12345 · 1024×768 · 步数 28
- 来源 | design/snapshot-1731.png → design/render-2.png
:::
```

渲染：`RenderCard`（大图 + 元信息行 + 操作：放大（ZoomableImage 复用）/ 定位来源消息 / 回填「再生成一版」）；「来源」行解析 `→` 分隔的输入→产物路径（产物未就位时占位「生成中…」+ 30s 后「产物可能未完成，检查媒体面板」提示）；图片经 `artifactContentUrl` 取（M6 通道零新增）。

**容器触发约定（写入资产 · 对齐 M38 先例）**：`interior/_protocol.md` 增「渲染容器约定」段（layout / styleboard / render 各一至二条）；角色人设「工作方式」加输出约定行（成竹 → styleboard；规方 → layout；塑光 → render）；`mock.ts` 增三组触发块（「布局走查」→ interior-designer / space-planner；「风格走查」→ interior-designer；「出图走查」→ visualizer——唯一触发词、块内不写 @、与既有剧本零碰撞）。

### 8.2 消息内方案预览卡（`DesignPreviewCard`）

- **形态**：`::: layout` 卡内嵌缩略预览区（俯视 SVG 平面缩略图：由 DesignScene 房间多边形派生，非 WebGL）；**不建活 WebGL**（红线 §3.1）。
- **交互**：hover 显示房间名 tooltip；点击房间 → 高亮 + 「聚焦到工作台该房间」；卡片主按钮「在 3D 工作台打开」（加载 + 打开面板 + 视角对准）。
- **流式纪律**：容器解析走冻结快照（完成态才挂载）；缩略图派生失败（JSON 缺失）→ 只渲染清单表（降级无卡片）。

### 8.3 回填模板库（`lib/ds-templates.ts` 常量注册表）

| 模板 id | 场景 | 草稿文案骨架 |
| --- | --- | --- |
| `open-in-studio` 说明 | layout 卡 | （按钮动作非草稿：直接打开工作台） |
| `snapshot-to-render` | 工作台快照 | `基于 <快照文件> 走图生图出效果图：风格 <风格>，主材 <材质>，视角 <视角>；参数 seed 沿用 <seed>；` |
| `apply-styleboard` | styleboard 卡 | `按 <主题> 风格板调整方案：主色 <hex> 墙面、辅色 <hex> 木作；保持现有布局不动；` |
| `adjust-room` | layout 卡房间行 | `@规方 想调整 <房间>：<补述>（面积 <面积>，现布局要点 <要点>）；` |
| `regen-render` | render 卡 | `再生成一版：<变化点>（保持 <不变项>）；seed 换新 / 沿用 <seed>；` |
| `fengshui-followup` | luopan 卡宫位 | `@司南 关于 <宫位>（<盘面结论>）想进一步了解：<补述>；` |

台账：`data-*` 锚点 + 单测（模板渲染 / 回填注入 walk 既有 Composer 测试基建）。

### 8.4 与既有口径的关系（零破坏核对）

| 既有机制 | 关系 |
| --- | --- |
| 冻结快照（ADR 0114） | 新容器全部走冻结口径（容器解析面）；`studio` 面板数据同 `useSceneMessages` |
| 统一回填（ADR 0064 / 0118） | 全部新交互遵守（只写草稿） |
| 单一解析实现（ADR 0144 红线） | 容器解析只落 `remark-ext.ts` 一处 + React 侧卡片同构消费；禁并行解析实现 |
| 面板无数据不展示（M58） | `studio` 就绪判定见 §7.1（1/2 两条件） |
| 场景 parts | 不新增 parts（studio 为面板内部构成，不受 parts 裁剪）；`round-track` 等五件套零改动 |
| mock 触发词纪律 | 新增 6 组触发块（interior 3 + fengshui 3），与既有 32 组脚本零碰撞（实施时全量 grep 校验） |

---

## 9. 图片 → 效果链路（上传 → 理解 → 生成 → 迭代）

### 9.1 总工作流

```
① 上传            ② 解析（视觉）        ③ 布局（产出 JSON）     ④ 工作台微调        ⑤ 出图（图生图）        ⑥ 迭代
用户传户型图/照片 → agent 视觉理解      → write_file 落 scene → 用户 3D 调整/换材质 → media_generate        → render 卡再生成
                    结构转译清单           + ::: layout 卡         📷 快照（PNG）        image2image（输入图=     （改 prompt/seed/
                    （实测/估读/存疑）      「在 3D 工作台打开」    + 回填模板            快照或原照片）           workflow 参数）
                                                                                        ↓
                                                              产物落交付件 + 画布 image 节点 + ::: render 卡
```

- ②③ 由 `space-planner` / `visualizer` 分工：解析在规方（尺度纪律），出图在塑光（prompt 工程）；成竹统筹风格与取舍。
- 用户既可从 ① 起全链，也可从 ④ 起（直接在工作台搭空白场景——无户型图也能用：新建 + 手动绘制 + 家具 + 出图）。

### 9.2 prompt 工程纪律（写入 `3d-visualization` 技能与塑光人设）

出图 prompt 六要素框架（顺序稳定、可复现）：

| 要素 | 内容 | 例 |
| --- | --- | --- |
| 空间 | 房间类型 + 面积 + 朝向 | 18㎡ 南向客厅 |
| 视角 | 相机位与焦距感 | 45° 俯视客厅南墙视角，24mm |
| 风格 | 风格词 + 参考系 | 原木日式（muji 风），低饱和 |
| 材质 | 主材清单（与 styleboard 一致） | 浅橡木地板、米白乳胶漆、亚麻沙发 |
| 光照 | 时刻 + 氛围 | 午后侧光，暖色调，柔和阴影 |
| 负面 | 不期望项 | 深色、杂乱、过曝、畸变、文字水印 |

纪律：材质 / 色号与 `styleboard` 卡一致（不漂移）；迭代只改一到两个要素（控制变量）；`seed` 固定复现、变更记录进「出图说明」；生成参数（尺寸 / 步数 / workflow_id）随 render 卡「参数」行留痕。

### 9.3 3D 快照 → 图生图（专业亮点管线）

- **输入**：工作台快照 PNG（`design/snapshot-<ts>.png`，工作区相对路径）作为 `media_generate` 的 `images` 输入（image2image，1 张）。
- **工作流模板（连接侧）**：在「设置 → 媒体生成」的 ComfyUI 连接配置 `workflows`，推荐两类模板——① 通用图生图（低重绘幅度，风格渲染）；② ControlNet depth/canny 保结构模板（快照作为控制图 + prompt 出写真级效果图，占位符 `{{image}}` 由 M31 适配器上传替换，机制已有）。设计文档给出「连接配置建议」小节（不强制，用户自备工作流）。
- **重绘幅度倾向**：3D 快照出图建议中低 denoise（保布局结构、换质感光照）；原照片出图建议中高 denoise（改造幅度大）。
- **失败引导**：未配置连接 → 工具返回引导文案（「设置 → 媒体生成」，M31 既有）；快照文件不存在 → `media_generate` 早失败拒绝（输入素材路径校验既有）。

### 9.4 产物落位与迭代

| 落位 | 机制 |
| --- | --- |
| 交付件 | 媒体任务完成落交付件（M31 既有）；产物路径回灌消息（详情契约） |
| 画布 | `place_on_canvas`（缺省 true）→ 画布 image 节点 + 生成面板进度（M31 既有，零改动） |
| 消息流 | agent 输出 `::: render` 卡引用产物路径（§8.1）；产物未就位占位态 |
| 工作台 | 快照对照查看（工作台内「快照 ↔ 效果图」并排对照视图：左快照右产物，便于评审） |
| 迭代 | render 卡「再生成一版」回填草稿；参数变化（seed / 材质 / 风格）在「出图说明」留痕，v2 可对照 |

### 9.5 无媒体连接时的降级

> 当前环境（评审批二落档）：媒体连接**尚未配置**（用户明确「保留扩展、后续会添加」）——首发验证即走本降级路径；连接就位后自动全功能（出图入口门控解除），零代码改动。

- 出图不可用时**不阻断**：方案 / 布局 / 3D 工作台 / 快照全部可用（本地闭环）；`media_generate` 返回引导文案 → agent 转述 + 给「配置指引」；render 卡不产生（协议约定：生成失败不写 render 容器，避免空卡）。
- 选项：agent 可改用 `visual-design` 技能（HTML/CSS 视觉稿）产出**示意图板**作为替代（非写实效果图）——降级链路写入协议。
- **能力门控（ADR 0138 口径）**：出图入口（render 卡操作 / 快照「送图生图」/ 回填模板）按 `useMediaCapabilities`（`canImage` = text2image | image2image）门控——无能力时不出现（而非「禁用 + 引导」）；工作台与 2D 平面编辑不设门控（本地能力，无媒体连接亦可全量使用）。

---

## 10. 风水阳宅设计

### 10.1 `luopan_pan` 工具详设（罗盘排盘 · 第五件套）

对齐排盘四件套范式（M51-E / ADR 0111）：**纯计算只读**（无 IO / 无网络 / 无副作用）；`tier: deferred`，经 `tool_search`（「罗盘 / 风水 / 堪舆 / 阳宅」）激活；白名单仅 fengshui 全员 + metaphysics 按需（联参场景）；输出含可直接整卡复制的 `::: pan luopan` 模板；失败语义 `PanError`（结构化错误 + 建议），**禁止模型心算兜底冒充工具结果**。

**输入 schema（zod）**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `facing` | string | ✔ | 朝向：度数（`"172"` / `"172.5"`）或方位词（`"坐北朝南"` / `"坐西北向东南"`）；二者并存时以度数为准并在输出标注 |
| `quality` | enum | ✖ | 数据等级 `A`（现场罗盘/专业测量）/ `B`（手机指南针）/ `C`（口头描述，缺省）。决定输出精度声明与可用的判读深度 |
| `year` | number | ✖ | 流年（缺省当前年；用于流年飞星） |
| `declination` | number | ✖ | 磁偏角（度；仅 A 级数据建议启用，输出标注修正前后值） |
| `label` | string | ✖ | 盘面标题（如「自宅 · 三室两厅」） |

**输出（结构化文本 + 整卡模板）**：

1. **二十四山定盘**：坐山 / 朝向（各含山名 + 周天度数区间）；八方位落宫；
2. **八宅游年**：宅卦（如「坎宅」）、东/西四宅、八宫九星表（生气 / 天医 / 延年 / 伏位 / 绝命 / 五鬼 / 六煞 / 祸害 × 对应方位 + 白话一句话）；
3. **玄空飞星**：三元九运定运（当前 **九运** 2024–2043）+ 运盘九宫 + 流年九宫（入中星 + 飞布）；
4. **`::: pan luopan` 卡模板**：字段行 + 条目行（口径同 pan 四件套：字段 `键：值` → data-fields；条目 `- 键 | 值` → data-items）；
5. **精度与口径声明段**：数据等级（A/B/C）、流派口径（八宅·坐山派 / 玄空·下卦）、未启用项说明（如 C 级不做兼向判定）。

**算法域（自研纯计算，零新依赖；golden 案例锁定）**：

| 模块 | 口径 | 备注 |
| --- | --- | --- |
| 二十四山 | 每山 15°；顺时针序列（子癸丑艮寅甲卯乙辰巽巳丙午丁未坤申庚酉辛戌乾亥壬）；坐向互成 180° | 定盘基准与排盘四件套的度数体系一致（0 = 正北） |
| 八宅游年 | 以坐山定宅卦（坐山所属八卦）；东四命/西四命不涉（只论宅）；大游年歌诀推八宫九星 | **流派声明**：以坐山论宅（门向为参考，标注与「以门论宅」派差异） |
| 三元九运 | 每运 20 年；九运 = 2024–2043；一运 = 1864–1883；运星入中 | 运盘飞布（洛书轨迹：中 → 乾 → 兑 → 艮 → 离 → 坎 → 坤 → 震 → 巽，星号顺增） |
| 流年飞星 | 年入中星（公式化，golden 锁定：2024 = 三碧入中 → 2025 二黑 → 2026 一白）；入中后同轨迹飞布 | 与运盘同轨迹，输出两盘并列 |

> **勘误（M66-A 实施，2026-09-19 / ADR 0168）**：本表原示例「2025 四绿 → 2026 五黄」为笔误——正确序列为 **2024 三碧 → 2025 二黑 → 2026 一白**（年入中星公式 `((11 − 年数字和%9 − 1)%9)+1`，已入 golden 测试锁定）；工具与测试以本勘误为准。
| 兼向判定 | 山中心 ±4.5° 下卦带 / 两侧各 3° 兼向带（3+9+3 分布）；**仅 A 级启用**（B/C 输出「未判定」）；兼向仅判定与声明——替卦排盘需专业复核（本盘按下卦呈现） | ✅ 已落地（M66 续完善 / ADR 0175）：`pitchOf` 判定 + 盘卡字段行 + 工具文本；原「v1 不启用」声明升级 |

**golden 案例（3 例，锁定参考值）**：① 壬山丙向（坐 345°，B 级）→ 二十四山 / 坎宅八宅游年表；② 2026 流年飞星盘（一白入中；见上勘误）；③ 「坐北朝南」C 级口头数据 → 定盘到子山午向最近似 + 粗精度声明路径。

### 10.2 第五盘卡：`LuopanBoard`（chartboard 扩展）

> 实施修订（M66-B ✅，ADR 0171 / 2026-09-19）：派生层落为 `pan/luopan-model.ts`（卡文本 → LuopanModel，不重算）；宫位详情以**详情条**呈现（替代浮层——虚拟列表滚动下更稳定）；三环罗盘为静态 SVG（正北在上；24×15° 扇区 + 45° 八卦扇区 + 九宫格 + 坐向指针）；回填走 AskBar（「深入 / 依据核对」）。

- **注册路径**：client `PAN_KINDS` + `'luopan'`（`remark-ext.ts` 单一解析处）+ `PanKind` 映射「罗盘」徽标；`PanCard` 分派新 `LuopanBoard`；`ChartboardPanel` 的盘面卡体系自动承接（`panelReady('chartboard')` 判定 = 有 `::: pan` 容器，luopan 天然命中，零改动）。
- **盘面构成（SVG 自绘，零依赖）**：
  - 外环：二十四山 24 扇区（每 15°；四正四维十字线）；可整体旋转（拖拽 / 滑条）；
  - 中环：后天八卦八宫（八扇区）；
  - 内层：九宫格（八宅游年 or 流年飞星的星数 + 吉凶色带）；
  - 盘心：坐向摘要（坐 X 向 Y · 周天度）+ 数据等级徽标（A/B/C）+ 流派徽标（八宅·坐山派 / 玄空·下卦）。
- **交互（对齐 M54 盘面交互先例）**：
  1. **双盘 tab**：八宅游年 / 流年飞星（互斥切换，飞星 tab 增年选择）；
  2. **定盘校准**：拖拽旋转罗盘对齐「用户面朝方向」→ 回填草稿（`@司南 按坐 <X> 向 <Y> 重新排盘：`）——不直接改盘（盘面唯一事实源 = 工具输出，声明口径）；
  3. **宫位点击** → 详情浮层（星曜 / 白话释义 / 参考区间 / 流派标注 + 「未闻术语」白话注）；
  4. **档案**：存 / 回看（复用 M54 档案体系 `ma:sc:pan-archive`，`kind: luopan`）；
  5. **派生失败**（字段缺失 / 非法）→ 表格回退（M54 先例，fail-safe）。
- **合规呈现纪律（渲染层）**：吉凶色带用「参考序」表述（如辅色 → 慎用色，不用「凶」大字红底恐吓）；宫位详情统一带「传统观点 / 参考」前缀；不出现「化解」「开运」类商业化按钮。

### 10.3 九宫叠图元件（`GridOverlay` · 户型图 × 盘面）

> 实施修订（M66-B ✅，ADR 0171 / 2026-09-19）：底图 = 会话内最近图片附件（无图空态含前提声明）；SVG 网格叠加**不置格内文字**（防 `preserveAspectRatio="none"` 拉伸变形——宫位信息走 SVG `<title>`，含宫 · 方位 · 星 + 参考语）；入口 = 盘卡第三 tab（**不设独立触发块**——mock 触发块维持 2 组；文档原「叠图走查触发块」以 tab 入口替代）。

> 续完善修订（M66 续完善 ✅，ADR 0175 / 2026-09-19）：**旋转对齐已落地**——对齐滑条 0–359°（格随网格整体旋转，旋转后网格「北格」对齐图纸的北；复位 + 角度显示）；原「v1 固定正北」限制解除。

> v3 修订（M66 v3 ✅，ADR 0178 / 2026-09-19）：**自动找正已落地**——指北交互（单点：图心 → 点击方位角 → 旋转角，与滑条同一 rot 互用）+ 快照识别（`design/snapshot-*` → 「工作台快照（已按北向上）」）；像素级找北（CV/OCR）评估后不做（零依赖纪律）。

- **入口**：LuopanBoard 第三 tab「户型叠图」（消息卡与面板卡同构）。
- **数据源**：会话内最近图片附件（户型图优先序：用户显式在回填草稿中提及 `/` 最近一张图片）或 `design/snapshot-*.png`（3D 快照，设计风水联审时用）。
- **渲染**：底图（`artifactContentUrl` + `ZoomableImage` 缩放平移机制复用）+ SVG 叠加层——3×3 九宫网格（可旋转）+ 每宫星数/游年星 + 参考色带 + 方位指针（北向标记）。
- **对齐交互**：拖动 / 滑条旋转网格（对齐户型图墙体走向）→ 弹出「确认北向声明」（记录「图纸北向为图面顺时针 X°」）；与盘面坐向合成后各宫方位归属自动计算；对齐结果与声明写入点评报告的「数据与前提」节。
- **宫位交互**：点击宫位 → 详情浮层（同 §10.2-3）+ 回填（`@司南 想了解 <宫位>（<结论>）的改善参考：`）。
- **失败降级**：无可用底图 → tab 内空态引导（「上传户型图后可用」）；图片取数失败 → 只渲染网格 + 文字方位表。

### 10.4 点评输出契约（`docs/堪舆点评-<主题>.md` 六段结构）

1. **盘面**：`::: pan luopan` 整卡（工具输出原样，先盘后论）——含数据等级与流派徽标；
2. **数据与前提**：坐向数据来源与等级（A/B/C）、叠图北向声明、存疑项（不猜）、术数所用流派；
3. **分维度评述**（四维，每维「盘面依据 → 白话解读 → 参考区间」）：外局（周边环境描述性评述）· 坐向格局（门 / 主 / 灶 三要的传统口径 + 现代转译）· 动线光气水（通风 / 采光 / 动线，与现代居住科学对齐表述）· 流年参考（流年飞星落宫 + 传统参考）；
4. **改善参考**（四类：布局调整 / 采光通风 / 色彩材质 / 陈设；每条标注「依据盘面 X」+ 可执行动作 + 是否涉及结构判定——涉结构一律「需专业核实」）；
5. **联动建议**：可转 @成竹 / @规方 做设计调整（handoff 提示）；可转 @bazi 做宅运 ↔ 命理联参；
6. **精度与适用声明**（固定段）：文化研习与参考定位、数据等级限制、不承诺吉凶必应、不构成任何专业建议（结构 / 法律 / 医疗）。

### 10.5 合规与测试

| 项 | 口径 |
| --- | --- |
| 禁词扫描 | 协议 + 人设 + mock 剧本文本过禁词表（「大凶 / 血光 / 必然 / 化解费 / 破财」等）；实施方案：挂 `check:agents` 扩展断言（或独立脚本 `check:fengshui`） |
| golden 案例 | 3 例（§10.1）进 `server/tests/luopan.test.ts`（与 pan 四件套 golden 同构） |
| 盘面契约 | `::: pan luopan` 解析（PAN_KINDS 扩展）+ PanCard 分派 + 表格回退——组件测 |
| eval 34 | mock 触发块「堪舆走查」→ plan-surveyor / yangzhai-master：断言盘卡容器 + 六段结构关键词 + 合规禁词不出现 |
| 红线回归 | 「先盘后论」断言：评论文本优先于/伴随盘容器（无盘不评的协议约束由人设 + eval 语料承接） |

---

## 11. 工程实施清单（文件级 + 镜像面）

### 11.1 资产层（agents / skills / evals）

| 文件 | 动作 |
| --- | --- |
| `agents/interior/_group.yaml` | 新建（§5.1 全字段） |
| `agents/interior/_protocol.md` | 新建（六段：铁律 / 协作 / 尺度 / 容器约定 / 交付 / 边界） |
| `agents/interior/{interior-designer,space-planner,visualizer}/AGENT.md` | 新建（四段骨架 + front-matter：tools / skills / handoff / temperature） |
| `agents/fengshui/{...}` 同上 | 新建（2 角色 + 协议） |
| `agents/interior/*/avatar.png`、`agents/fengshui/*/avatar.png` | 新建（风格化 3D 卡通 v2，512px，5 张） |
| `agents/_presets.yaml` | 追加 2 预设（`home-makeover` 家装全案 / `move-in-check` 入宅联审，members 含跨场景） |
| `agents/CHANGELOG.md` | 追加 2 条（M65-A / M66-A，附 eval 结果） |
| `skills/interior-design/SKILL.md`、`skills/3d-visualization/SKILL.md`、`skills/fengshui/SKILL.md` | 新建（front-matter：name / description / tags） |
| `evals/tasks/33-interior.json`、`34-fengshui.json` | 新建（mock 场景断言） |

### 11.2 共享与前端（client / shared）

| 文件 | 动作 |
| --- | --- |
| `client/package.json` | 追加依赖：`three` / `@react-three/fiber@^8`（锁 React 18）/ `@react-three/drei@^9` |
| `client/vite.config.ts` | `manualChunks` 增 `three-stack` 分组 |
| `shared/src/types.ts` | `STAGE_PANELS` + `'studio'`；新增 `DesignScene` v1 类型 + zod schema（若 shared 未引 zod 则类型 + client/server 各自 parse 复用同一常量字段） |
| `client/src/components/scene/registry.ts` | `STAGE_PANEL_COMPONENTS` + `studio` |
| `client/src/components/scene/panel-ready.ts` | `case 'studio'`（§7.1 判定） |
| `client/src/components/scene/panels/StudioPanel.tsx` + `panels/index.ts` | 新建 + 导出 |
| `client/src/components/studio/*` | 新建：`StudioCanvas`（R3F）/ `PlanEditor`（SVG 2D）/ `FurnitureShelf` / `MaterialShelf` / `LightPanel` / `SnapshotMenu` / `design-scene-model.ts`（纯函数：解析 / 校验 / 几何 / 缩略图派生）/ `use-design-scene.ts`（加载 / 保存 / 乐观锁） |
| `client/src/components/chat/md-ext/{LayoutCard,StyleBoardCard,RenderCard}.tsx` | 新建 + `remark-ext.ts` 解析扩展（layout / styleboard / render 三段，单一解析处） |
| `client/src/components/chat/md-ext/pan/LuopanBoard.tsx`、`GridOverlay.tsx` + `pan/index.tsx` 分派 | 新建（PAN_KINDS + 'luopan'） |
| `client/src/lib/ds-templates.ts` | 新建（回填模板常量注册表） |
| `client/src/lib/artifacts.ts` 等 | 零改动（`artifactContentUrl` 复用） |
| client 本地态 | `ma:ds:view` / `ma:ds:lights` / `ma:sc:pan-archive`（kind 扩展）；quiet / reduced-motion 登记（index.css） |

### 11.3 服务端（server）

| 文件 | 动作 |
| --- | --- |
| `server/src/routes/design-scenes.ts` | 新建（GET 列表 / PUT 保存；§7.5 守卫）；`routes/index.ts` 挂载 |
| `server/src/tools/luopan.ts` | 新建（`luopan_pan`；算法自研 + 整卡模板输出 + PanError 失败语义） |
| `server/src/tools/registry.ts` | 注册工具 + tool_search 关键词（「罗盘 / 风水 / 堪舆 / 阳宅」） |
| `server/src/llm/mock.ts` | `artifactFor` 增 5 角色路径映射；触发块 6 组（设计 3：布局 / 风格 / 出图走查；风水 3：堪舆 / 户型 / 叠图走查） |
| `server/src/store/prompts.ts` | 零代码改动（`STAGE_PANELS` 共享常量联动校验）——复核 StageSchema 引用方式 |
| `server/tests/*` | `luopan.test.ts`（golden 3 例）+ `design-scenes.test.ts`（守卫 / 乐观锁 / 配额）+ m21 计数同步（场景 31 / 角色 119 / 预设 28） |

### 11.4 镜像面清单（并发批教训：资产扩张必须同步的九处）

> 依据「agents 资产扩张遗漏配套镜像面导致测试红与功能缺口」教训逐项核对：

1. `mock.ts`（artifactFor + 触发块）；2. `evals`（新任务 + baseline 无回归）；3. `check:agents` / `check:skills` 计数断言（m21 / m47 等测试内期望值 29→31 / 114→119 / 51→54 / 26→28）；4. 头像资产发现（avatar.png 命名与目录）；5. `_presets.yaml` 成员存在性校验；6. `docs/adr/README.md` 双索引；7. `design.md` 章节 + `agents/CHANGELOG.md`；8. `client` 面板注册三处（shared 常量 / registry / panel-ready）与 E2E 锚点；9. 场景 order 断言与场景下拉排序快照。

---

## 12. 测试与验收

### 12.1 分层测试矩阵

| 层 | 范围 | 用例要点 |
| --- | --- | --- |
| 单元（client） | `design-scene-model` / `ds-templates` / 缩略图派生 | schema 解析（合法 / 缺字段 / 版本不符）· 几何（多边形闭合 / 相交检测兜底）· 模板渲染与注入 · 缩略图边界（空房间 / 单点） |
| 组件（client） | StudioPanel（mock R3F Canvas 壳）· LayoutCard / StyleBoardCard / RenderCard · LuopanBoard · GridOverlay | 挂载与 data-* 锚点 · 交互回填写入 Composer（walk 既有基建）· 表格回退 · 冻结口径（流式不挂载）· 降级（WebGL 缺失横幅） |
| 单元（server） | `luopan.ts` golden ×3 · design-scenes 路径守卫 | 度数边界（359.9 / 0.1）· 方位词映射 · 数据等级分支 · `design/` 前缀与 `.scene.json` 后缀白名单 · `resolveSafe` 越界拒绝 · 乐观锁 409 |
| 契约 | `::: pan luopan` / layout / styleboard / render 解析 | remark-ext 单测（同 M38 容器测试组）· PanCard 分派 · 未知 kind 降级 |
| mock / eval | 33 / 34 | 触发词唯一性（全仓 grep 零碰撞）· 断言容器与结构关键词 · 禁词不出现 |
| E2E | `m65-studio.spec.ts` / `m66-fengshui.spec.ts` | 见 12.2 |
| 视觉冒烟 | 人工 | 工作台三视角截图 / 盘面与叠图截图（`data/*.png` 存档，临时 spec 用完即删——既有惯例） |
| 性能 | 手动 + 构建日志 | `three-stack` chunk gzip ≤ 240KB · 主包零增量 · 打开工作台至可交互 ≤ 3s（本机基线） |

### 12.2 E2E 用例清单

| 用例 | 步骤 | 断言 |
| --- | --- | --- |
| E1 工作台点亮 | 建 interior 会话 → mock 触发「布局走查」→ layout 容器出现 | dock 右区出现；`data-studio` 锚点；方案下拉含 `plan-*.scene.json` |
| E2 卡片打开 | 点击 layout 卡「在 3D 工作台打开」 | 面板激活 + 场景加载标记（`data-scene-loaded`）+ 无控制台错误 |
| E3 2D 编辑 | 俯视模式拖拽顶点 / 增家具 | 家具计数徽标 +1；保存按钮变「未保存」态；保存后提示成功 |
| E4 快照回填 | 📷 → 回填 | Composer 草稿含模板骨架；无直发消息 |
| E5 降级 | 强制 WebGL 失败（stub）→ 打开 | 静态快照横幅出现；2D 编辑仍可用 |
| F1 盘卡渲染 | fengshui 会话 mock「堪舆走查」 | `[data-pan-kind=luopan]`；二十四山徽标；双盘 tab 切换 |
| F2 宫位交互 | 点击宫位 | 详情浮层含「参考」前缀文案；回填草稿 |
| F3 叠图 | 上传户型图 + 打开叠图 tab | 网格 SVG 出现；旋转滑条可用；无底图时空态引导 |
| F4 合规 | 遍历盘卡文案 | 禁词表零命中；「传统观点 / 参考」前缀存在 |

### 12.3 验收清单（合并 §1.3）

- [ ] 31 场景 / 119 角色 / 54 技能 / 28 预设：`check:agents` + `check:skills` 通过；
- [ ] 四包 typecheck / lint / 双端 vitest / build 全绿；
- [ ] eval 34/34（33、34 新增 + 既有零回归）；
- [ ] E2E 新增两 spec 全绿 + 既有 spec 零回归；
- [ ] `three-stack` chunk 预算内、主包零增量（构建日志核对）；
- [ ] 窄屏（<900px）/ quiet / reduced-motion / WebGL 缺失四条降级链人工核验；
- [ ] 风水合规：协议 / 人设 / mock / 盘卡渲染四层禁词扫描零命中。

---

## 13. 分期计划与依赖

### 13.1 批次明细

| 批次 | 内容 | 依赖 | 编号落位（预定） |
| --- | --- | --- | --- |
| **M65-A** 设计资产 | interior 场景（_group / _protocol）+ 3 角色（四段骨架 + 头像）+ 技能 2 + 预设 1 + mock 3 组触发块 + eval 33 + CHANGELOG | 无 | ADR 0154 / design.md §98 / CHANGELOG v75 / eval 33（✅ 已实施） |
| **M65-B0** 接装验证（PoC） | three + R3F v8 + drei 版本矩阵验证（React 18 / Vite 5 / vitest / Playwright 冒烟）；`three-stack` chunk 实测；Canvas 挂载 / 卸载 / demand 帧 | 无（可与 A 并行） | 不落 ADR（验证纪要进 §13.3；✅ 已实施） |
| **M65-B** 3D 基座 | `studio` 面板注册（shared / registry / panel-ready）+ DesignScene schema + 2D 平面编辑 + 3D 渲染 + 家具 / 材质 / 光照 + 快照 + design-scenes API（GET/PUT）+ 组件测 | A（stage 声明）/ B0 | ADR 0159 / design.md §100（预定）/ CHANGELOG v77（✅ 已实施；范围修订见 §7 注记） |
| **M65-C** 交互链路 | layout / styleboard / render 容器族 + 方案预览卡 + 图生图联动（快照 → image2image 回填模板）+ 画布回填 + **方案书打印视图（§7.7）** + E2E `m65-studio` | B | ADR 0167 / design.md §101 / CHANGELOG v82（✅ 已实施） |
| **M66-A** 风水资产 | fengshui 场景 + 2 角色 + 技能 1 + 预设 1 + `luopan_pan` 工具（算法 + golden 3 例）+ mock 3 组 + eval 34 + 禁词扫描 | 无（与 M65 并行） | ADR 0168 / design.md §102 / CHANGELOG v83 / eval 34（✅ 已实施；触发块 2 组，叠图走查随 M66-B） |
| **M66-B** 盘面与叠图 | `pan luopan` 第五盘卡（LuopanBoard 双盘 + 宫位详情条 + 回填）+ 九宫叠图 GridOverlay（tab 入口；v1 固定正北）+ E2E `m66-fengshui` | M66-A | ADR 0171 / design.md §103 / CHANGELOG v85（✅ 已实施——**专项全部完成**） |

### 13.2 实施顺序建议

```
M65-A ──────────────► M65-B ──► M65-C ──►（联审走查：interior ✕ fengshui 跨场景预设实测）
M65-B0 ──►（版本矩阵结论回填 §13.3）
M66-A ─────────────────────────► M66-B
```

- **B0 先行**：three 栈版本兼容是最大工程不确定性——先在独立分支（或临时目录）做最小接装（Canvas + 一个立方体 + lazy chunk 实测），拿到 chunk 实重与版本矩阵结论再正式写注册与编辑器；若 drei 某组件与 Vite 5 有构建坑，退「drei 子集 + 自写 OrbitControls」方案（§15.2）。
- **M65 与 M66 可并行**（资产零交叉、工具独立）；联审在两者收口后跑一次跨场景预设（`move-in-check`）实测。
- 每个批次收口按既有纪律：四包全绿 + eval 无回归 + CHANGELOG 登记 + ADR/design.md/README 索引四处对齐。

### 13.3 B0 验证清单（落笔前置）

| 项 | 验证点 | 通过标准 |
| --- | --- | --- |
| 版本矩阵 | `three@^0.17x` × `@react-three/fiber@^8.17` × `@react-three/drei@^9` × React 18.3 × Vite 5.4 | `pnpm/npm i` 无 peer 冲突；dev/build 无警告性报错 |
| chunk 实重 | `three-stack` gzip | ≤ 240KB（超标则砍 drei 子集 → 自写件） |
| 生命周期 | React.lazy 挂载 / 卸载 ×20 次 | 无 WebGL 上下文泄漏（`WEBGL_lose_context` 计数核验） |
| 帧循环 | `frameloop='demand'` 静止 | `requestAnimationFrame` 归零（Performance 面板核验） |
| 测试环境 | vitest（jsdom）mock Canvas + Playwright（Chromium SwiftShader） | 组件测不报 WebGL 缺失；E2E 可挂载并交互 |

> **B0 实测纪要（2026-09-19 实施，全部通过）**：
> - **版本矩阵**：`three@0.175.0` · `@react-three/fiber@8.18.0` · `@react-three/drei@9.122.0` · `@types/three@0.175.0`（React 18.3.1 / Vite 5.4.21）——安装零 peer 冲突（drei 9.122 peer：R3F ^8 / react ^18 / three >=0.137）；
> - **chunk 实重**：`three-stack` = 855.10 kB raw / **230.82 kB gzip**（预算 240KB，余量 ~9KB）；懒加载链验证：`StudioCanvas` 独立 chunk 1.69 kB（gzip 0.66）、边界探针 0.32 kB——首屏入口零增量；
> - **测试环境**：vitest/jsdom 3 例全绿（three 核心可加载与构造 / Suspense 骨架 → 挂载 / 卸载重挂载 ×3）——渲染层 mock Canvas 策略成立；
> - **安装注意**：drei 传递依赖 `three-mesh-bvh@0.7.8` 有弃用警告（未启用 Bvh 组件，暂不 override；M65-B 若引入相关组件需升级 0.8.0）；
> - **余量提示**：230.82KB 为「OrbitControls + Grid」导入面；M65-B 引入更多 drei 件（ContactShadows / Html 等）需回测，超预算则砍 drei 子集自写（预案 §14.3-2）；
> - **并发注记**：测量期主入口处于外部批次中间态（`console/MaterialsConsole` 未落盘），经独立临时构建配置完成测量（不接触对方文件）；全量 tsc/build 待外部收口后复验。

---

## 14. 评估

### 14.1 可行性

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| 技术可行 | ✅ 高 | three.js / R3F 是成熟栈（React 18 兼容线明确）；平面编辑与盘面自绘 SVG 为零新依赖；快照 → 图生图完全复用 M31 已有管线（image2image + workflow_id + 异步回执 + 画布落位） |
| 工程可行 | ✅ 高 | 四形态 / 面板注册 / 容器解析 / 冻结口径 / 回填纪律 / 媒体门控全部有既有先例可循（M52 / M38 / M54 / M31）；新增面收敛为「1 面板 + 3 容器 + 1 工具 + 1 轻 API」 |
| 资产可行 | ✅ 高 | agents 包目录零代码扩张机制成熟（M15：建目录即生效）；四段骨架 / 协议 / 预设 / 技能模板齐备 |
| 合规可行 | ✅ 中高 | 命理占星红线圈定策略（ADR 0111）为直接先例；房地方向新增「精度边界声明」与流派口径两项，需评审确认措辞 |
| 依赖风险 | ⚠️ 中 | 3D 栈版本矩阵（B0 前置化解）；媒体连接依赖用户配置（设计有降级链） |

### 14.2 工作量估算（相对量级 · 按批次窗口）

| 批次 | 复杂度 | 关键量 | 说明 |
| --- | --- | --- | --- |
| M65-A | **中** | 8 文件（2 场景资产 + 6 角色文件）+ 2 技能 + 1 预设 + mock/eval | 与 M51-C/D 资产批同量级 |
| M65-B0 | **小** | 验证脚本 + 纪要 | 半天级 |
| M65-B | **大** | 面板注册 4 处 + studio 组件 ~8 个 + schema/纯函数 + API 路由 + 组件测 | 本专项最大批次；编辑器收敛是控量关键 |
| M65-C | **中**（+打印视图小项） | 3 容器（解析 + 卡 + 测试）+ 预览卡 + 模板库 + 打印视图 + E2E | 与 M38 容器批同量级；打印视图为组合式只读页，量小 |
| M66-A | **中** | 4 文件（场景 + 2 角色）+ 工具（算法 4 模块）+ golden + eval | 与排盘四件套单件同量级 |
| M66-B | **中** | 盘卡（双盘 + 叠图 + 浮层）+ 档案扩展 + E2E | 与 M54 盘卡增强同量级 |

总量级：**3 中 + 1 大 + 2 小 ≈ 五个批次窗口**（含联审走查）。收益密度最高的切入点是 M65-A（资产先行，会话可用）+ M66-A（工具先行，盘面可验）。

### 14.3 风险表

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| 1 | 3D 栈版本矩阵坑（R3F v9 需 React 19；drei 子件构建问题） | M65-B 阻塞 | B0 前置验证（§13.3）；预案：drei 子集 → 自写 OrbitControls / Grid |
| 2 | 包体失控（three 栈超预算） | 性能红线破 | 独立 chunk + gzip 门（240KB）+ 超标砍件预案；主包零增量单独核对 |
| 3 | 3D 编辑器复杂度蔓延（用户期待 CAD 级） | 工期膨胀 | v1 能力矩阵封闭（§7.3 七组）；CAD / 施工图明确范围外（§2）；占位布局 / 封闭家具族控面 |
| 4 | WebGL 环境差异（低端设备帧率 / 测试环境） | 体验与测试红 | demand 帧 + dpr 锁 + 面板卸载暂停；SwiftShader E2E；逻辑层与渲染层测试分离 |
| 5 | 图生图依赖用户媒体连接 | 出图链路不可用 | 不阻断设计闭环（降级 §9.5）；visual-design 技能图板替代；连接引导文案既有 |
| 6 | 风水合规争议（用户期待「吉凶化解」） | 品牌与合规风险 | 协议红线 + 禁词扫描 + 四类改善建议替代「化解」话术；争议以「参考」口径出口 |
| 7 | 模型漏写容器约定（layout / render 不出现） | 卡片与面板点亮失败 | 协议 + mock 触发 + eval 断言；前端 fail-safe（无容器即清单降级 / 面板不亮——M58 既有语义） |
| 8 | 触发词碰撞 / mock 剧本耦合 | eval 假红 | 唯一触发词 + 全仓 grep 零碰撞校验（既有纪律 v72 先例） |
| 9 | 编号并发冲突（pk-game 批二等） | 索引混乱 | 让位协议（先落盘先保持）+ 实施前全仓复核（§15.1） |
| 10 | 场景 JSON schema 演进（v2 GLB / 新家具族） | 兼容性 | `version` 字段 + 未知版本只读 + migration 步骤预留 |

### 14.4 收益

| 维度 | 收益 |
| --- | --- |
| 能力面 | 从 0 到 1：项目首个 WebGL 3D 能力 + 首个「空间设计」场景；设计域从「文档方案」升级为「可见可改的 3D 方案 + 效果图」 |
| 链路闭环 | 「上传图片 → 布局 JSON → 3D 微调 → 快照 → 图生图 → 迭代」端到端闭环，直接回应用户核心诉求（图片 → 效果） |
| 文化门类 | 堪舆（风水）独立成场景：术数体系「论命（metaphysics）/ 论运（astrology）/ 论宅（fengshui）」三足完备；合规策略扩为「红线 + 精度边界」双轨 |
| 框架资产 | `studio` 面板框架 + `DesignScene` 契约 + WebGL 懒加载范式可复用于未来 3D 需求（gamedesign 场景资产预览等——本专项不做，留作扩展点） |
| 生态复用 | `3d-visualization` 技能与回填模板库可被 housing（装修）复用（设计 → 施工交底的可视化衔接） |

### 14.5 评审决策记录（2026-09-19 批一）

| # | 问题 | 决策 |
| --- | --- | --- |
| 1 | GLB / 外部 3D 模型导入 | **v1 不做**（默认确认；触发条件 = 用户明确要求或 v2 需求评估） |
| 2 | 「3D 设计师」定位边界 | **锁定空间设计（家装）**；`DesignScene` 基座按「空间」抽象，商业 / 景观为自然扩展路径；产品 / 游戏 3D 资产（外部 text-to-3D 服务）另立专项 |
| 3 | 择日 / 日课 | **v1 不做**（fengshui 专注格局点评，「对房不对命」）；v2 评估 `zeri_pan` 第六件套 |
| 4 | 两场景独立 vs 合并 | **独立两场景**（`stage.panel` 单值约束：studio 与 chartboard 不可同场景共存；协议红线不同；跨场景预设承接联审） |
| 5 | 方案书 / PDF 导出 | **v1 轻量打印视图**（§7.7；零新依赖，浏览器存 PDF）；完整 PDF 管道不做（§15.2） |
| 6 | 媒体连接现状（ComfyUI 等） | **当前未配置**（保留扩展、后续添加）——§9 首发验证走降级链路（§9.5：visual-design 图板替代 + 出图入口门控隐藏）；连接就位后自动全功能 |

> 决策登记后相关章节已同步：§1.3（验收增方案书行）/ §6.6（导出表增打印视图）/ §7.7（新增）/ §13.1（M65-C 附加）/ §14.2（工作量注记）/ §15.2（完整 PDF 否决记录）。

---

## 15. 附录

### 15.1 编号核对清单（口径同 scene-expansion §10.2，动手前逐批复核）

1. **全仓实测**（落笔前一刻，不预估）：`ls docs/adr/ | tail`（ADR 最新）· `grep -n "^## " design.md | tail`（章节最新）· `head agents/CHANGELOG.md`（版本最新）· `ls evals/tasks/ | tail`（任务号最新）· grep 源码注释 `M6x`（里程碑占用）；
2. **互斥区间**（2026-09-19 开工实测）：M65 / M66 当前无占用（M63 = metaphysics 深化 / M64 = pk-game 批二预告）；本专项自 ADR 0154 / §98 / v74 起。并发方（metaphysics 深化预告 §94+ / ADR 0148+ / v74+，其实施前将全仓重核）按「先落盘先保持、后落盘顺延」处置——若其先落盘占号，本专项整体顺延并回写本文头部；
3. **四处对齐**：ADR 文件标题行 ↔ `docs/adr/README.md` 双索引 ↔ design.md 章节 ↔ 正文「见 ADR xx / §xx」引用；
4. **让位回写**：实施收口后按既有惯例回写各设计文档头部让位段（本方 / 已占方 / 顺延方三方互相同步）；
5. **备份**：动手前 `data/m65-backup-<date>/` 目录快照（无 Git）。

### 15.2 备选方案与否决记录

| 议题 | 采纳 | 否决与理由 |
| --- | --- | --- |
| 3D 引擎 | three.js + R3F + drei | Babylon（体量）；model-viewer（只读）；纯 three 无 R3F（维护成本）（§6.1） |
| 工作区形态 | dock + studio 面板（第 7 类面板） | 新增第 5 形态 `studio`（全宽 3D 舞台）：形态框架改动大（stage 注册 / 降级链 / E2E 全链）+ 与「左对话右工作台」的既有心智冲突；dock 可拖宽已满足（M59/M60 已有宽度机制） |
| 消息内 3D 预览 | 预渲染快照 + SVG 平面缩略图 | 消息流内活 WebGL 迷你视口：虚拟列表多实例上下文（浏览器上限 8–16）+ 流式渲染开销 + 滚动卡顿风险，违背 §3.1 红线 |
| 家具来源 | 程序化几何族（封闭枚举） | 初始加载 GLB 资产库：包体 / 网络 / 版权三重负担；v2 再评估用户自备 GLB |
| 场景持久化 | 独立 `design-scenes` API（前缀白名单） | 泛化 artifacts 写通道（审计面大）；纯 localStorage（不可协作 / 不可交付）；附件通道复用（语义污染 uploads/） |
| 风水工具 | 自研纯计算（`luopan_pan`） | 引入第三方风水库（无成熟维护者 + 不可验精度）；模型心算（违反先盘后论红线） |
| 风水归属 | 独立 fengshui 场景 | 并入 metaphysics（7 角色已满 + 定位「论命」与「论宅」协议红线不同）；并入 interior（堪舆独立于设计的专业价值被稀释，且两个新场景协作面被压扁） |
| 平面编辑载体 | SVG 自绘（俯视） | 引入 konva / fabric（新依赖；项目已有自绘 SVG 先例胜任矩形 / 多边形编辑量级） |
| 方案书输出 | v1 轻量打印视图（浏览器打印，§7.7） | 完整 PDF 管道（jspdf 新依赖 / 服务端渲染重；格式定制面大）；跨会话聚合方案书（v2 评估） |
| 设计场景命名 | `interior`（家装设计工作室） | `design`（太泛，与「设计域」概念撞）；`home-design`（与 home 场景命名近，易混） |

### 15.3 关键名词表

| 名词 | 口径 |
| --- | --- |
| `DesignScene` | 家装 3D 场景 JSON（v1）：房间 / 洞口 / 家具 / 材质 / 光照（§6.3），工作区 `design/*.scene.json` |
| `studio` 面板 | 第 7 类 StagePanel：3D 工作台（§7），interior 场景 stage 声明消费 |
| `layout` / `styleboard` / `render` | 设计容器族三支：布局方案卡 / 风格板卡 / 效果图卡（§8.1） |
| `luopan_pan` | 罗盘排盘工具：二十四山 / 八宅游年 / 玄空流年（§10.1） |
| `LuopanBoard` | `::: pan luopan` 盘面卡渲染器（SVG 罗盘 + 双盘 tab + 宫位交互，§10.2） |
| `GridOverlay` | 户型图九宫叠图元件（§10.3） |
| A/B/C 数据等级 | 坐向数据分级（现场测量 / 手机指南针 / 口头描述），决定精度声明（§5.2 / §10.1） |
