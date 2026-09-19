# ADR 0128：席位环几何修正与议程清单化——头像精确落位 · 桌面坐沿 · 顶区左右平衡

- 状态：Accepted
- 引入：M52-H
- 相关：[design.md §80](../design.md)、ADR 0112（场景工作区体系）、[client/src/components/scene/parts/SeatRing.tsx](../../client/src/components/scene/parts/SeatRing.tsx)、[client/src/components/scene/parts/AgendaTrack.tsx](../../client/src/components/scene/parts/AgendaTrack.tsx)、[client/src/components/scene/RoundtableStage.tsx](../../client/src/components/scene/RoundtableStage.tsx)、[client/src/index.css](../../client/src/index.css)

## 背景

- 用户实测截图（社会议题研讨 roundtable·pool）反馈顶部区域「效果有问题」；浏览器实测测量确认四项缺陷：
  - ① **名字与圆交叉不对称**：顶席「尚真」标签深入虚线圆内 14.3px（弧线穿过文字）、左右席「齐观 / 方衡」临界相切（47.4 vs r=47，差 0.4px）、底席「允中」却在圆外 18px；
  - ② **视觉偏心**：座位盒由「头像 + 名字」整体居中定位，头像视觉中心比环心高 8.3px——几何正圆（4 席半径精确 56）却视觉偏心，虚线圆穿左 / 右 / 下三个头像；
  - ③ **底席名字溢出**：`scene-rt-top` 高度不承接名字外溢，「允中」下沿超出条带边界 2.1px 被下方消息区覆盖；
  - ④ **顶区失衡**：宽屏（1600）右侧 322px 全空（约 34% 宽度）；议程条仅 23.6px 单行，与 148px 席位环体量失衡。

## 决策

1. **头像精确落位**：座位盒 = 头像盒（`width 64 / height 30`），名字改绝对定位（不参与盒居中）——盒中心 = transform 落位点 = 头像中心；参数 `RING_SIZE 152 / RING_RADIUS 54 / 头像 30`（回归测量 4 席半径 54±0.05、角度精确 0°/90°/180°/270°）。
2. **桌面语义修正**：虚线圆环改**实心圆面**（`inset 38px`，半径 38 与头像内缘 39 相切）——头像「坐在桌沿」、不再被弧线穿切；名字带底色（`hsl(var(--background))`）不与圆面交叉。
3. **名字外溢承接**：名字绝对定位在头像下方 2px；底席固定外溢约 13px 由 `.scene-rt-top` 的 `padding-bottom`（0.9rem）承接——不再被下方消息区覆盖。
4. **议程清单化**：`AgendaTrack` 由单行 chips（含 12px 连接线）改**纵向清单**——与席位环等高并排、撑满余宽：每步「状态点 + 标签 + 状态字（已完成 / 进行中 / 待办）」；状态点由竖向轨道线串联（`:first-child / :last-child` 端点收束于首末点、`:only-child` 隐藏）；长标签单行省略。
5. **顶区布局**：`.scene-rt-top` `align-items: center → stretch`（议程板与环同高、内部自居中）、`gap 1.1rem → 1rem`、`padding-bottom 0.2rem → 0.9rem`；窄屏（column）沿用。

## 理由

- **几何对位（座位盒 = 头像盒）**：环成为精确的数学圆——任意人数 / 任意角度均对称，落位不再依赖内容高度；
- **桌面实心 + 坐沿相切**：圆桌隐喻完整（桌面在环内、人坐桌沿）；较虚线环线消除「穿字 / 穿头像」两类交叉噪声；
- **名字带底色**：名字跨桌面 / 空白两种背景时仍稳定可读（无需按角度分侧布局）；
- **议程纵向清单与环等高并排**：顶部由「一个孤立小圆 + 一行小字」升级为「圆桌 + 议程板」两块等高内容；宽屏余宽由议程行撑满（状态字两端对齐），信息量提升（每步状态可读）而垂直高度仅 +15px（159 → 174.4）；
- **零语义改动**：类名 / DOM 语义（`.scene-seat-ring` / `.scene-sr-*` / `.scene-ag-*` / `[data-ag-heading]` / role）与交互（onSelect 回填 @ / onPick 回填定位）全部不变——测试面零改动。

## 被否决的方案

- **虚线圆缩半径避开名字**：几何上不可行——名字在头像下方必然落在圆内 / 切线上，缩到不交叉需直径 < 62px（桌面过小、脱离头像）；
- **名字只 hover 显示**：环上静态信息缺失（name 可见性为既有断言面），成员识别成本升高；
- **名字按角度朝外 / 分侧布局**：按角度镜像文字引入复杂度，且左右席位仍会临界相切；
- **议程保持单行 chips + 顶区整体居中**：宽屏 322px 留白仍在，「小圆 + 一行字」比例失衡不解决；
- **议程改 4 列卡片 grid**：行高 30px 仍矮于环（152），卡片化加重视觉重量且每行信息量低于纵向清单；
- **横向 wrap 保留（仅删连接线）**：横向布局不改则宽屏留白与体量失衡不解决。

## 适用与失效条件

- 适用：roundtable 形态顶区（society / brainstorm / research / strategy 四场景 + 未来 roundtable 场景）；窄屏渠道（SeatStrip + 纵向清单一列）同构；
- 失效条件：席位环引入「按立场方着色」等场景专属细化（`docs/scene-expansion-design.md §7.5` society 口径）时，颜色语义层与几何层须分层（几何不动、色层扩展）；席位数量大幅增加（> 8）时 `RING_RADIUS` / 头像尺寸需重估；
- 已知边界：底席名字外溢由顶区 padding 承接（顶区高度 174.4px）；`.scene-sr-seat` 宽 64px 超出环容器左右各 10px（点击区无重叠，席位中心间距 108px > 64px）。
