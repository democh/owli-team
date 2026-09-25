# ADR 0206：表情选择器与内置数据集——Unicode 原生 · 零 CDN · 库内索引

- 状态：Accepted
- 引入：M80-A（2026-09-22）
- 相关：[shared/src/emoji-data.ts](../../shared/src/emoji-data.ts)、[client/src/components/chat/EmojiPicker.tsx](../../client/src/components/chat/EmojiPicker.tsx)、[client/src/components/chat/Composer.tsx](../../client/src/components/chat/Composer.tsx)、[client/tests/m80-emoji.test.ts](../../client/tests/m80-emoji.test.ts)

## 背景

消息侧此前无任何表情能力（只能手打系统输入法）；头像已支持 emoji（`UserAvatar.kind='emoji'`），消息侧断层明显。选型要同时满足三个约束：① 本地优先纪律——离线可用、零 CDN、零图片资源；② Markdown 管线零改动——不引入双轨渲染；③ 检索可用——中文用户要能按中文名 / 拼音快速找到。

## 决策

1. **Unicode 原生 emoji + 系统字体渲染**：插入即纯文本字符，无短代码（`:smile:`）体系；Markdown 管线零改动。
2. **内置精选数据集**（`shared/src/emoji-data.ts`，纯数据零依赖可 tree-shake）：直达网格「常用 48」（按全球使用频次排序）+ 全量 8 分类共 **348 字符**（笑脸与情感 / 人物与手势 / 动物与自然 / 美食饮品 / 活动与运动 / 旅行与地点 / 物品与符号 / 爱心与情感符号）；每条带中文名 + 中英 / 拼音关键词搜索索引，客户端内存索引（`searchEmoji`，≤50 条）零服务端往返。
3. **选择器形态**：Composer 工具条表情入口；320×360 面板（搜索框 + 分类 tab + 网格）；键盘 ↑↓←→ / Enter 插入 / Esc 关闭；与 `@` 候选面板互斥（同层 popover 单例，一次只开一个）。
4. **最近使用**：`localStorage` 每端 24 槽——纯本地偏好，不落库、不同步（多端各自习惯）。
5. **形态校验 `isEmojiLike` 入库为共享函数**（服务端 reactions 复用）：字符在库内直接放行；库外序列按码点白名单宽松放行（Extended_Pictographic / ZWJ / VS16 / 键帽 / 肤色修饰符 / 区域指示符）且 ≤6 码点——肤色变体等合法序列不被误杀，超长滥用被拒。
6. **肤色变体 v1 不做**（仅手势默认黄皮），数据结构预留 `skins?: string[]`。

## 被否决的方案

- **引入 emoji-mart 等第三方库**：体积 ~300KB+ 且默认走图片 CDN 模式，违反本地优先与离线可用；其数据格式仅作参考，数据自产。
- **短代码 `:smile:` 双轨体系**：Markdown 管线需双份解析与渲染，双轨必然漂移；Unicode 直插零管线改动。
- **自定义图片表情 / 表情包上传**：v1 边界外——存储、分发与审核管道与「轻量表达」的收益不成比例。

## 边界与后续

- 数据集约 60KB（gzip ~20KB）随 shared 打包；`EMOJI_COMMON` 为 recent 为空时的首屏网格；
- 键盘导航（↑↓←→ 移动高亮 / Enter 插入）为收口期补全（2026-09-23，原实现仅 Esc / 搜索聚焦）；E2E 以「搜索「火箭」→ Enter 插入」路径锁定；
- 单测：`client/tests/m80-emoji.test.ts` 3 例（8 分类结构完整 / 常用 48 全在库 / 无重复；中文 / 英文 / 拼音搜索命中与空结果；isEmojiLike 库内与肤色变体放行、文本与超长序列拒绝）；
- E2E 走 `EmojiPicker` compact 形态（reactions「更多」入口），不单设选择器专属用例。
