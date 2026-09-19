# ADR 0051：浏览器多标签页感知与激活页跟随

- 状态：Accepted
- 引入：M22（诊断修复批补强）
- 相关：[design.md §35](../design.md)、ADR 42（连接中心与 CDP 浏览器接入）、ADR 43（操作直播窗双视图）、ADR 11（SSE + WS 双通道）

## 背景

- 会话启动时 `Target.attachToPage` 选定一个 page target 后**固定不变**：用户在页内点击 `target=_blank` 链接、`window.open` 弹出新标签页、或 Ctrl+T 新开页时，浏览器面板仍停留在旧页——帧流不更新、URL 栏不刷新、控制台采集不到新页日志、Agent 后续操作（click / fill / snapshot）全部打向旧页。实测场景：从百度页点击链接打开视频站新 tab，面板画面与地址始终是百度页。
- CDP 事实约束：
  1. **不存在「查询当前激活 tab」的 API**（`Target.getTargets` 只给静态清单，无 focus/active 字段）；
  2. flat 模式下 `Target.attachToTarget({ flatten: true })` 一次只对应一个 page session，切换 = detach 旧 + attach 新；
  3. 页面级事件（screencast / console / navigated…）在 flat 模式携带 `sessionId`，可精确归因到所属页面；
  4. browser 级事件（`Target.targetCreated / targetDestroyed / targetInfoChanged`）在一次订阅后广播所有页面生命周期，`targetInfo.openerId` 给出 window.open / 新标签页的父子链。

## 决策

**总原则：感知所有页面，深度管理一个页面（跟随激活页的近似）。**

1. **感知层（browser 级）**：启动时先订阅 `Target.targetCreated / targetDestroyed / targetInfoChanged`，再发 `Target.setDiscoverTargets({ discover: true })`（先订阅后开启，避免漏事件；发现不可用时仅失去多标签页跟随，降级不致命）。维护 `knownPages` 清单（含未管理页，用于跟随判定与回退）。启动基线复用 `Target.getTargets` 一次拉全量。
2. **跟随规则（事件驱动，按序判定）**：
   - 非 page target → 忽略；
   - 当前管理页自身 → 忽略（地址变化走 `targetInfoChanged` 同步 `currentUrl`）；
   - 无管理页（全部关闭后新开）→ 接管任意新页；
   - 空白页（`about:blank / about:newtab / about:home / chrome://newtab/`）→ 记入 `blankPages` **观察**，待 `targetInfoChanged` 出现真实地址后跟随（Ctrl+T 不抢画面）；
   - 内部页（`devtools: / chrome: / chrome-extension: / chrome-untrusted: / edge: / view-source:`）→ 忽略；
   - `openerId === 当前管理页` → 立即跟随（用户点击链接新开的 tab，主场景）；
   - 其余非空白新页 → 跟随（外部打开进同一实例的页面也纳入管理）。
3. **切换语义 `doSwitch`**：停旧采集（`Page.stopScreencast`）→ `Target.detachFromTarget` 旧 session → `Target.attachToTarget` 新页 → 重开 `Page / Runtime / Log .enable` + Emulation 覆盖 → **清空控制台缓冲**（新页上下文）→ `location.href` 求值校正 `currentUrl` → 重开 `Page.startScreencast` → 记录 `switch_page` 步骤（from / to / 原因）；失败时清空 `pageTargetId` 让后续新页可重新接管。
4. **时序安全（busy + settle 状态机）**：切换**只在动作边界发生**——事件到达时仅登记 `pendingSwitch`；`runExclusive`（工具动作）与 `evaluateRaw`（评估入口）先 `settlePages()`（等待进行中的切换 / 空闲时清结待切换）；动作执行期间 `busy=true` 不抢占，保证一个动作的目标页前后一致；`finally` 后在途切换继续清结。
5. **关闭回退**：当前管理页被关闭 → 回退到 `knownPages` 中剩余页（插入序最后，近似「最近打开」）；无剩余 → `currentUrl` 置空 + `page_closed` 步骤（浏览器无可用标签页）；此后新页出现即重新接管。
6. **事件隔离**：`CdpClient` 事件 handler 透传 `sessionId`；`BrowserSession` 对页面级事件（screencast / frameNavigated / consoleAPICalled / exceptionThrown / Log.entryAdded）与 `waitEvent` 统一过滤「`sessionId` 存在且 ≠ 当前 page session」——旧页 detach 后残留事件不污染新页；browser 级与无归属事件放行（兼容部分 CDP 变体与单测）。
7. **前端零改动**：URL 栏取值 `frame?.url ?? session?.currentUrl` 天然联动；步骤时间轴原样渲染 `action`（`switch_page` / `page_closed` 与既有 `navigate` / `click` 同列），`runtime.onStep` 已把切换同步进操作流（`browser.switch_page`）。

## 理由

- **事件驱动而非轮询**：`setDiscoverTargets` 提供创建 / 关闭 / 元数据变化的即时推送；轮询 `Target.getTargets` 既慢又无法感知「空白页 → 真实地址」的中间态；启动时的一次 `getTargets` 只作基线。
- **opener 链 + 空白页观察近似「激活页」**：CDP 无激活查询，但用户主动产生的新页面 95% 走两条路径——点击链接（opener 链）与 Ctrl+T 后导航（空白页变化）；两条路径都有事件信号，近似成本最低。
- **单一管理页而非多页合成**：帧流 / 控制台 / 操作目标都绑定唯一 page session，语义简单、资源占用恒定（单路 screencast）；多页合成没有真实 UI 价值且编码成本随标签数线性增长。
- **动作边界切换**：Agent 一次动作（如 fill + submit）必须落在同一页面上下文；在动作中途切换会造成「输入到一半目标页变了」的错乱——`busy / settle` 状态机把切换约束在边界，代价是切换可能延迟到当前动作结束（毫秒级，可接受）。
- **sessionId 过滤优于重建订阅**：切换后不重订阅事件（CdpClient 的 `on` 是全局方法级订阅），仅按 sessionId 过滤——实现更稳、重连语义不变。

## 被否决的方案

- **所有 tab 全部 attach 并合成帧流**：N 路 screencast 编码开销大、无消费场景（面板只展示一页）——否决；
- **轮询 `Target.getTargets` 全量 diff 判定变化**：延迟高（依赖轮询周期）、无法捕捉「空白页导航到真实地址」的即时信号、额外流量——否决（仅保留启动基线）；
- **每次工具调用前强制全量刷新 target 清单**：同上，且 opener 链信息只在事件里（`targetInfo.openerId`），全量清单无法还原「这个新页是谁打开的」——否决；
- **监听 `Page.frameNavigated` 判定主帧跳转来切换管理页**：该事件仍来自当前 attach 的 session，帮不了「发现新页」；且子帧导航会误触发——否决；
- **切换时重建 CdpClient 或重新连 WS**：破坏既有事件订阅、帧流与命令管道，代价远大于 `detach + attach` 两命令——否决。

## 适用与失效条件

- 适用：managed / local / remote 全部 CDP 后端；Chrome 与 Chromium 系（含 Edge 的内部页前缀）。专用 profile（managed / local）下感知到的页面全部来自本会话，跟随语义最纯粹。
- 边界与失效：
  - **人工手动切换 tab 无法感知**（CDP 无激活 API）：用户在多个已开标签间点选不会触发跟随——后续若 CDP 暴露 `targetInfo.active` 或可用 `Browser.getWindowForTarget` + 焦点事件推断，可升级为真实激活页跟随；
  - **remote 共享实例**：其他客户端打开的页面（opener 链不匹配的「其余非空白新页」）也会被接管——接入他人日常 Chrome 时属预期外行为，建议 remote 仅用于专用实例；
  - 切换瞬间旧页帧被 session 过滤丢弃（无过渡画面），面板从新页首帧接续；
  - 空白页长期停留（用户只开着 about:blank）不接管——直到其真实导航或关闭。
