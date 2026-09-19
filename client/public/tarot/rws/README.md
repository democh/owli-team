# 塔罗牌面素材（公版韦特 · Rider-Waite-Smith）

本目录为「塔罗研习」场景的牌面位图（78 张），供抽牌台仪式展示、图鉴与揭示态渲染使用。

## 许可与来源

- **原作**：Rider-Waite-Smith Tarot（1909）——原画 Pamela Colman Smith（1878–1951），Rider & Company 出版；
- **版权状态**：**公有领域（Public Domain）**——1909 年出版，版权已过期；主要司法辖区（美 / 欧）均已公版；
- **图片来源**：`mixvlad/TarotCards` 仓库（GitHub）`tarot/rider-waite/720px/`，经 `cdn.jsdelivr.net` 直链拉取；其 `SOURCES.md` 载明扫描来源 Steve-P.org Tarot Collection，并要求致谢原画者与出版方；
- **我方处理**：仅等比压缩（`sips -Z 560 -s formatOptions 70`），未做任何内容修改；
- **署名**（界面小字口径）：`牌面：Rider-Waite-Smith（1909，公有领域）`。

## 文件命名（slug 规则）

| 分组 | 文件名 | 说明 |
| --- | --- | --- |
| 大阿卡纳 | `major-00.jpg` … `major-21.jpg` | 愚者 → 世界（序号 0-21） |
| 权杖 | `wands-01.jpg` … `wands-14.jpg` | 首牌 → 国王 |
| 圣杯 | `cups-01.jpg` … `cups-14.jpg` | 同上 |
| 宝剑 | `swords-01.jpg` … `swords-14.jpg` | 同上 |
| 星币 | `pents-01.jpg` … `pents-14.jpg` | 同上 |

映射与拉取脚本：仓库根 `tmp-fetch-tarot-cards.mjs`（源文件 → slug 全表；断点续传；缺图重跑自动补拉）。
牌表与位图关联：`client/src/components/chat/md-ext/tarot/deck.ts`（`deck.slug` / `cardSlugOf` / `cardImageUrl`）。
