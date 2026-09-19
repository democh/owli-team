/**
 * E2E · M54 可玩盘面（四盘主路径 + 参与层面板，mock 模式；设计 §8 M54-B t3 / M54-C t7）：
 * 1) 卦盘主路径：完整可派生卦卡 → 默认盘面（六爻列 / 世应角标 / 空亡 / 默认选中动爻）→
 *    爻详情随选中切换 → 变卦剧场（开 / 关）→ 错·综预览 → 重放装卦终态 →
 *    「表格 ⇄ 盘面」视图切换（切表格信息不丢）；
 * 2) 星盘主路径：完整可派生星盘卡 → 轮盘（10 行星 / 16 弦 / 12 宫 / ASC·MC 轴）→
 *    悬停行星出浮标 → 点行星看详情 → 请教此星（模板 8）→ 弦悬停中点浮标 → 点弦中选 →
 *    请教此相位（模板 9）→ 相位筛选显隐（16 ⇄ 12）→ 矩阵互跳（点格回轮盘且中选）；
 * 3) reduced-motion：卦盘重放直出终态（不进运行态，无中间时序）；
 * 4) 键盘走查：行星聚焦出浮标 + Enter 开详情；矩阵方向键换格 + Enter 激活回轮盘；
 * 5) M54-C 参与层：摇卦台六次成卦 → 揭晓对照 → 以此卦请解（草稿入 Composer，不发送）+ 研习足迹；
 *    场景面板双盘 + 合参双泳道（点选联动）+ 档案抽屉（存为档案 / 回看 / 异类盘并排）；
 * 6) 四盘全覆盖补齐：八字盘点柱详情 / 大运 scrub 空态补算 + 紫微盘三方四正高亮
 *    （设计 §7.8 口径②）/ 四化定位 / 大限巡游 / 请教草稿。
 *
 * 盘卡均为完整可派生样本（§3.8 必需门全过 → PanCard 默认盘面）；不可派生回退表格
 * 已在组件层覆盖（m54-pan-boards.test.tsx），本 spec 不重复。
 * 一切最终变化（错·综 / 相位高亮）均为本地确定性变换，不触发送、只回填草稿。
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { COMPOSER_PLACEHOLDER, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

/** 完整可派生卦卡（数字起卦；动爻六三 → 变爻有据；世 4 应 1；九五空亡） */
const A4_GUA = [
  '::: pan gua 天雷无妄 → 天火同人',
  '起卦：数字起卦（梅花） ｜ 2026-01-01 ｜ 数字 17、28',
  '所问：测试占问',
  '卦气：乙巳年 戊子月 乙亥日 丙子时 ｜ 日旬空 申酉 ｜ 二〇二五年冬月十三',
  '本卦：天雷无妄 ｜ 巽宫木 ｜ 世4应1',
  '卦体：上卦 乾（天·金） ｜ 下卦 震（雷·木）',
  '互卦：风山渐（上巽下艮） ｜ 变卦：天火同人（上乾下离）',
  '错卦：地风升（六爻全变） ｜ 综卦：山天大畜（六爻颠倒）',
  '动爻：六三（第 3 爻）',
  '体用：体乾（金） ｜ 用震（木） ｜ 体克用 · 我制于彼，事可成但需主动',
  '- 上九 | 玄武 妻财 壬戌 土',
  '- 九五 | 白虎 官鬼 壬申 金 空亡',
  '- 九四（世） | 腾蛇 子孙 壬午 火',
  '- 六三 动 | 勾陈 妻财 庚辰 土 → 己亥 水 父母',
  '- 六二 | 朱雀 兄弟 庚寅 木',
  '- 初九（应） | 青龙 父母 庚子 水',
  ':::',
].join('\n')

/** 完整可派生星盘卡（10 行星 / 12 宫头 / 16 相位 / ASC·MC 齐备） */
const A3_NATAL = [
  '::: pan natal 本命盘 1990-05-12 14:30',
  '出生：公历 1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E ｜ UTC 1990-05-12 05:30',
  '宫制：Placidus ｜ 四轴：ASC 处女 16.0° ｜ MC 双子 15.0° ｜ DSC 双鱼 16.0° ｜ IC 射手 15.0°',
  '元素：火2 土5 风0 水3 ｜ 模式：基本5 固定3 变动2',
  '- 太阳 | 金牛 21.2°（51.24°）｜ 9 宫',
  '- 月亮 | 射手 17.6°（257.62°）｜ 4 宫',
  '- 水星 | 金牛 8.8°（38.79°）｜ 8 宫 ｜ 逆行',
  '- 金星 | 白羊 9.1°（9.10°）｜ 7 宫',
  '- 火星 | 双鱼 15.9°（345.90°）｜ 6 宫',
  '- 木星 | 巨蟹 8.9°（98.93°）｜ 10 宫',
  '- 土星 | 摩羯 25.3°（295.30°）｜ 5 宫 ｜ 逆行',
  '- 天王星 | 摩羯 9.3°（279.26°）｜ 4 宫 ｜ 逆行',
  '- 海王星 | 摩羯 14.4°（284.40°）｜ 4 宫 ｜ 逆行',
  '- 冥王星 | 天蝎 16.3°（226.26°）｜ 3 宫 ｜ 逆行',
  '- 宫头 1 | 处女 16.0°',
  '- 宫头 2 | 天秤 12.7°',
  '- 宫头 3 | 天蝎 12.9°',
  '- 宫头 4 | 射手 15.0°',
  '- 宫头 5 | 摩羯 17.1°',
  '- 宫头 6 | 水瓶 17.7°',
  '- 宫头 7 | 双鱼 16.0°',
  '- 宫头 8 | 白羊 12.7°',
  '- 宫头 9 | 金牛 12.9°',
  '- 宫头 10 | 双子 15.0°',
  '- 宫头 11 | 巨蟹 17.1°',
  '- 宫头 12 | 狮子 17.7°',
  '- 太阳-土星 | 拱相 4.1°',
  '- 太阳-冥王星 | 对分 5.0°',
  '- 月亮-火星 | 刑相 1.7°',
  '- 水星-木星 | 六合 0.1°',
  '- 水星-天王星 | 拱相 0.5°',
  '- 水星-海王星 | 拱相 5.6°',
  '- 水星-冥王星 | 对分 7.5°',
  '- 金星-木星 | 刑相 0.2°',
  '- 金星-天王星 | 刑相 0.2°',
  '- 金星-海王星 | 刑相 5.3°',
  '- 火星-海王星 | 六合 1.5°',
  '- 火星-冥王星 | 拱相 0.4°',
  '- 木星-天王星 | 对分 0.3°',
  '- 木星-海王星 | 对分 5.5°',
  '- 天王星-海王星 | 合相 5.1°',
  '- 海王星-冥王星 | 六合 1.9°',
  ':::',
].join('\n')

/** 完整可派生八字卡（同人实测样本；当前大运甲申 29-38、当前流年 2026） */
const A4_BAZI = [
  '::: pan bazi 四柱 庚午 辛巳 丁丑 丁未',
  '命造：乾造 ｜ 生肖 马 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八',
  '四柱：庚午 辛巳 丁丑 丁未',
  '十神：正财 偏财 日主 比肩',
  '藏干：午(丁己) 巳(丙庚戊) 丑(己癸辛) 未(己丁乙)',
  '纳音：路旁土 ｜ 白蜡金 ｜ 涧下水 ｜ 天河水',
  '五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）',
  '空亡：年戌亥 月申酉 日申酉 时寅卯',
  '地势：年临官 月帝旺 日墓 时冠带',
  '胎元：壬申（剑锋金） ｜ 胎息：壬子（桑柘木）',
  '命宫：辛巳（白蜡金） ｜ 身宫：己丑（霹雳火）',
  '起运：8 年 2 月 20 日 ｜ 1998-08-01 交运 ｜ 大运顺行',
  '- 大运 壬午 | 9-18 岁 ｜ 1998-2007',
  '- 大运 癸未 | 19-28 岁 ｜ 2008-2017',
  '- 大运 甲申 | 29-38 岁 ｜ 2018-2027 · 当前大运',
  '- 大运 乙酉 | 39-48 岁 ｜ 2028-2037',
  '- 大运 丙戌 | 49-58 岁 ｜ 2038-2047',
  '- 大运 丁亥 | 59-68 岁 ｜ 2048-2057',
  '- 大运 戊子 | 69-78 岁 ｜ 2058-2067',
  '- 大运 己丑 | 79-88 岁 ｜ 2068-2077',
  '- 流年 2024 甲辰 | 35 岁',
  '- 流年 2025 乙巳 | 36 岁',
  '- 流年 2026 丙午 | 37 岁 · 当前',
  ':::',
].join('\n')

/** 完整可派生紫微卡（同人双盘；命宫戌太阴科、当前大限田宅丑 35-44） */
const A4_ZIWEI = [
  '::: pan ziwei 紫微 土五局 ｜ 命宫 丙戌',
  '命造：乾造 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八 ｜ 未时（13:00~15:00）',
  '四柱：庚午 辛巳 丁丑 丁未 ｜ 生肖 马 ｜ 星座 金牛座',
  '五行局：土五局 ｜ 命主 禄存 ｜ 身主 火星',
  '命身宫：命宫 丙戌 ｜ 身宫 福德 戊子',
  '生年四化：禄 太阳 ｜ 权 武曲 ｜ 科 太阴 ｜ 忌 天同',
  '- 官禄 戊寅 | 天同(利)忌 天梁(庙) ｜ 大限 45-54',
  '- 仆役 己卯 | 武曲(利)权 七杀(旺) ｜ 大限 55-64',
  '- 迁移 庚辰 | 太阳(旺)禄 ｜ 大限 65-74',
  '- 疾厄 辛巳 | （空宫） ｜ 大限 75-84',
  '- 财帛 壬午 | 天机(庙) ｜ 大限 85-94',
  '- 子女 癸未 | 紫微(庙) 破军(旺) ｜ 大限 95-104',
  '- 夫妻 甲申 | （空宫） ｜ 大限 105-114',
  '- 兄弟 乙酉 | 天府(旺) ｜ 大限 115-124',
  '- 命宫 丙戌 | 太阴(旺)科 ｜ 大限 5-14',
  '- 父母 丁亥 | 廉贞(陷) 贪狼(陷) ｜ 大限 15-24',
  '- 福德 戊子 身宫 | 巨门(旺) ｜ 大限 25-34',
  '- 田宅 己丑 | 天相(庙) ｜ 大限 35-44 · 当前',
  ':::',
].join('\n')

/** 消息流钉回顶部（mock 回复涌入会把顶部消息顶出虚拟列表视口而卸载） */
async function pinTop(page: Page): Promise<void> {
  await page.locator('[role="log"]').evaluate((el) => {
    el.scrollTop = 0
  })
}

/** 轮询钉顶等盘面卡成形（虚拟列表回收 + 懒加载 chunk 双重等待） */
async function waitBoard(page: Page, sel: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await pinTop(page)
        return page.locator(sel).count()
      },
      { timeout: 30_000, intervals: [200, 500, 1000] },
    )
    .toBeGreaterThan(0)
}

/** 新建会话 → 发送盘卡 → 等全链收束 → 钉顶等盘面成形（返回盘面卡定位） */
async function setupBoard(page: Page, cardText: string, sel: string) {
  await openApp(page)
  await createSession(page, { title: `E2E-M54B-${Date.now()}` })
  await sendMessage(page, cardText)
  // 顺序纪律（实测教训）：先等收束——视口自然停在底部，「你的回合」胶囊在底部渲染可见；
  // 若先钉顶（waitBoard 轮询滚动）会把底部胶囊置于虚拟列表视口外而不渲染 → element not found。
  await expectYourTurn(page)
  await waitBoard(page, sel)
  const card = page.locator(sel).first()
  await expect(card).toBeVisible()
  return card
}

/**
 * 在 SVG 弦（<line>）上取一个物理可命中的采样点。
 * 三层遮挡（实测）：① 视口顶部固定 UI 覆盖（先把弦滚到视口中部规避）；
 * ② 其它弦 9px 命中带的交叉覆盖；③ 悬浮胶囊按钮。沿弦从两端向中点交错采样，
 * 用 elementsFromPoint 自验证（栈顶为自身 = 该点未被遮挡），等价于真实用户
 * 悬停在弦的可命中断段。全采样点失败时抛出完整命中栈（定位坐标系/遮挡问题）。
 */
async function hitPointOnLine(page: Page, line: Locator): Promise<{ x: number; y: number }> {
  // ① 弦居中：脱离页顶固定 UI 与悬浮件的覆盖带
  await line.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }))
  await page.waitForTimeout(200)
  const res = await line.evaluate((el) => {
    const ln = el as SVGLineElement
    const r = ln.getBoundingClientRect()
    const x1 = ln.x1.baseVal.value
    const y1 = ln.y1.baseVal.value
    const x2 = ln.x2.baseVal.value
    const y2 = ln.y2.baseVal.value
    const ctm = ln.getScreenCTM()
    if (!ctm) return { pt: null as { x: number; y: number } | null, diag: ['getScreenCTM() = null'] }
    const describe = (e: Element) => {
      const cls = e.getAttribute('class')
      const a = e.getAttribute('data-a')
      return `${e.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${a !== null ? `[${a}-${e.getAttribute('data-b')}]` : ''}`
    }
    // 从两端向中点交错（端点附近通常最开敞，交叉密集区在中部）
    const ts: number[] = []
    for (let d = 0.42; d >= 0.04; d -= 0.04) ts.push(0.5 - d, 0.5 + d)
    const diag: string[] = []
    for (const t of ts) {
      const p = new DOMPoint(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t).matrixTransform(ctm)
      const inVp = p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight
      const stack = inVp ? document.elementsFromPoint(p.x, p.y) : []
      if (stack[0] === el) return { pt: { x: p.x, y: p.y }, diag: [] }
      diag.push(
        `t=${t.toFixed(2)} (${p.x.toFixed(0)},${p.y.toFixed(0)}) vp=${inVp ? 'Y' : 'N'} ${stack.slice(0, 3).map(describe).join(' ← ') || '∅'}`,
      )
    }
    const e1 = new DOMPoint(x1, y1).matrixTransform(ctm)
    const e2 = new DOMPoint(x2, y2).matrixTransform(ctm)
    diag.push(
      `ctm 端点: (${e1.x.toFixed(0)},${e1.y.toFixed(0)}) (${e2.x.toFixed(0)},${e2.y.toFixed(0)})`,
      `rect: (${r.left.toFixed(0)},${r.top.toFixed(0)}) ${r.width.toFixed(0)}x${r.height.toFixed(0)} · 视口 ${innerWidth}x${innerHeight}`,
    )
    return { pt: null as { x: number; y: number } | null, diag }
  })
  if (!res.pt) throw new Error(`弦上找不到可命中采样点：\n${res.diag.join('\n')}`)
  return res.pt
}

test('M54-B · 卦盘主路径：装卦回放 / 变卦剧场 / 错综预览 / 视图切换', async ({ page }) => {
  const card = await setupBoard(page, A4_GUA, '.pn-gua')

  // 默认盘面：六爻列（上九→初九）+ 世 ● / 应 ○ / 空亡角标
  await expect(card.locator('.pn-yao')).toHaveCount(6)
  await expect(card.locator('.pn-yao[data-pos="3"]')).toHaveClass(/is-on/)
  await expect(card.locator('.pn-yao[data-pos="3"]')).toHaveClass(/is-dong/)
  await expect(card.locator('.pn-yao[data-pos="4"]')).toHaveClass(/is-shi/)
  await expect(card.locator('.pn-yao[data-pos="1"]')).toHaveClass(/is-ying/)
  await expect(card.locator('.pn-yao[data-pos="5"]')).toHaveClass(/is-kong/)
  // 默认详情 = 首个动爻（六三）
  await expect(card.locator('.pn-yao-detail')).toContainText('六三 · 动爻')

  // 爻详情随选中切换（初九 · 应爻）
  await card.locator('.pn-yao[data-pos="1"]').click()
  await expect(card.locator('.pn-yao-detail')).toContainText('初九 · 应爻')
  await expect(card.locator('.pn-yao[data-pos="1"]')).toHaveClass(/is-on/)

  // 变卦剧场：开（动爻变出）→ 关（选中爻无变则不显）
  const theater = card.getByRole('button', { name: '变卦剧场' })
  await theater.click()
  await expect(theater).toHaveAttribute('aria-pressed', 'true')
  await expect(card.locator('.pn-yao-bian')).toHaveCount(1)
  await expect(card.locator('.pn-yao-bian')).toContainText('变 己亥 水 父母')
  await theater.click()
  await expect(card.locator('.pn-yao-bian')).toHaveCount(0)

  // 错·综预览（名称取自卡字段，确定性变换）
  await card.getByRole('button', { name: '错卦', exact: true }).click()
  await expect(card.locator('.pn-pop')).toContainText('错卦 地风升')
  await expect(card.locator('.pn-pop .pn-mini-yao')).toHaveCount(6)
  await expect(card.locator('.pn-pop')).toContainText('六爻全变')
  await card.getByRole('button', { name: '综卦', exact: true }).click()
  await expect(card.locator('.pn-pop')).toContainText('综卦 山天大畜')
  await expect(card.locator('.pn-pop')).toContainText('六爻颠倒')

  // 重放装卦：运行态 → 终态六爻全亮 → 按钮恢复
  await card.getByRole('button', { name: '重放装卦' }).click()
  await expect(card.getByRole('button', { name: '停止重放' })).toBeVisible()
  await expect(card.locator('.pn-yao.is-lit')).toHaveCount(6, { timeout: 15_000 })
  await expect(card.locator('.pn-yao.is-unlit')).toHaveCount(0)
  await expect(card.getByRole('button', { name: '重放装卦' })).toBeVisible()

  // 视图切换：表格（信息完整）→ 盘面（回）
  const pan = page.locator('.md-pan').first()
  await pan.locator('.md-pan-viewbtn', { hasText: '表格' }).click()
  await expect(page.locator('.pn-gua')).toHaveCount(0)
  await expect(pan.locator('.md-pan-item')).toHaveCount(6)
  await pan.locator('.md-pan-viewbtn', { hasText: '盘面' }).click()
  await expect(pan.locator('.pn-gua')).toBeVisible()
})

test('M54-B · 星盘主路径：轮盘 / 行星详情 / 弦提示 / 筛选 / 矩阵互跳 / 请教草稿', async ({ page }) => {
  const card = await setupBoard(page, A3_NATAL, '.pn-natal')

  // 轮盘结构：10 行星 / 16 弦 / 12 宫 / 12 星座 / ASC·MC 轴
  await expect(card.locator('.pn-wheel')).toHaveAttribute('viewBox', '0 0 320 320')
  await expect(card.locator('.pn-planet')).toHaveCount(10)
  await expect(card.locator('.pn-aspect-hit')).toHaveCount(16)
  await expect(card.locator('.pn-house-num')).toHaveCount(12)
  await expect(card.locator('.pn-zodiac-name')).toHaveCount(12)
  await expect(card.locator('.pn-axes')).toContainText('ASC')
  await expect(card.locator('.pn-axes')).toContainText('MC')

  // 悬停行星 → 浮标（名称 / 星座度数 / 落宫）；移出复原（键盘聚焦路径在下方走查覆盖）
  const sunP = card.locator('.pn-planet[data-name="太阳"]')
  await sunP.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }))
  await sunP.hover()
  await expect(card.locator('.pn-planet-tip')).toHaveText('太阳 金牛21.2° · 9 宫')
  await card.locator('.pn-wheel').hover({ position: { x: 4, y: 4 } })
  await expect(card.locator('.pn-planet-tip')).toHaveCount(0)

  // 点行星 → 详情（度数 / 落宫 / 相位清单）
  await card.locator('.pn-planet[data-name="太阳"]').click()
  await expect(card.locator('.pn-planet-detail')).toContainText('太阳')
  await expect(card.locator('.pn-planet-detail')).toContainText('金牛 21.2°')
  await expect(card.locator('.pn-planet-detail')).toContainText('第 9 宫')
  await expect(card.locator('.pn-planet-detail .pn-asp-item')).toHaveCount(2)

  // 请教此星（模板 8）→ 草稿入 Composer（不发送）
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.getByRole('button', { name: '请教太阳' }).click()
  await expect(composer).toHaveValue(/请解读本命盘中太阳（金牛21.2°，9 宫）的落点含义与依据/)

  // 弦悬停：中点浮标（设计 §4.4：悬停弦只出浮标；弦加粗属悬停行星/选中态行为）
  const hit = card.locator('.pn-aspect-hit[data-a="太阳"][data-b="土星"]')
  const hitPt = await hitPointOnLine(page, hit)
  await page.mouse.move(hitPt.x, hitPt.y)
  await expect(card.locator('.pn-aspect-tip')).toHaveText('太阳-土星 拱相 4.1°')

  // 点弦 → 中选 + 请教此相位（模板 9）
  await page.mouse.click(hitPt.x, hitPt.y)
  await expect(card.locator('.pn-aspect.is-hot')).toHaveCount(1)
  await composer.fill('')
  await card.getByRole('button', { name: '请教此相位' }).click()
  await expect(composer).toHaveValue(/请解读太阳-土星 拱相 4.1° 相位的课题与成长点表述（含依据）/)

  // 相位筛选：关刑相（16 → 12）→ 再开（12 → 16）
  const xing = card.locator('.pn-asp-chip', { hasText: '刑相' })
  await xing.click()
  await expect(xing).toHaveAttribute('aria-pressed', 'false')
  await expect(card.locator('.pn-aspect-hit')).toHaveCount(12)
  await xing.click()
  await expect(card.locator('.pn-aspect-hit')).toHaveCount(16)

  // 矩阵互跳：点格（水星-木星）→ 切回轮盘且该弦中选
  await card.locator('.pn-viewseg-btn', { hasText: '矩阵' }).click()
  await expect(card.locator('.pn-mrow')).toHaveCount(11)
  await expect(card.locator('.pn-mcell-btn')).toHaveCount(16)
  await card.locator('.pn-mcell-btn[data-a="水星"][data-b="木星"]').click()
  await expect(card.locator('.pn-wheel')).toBeVisible()
  await expect(card.locator('.pn-aspect.is-hot')).toHaveCount(1)
  await expect(card.locator('.pn-aspect[data-a="水星"][data-b="木星"]')).toHaveClass(/is-hot/)
})

test.describe('M54-B · reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('卦盘重放直出终态（不进运行态，无中间时序）', async ({ page }) => {
    const card = await setupBoard(page, A4_GUA, '.pn-gua')

    const replayBtn = card.getByRole('button', { name: '重放装卦' })
    await replayBtn.click()
    // 直出：六爻立即全亮（动画路径需 300ms×6 才能到终态）
    await expect(card.locator('.pn-yao.is-lit')).toHaveCount(6, { timeout: 1_500 })
    await expect(card.locator('.pn-yao.is-unlit')).toHaveCount(0)
    // 未进入运行态：按钮保持「重放装卦」
    await expect(replayBtn).toHaveText('重放装卦')
  })
})

test('M54-B · 键盘走查：行星 Enter 开详情 / 矩阵方向键换格 + Enter 激活', async ({ page }) => {
  const card = await setupBoard(page, A3_NATAL, '.pn-natal')

  // 行星（role=button + tabIndex=0）：聚焦即出浮标（与悬停同一状态源），Enter 开详情
  const mercury = card.locator('.pn-planet[data-name="水星"]')
  await mercury.focus()
  await expect(mercury).toBeFocused()
  await expect(card.locator('.pn-planet-tip')).toHaveText('水星 金牛8.8° · 8 宫 · 逆行')
  await page.keyboard.press('Enter')
  await expect(card.locator('.pn-planet-detail')).toContainText('水星 · 逆行')

  // 矩阵：方向键换格（同列最近相位格）+ Enter 激活回轮盘
  await card.locator('.pn-viewseg-btn', { hasText: '矩阵' }).click()
  const from = card.locator('.pn-mcell-btn[data-a="金星"][data-b="海王星"]')
  await from.focus()
  await expect(from).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(card.locator('.pn-mcell-btn[data-a="火星"][data-b="海王星"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(card.locator('.pn-wheel')).toBeVisible()
  await expect(card.locator('.pn-aspect[data-a="火星"][data-b="海王星"]')).toHaveClass(/is-hot/)
})

// ---------- M54-C：参与层走查（摇卦台 / 合参面板 / 档案抽屉） ----------

test('M54-C · 摇卦台：六次点击成卦 → 揭晓对照 → 以此卦请解 → 草稿入 Composer（不发送）', async ({ page }) => {
  const card = await setupBoard(page, A4_GUA, '.pn-gua')

  // 会话上下文注入：卡头 ⭐ 存档入口（在 .md-pan-head，与盘面根同级）+ 页脚研习足迹（本地只读小字）
  await expect(page.locator('.md-pan-archbtn').first()).toBeVisible()
  await expect(page.locator('.pn-trail').first()).toContainText('看过 1 张盘')

  // 「亲手摇卦」→ 摇卦台（对照基线 = 本卡卦盘）
  await card.getByRole('button', { name: '亲手摇卦' }).click()
  const toss = page.getByRole('dialog', { name: '摇卦台' })
  await expect(toss).toBeVisible()
  await toss.locator('.pn-toss-q input').fill('测试占问')
  await toss.getByRole('button', { name: /开始/ }).click()
  await expect(toss.locator('.pn-toss-seed')).toContainText('种子 ')
  const seed = (await toss.locator('.pn-toss-seed').textContent())!.replace(/\D+/g, '')

  // 六次点击成卦（600ms 翻转间钮禁用，Playwright 等可点后继续）
  for (let i = 0; i < 6; i++) {
    await toss.locator('.pn-toss-btn').click()
    await expect(toss.locator('.pn-toss-yao')).toHaveCount(i + 1, { timeout: 10_000 })
  }

  // 揭晓：本卦 + 与盘面对照（逐爻 6 行标点）；动爻随机，不断言有无
  await expect(toss.locator('.pn-toss-ben')).toContainText('本卦 ')
  await expect(toss.locator('.pn-toss-cmp')).toContainText('对照：天雷无妄')
  await expect(toss.locator('.pn-toss-cmp-row')).toHaveCount(6)

  // 以此卦请解 → 草稿入 Composer（种子与台面一致；不自动发送）
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await toss.getByRole('button', { name: '以此卦请解' }).click()
  await expect(toss).toHaveCount(0)
  await expect(composer).toHaveValue(new RegExp(`种子 ${seed}，所问：「测试占问」`))
  await expect(composer).toHaveValue(new RegExp(`gua_pan（method=coin，seed=${seed}）`))

  // 研习足迹：摇卦 / 请教事件已记（页脚只读小字）
  await expect(page.locator('.pn-trail').first()).toContainText('摇卦 1 次')
})

test('M54-C · 面板：双盘面板 + 合参双泳道 + 档案抽屉（存 / 回看 / 异类盘并排）', async ({ page }) => {
  await openApp(page)
  // 仅保留排盘两角色（观复 / 星垣）：触发词盘卡覆盖精确、运行链短
  await createSession(page, {
    scene: '传统数术',
    title: `E2E-M54C-面板-${Date.now()}`,
    unpick: ['liuyao', 'meihua', 'qizheng', 'daliuren', 'qimen'],
  })

  // M58：无盘面数据不渲染工作区
  await expect(page.locator('.scene-dock')).toHaveCount(0)

  // 触发词「盘面走查」→ mock 排盘角色各落一张盘面卡（同人双盘）→ 工作区出现
  await sendMessage(page, '请排盘并解读：盘面走查（同人八字与紫微双盘）。')
  await expectYourTurn(page)
  await expect(page.locator('.scene-dock-aside')).toBeVisible()
  const panel = page.locator('.scene-dock-aside')
  await expect(panel.getByText('盘面面板')).toBeVisible()

  // 双盘 tabs：八字 / 紫微（容器序 = 发言序）
  await expect(panel.locator('.scene-pb-tab')).toHaveCount(2)
  await expect(panel.locator('.scene-pb-tab', { hasText: '八字' })).toHaveCount(1)
  await expect(panel.locator('.scene-pb-tab', { hasText: '紫微' })).toHaveCount(1)

  // 面板头部「亲手摇卦」入口（§5.1：无卦盘也可摇）→ AppLayout 级全局宿主摇卦台（Escape 关闭）
  await panel.getByRole('button', { name: '亲手摇卦' }).click()
  const tossDialog = page.getByRole('dialog', { name: '摇卦台' })
  await expect(tossDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tossDialog).toHaveCount(0)

  // 合参：双盘可派生 → toggle 出双泳道（大运 8 段 / 大限 12 段）+ 当前段
  const almToggle = panel.locator('.pn-alm-toggle')
  await expect(almToggle).toBeVisible()
  await almToggle.click()
  await expect(almToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.pn-alm-lane')).toHaveCount(2)
  await expect(panel.locator('.pn-alm-lane').first().locator('.pn-alm-seg')).toHaveCount(8)
  await expect(panel.locator('.pn-alm-lane').nth(1).locator('.pn-alm-seg')).toHaveCount(12)
  await expect(panel.locator('.pn-alm-lane').first().locator('.pn-alm-seg.is-current')).toHaveCount(1)
  // 点选当前段 → 详情行（只读收口）
  await panel.locator('.pn-alm-lane').first().locator('.pn-alm-seg.is-current').click()
  await expect(panel.locator('.pn-alm-detail')).toContainText('大运')
  // 收起合参
  await almToggle.click()
  await expect(panel.locator('.pn-alm')).toHaveCount(0)

  // 档案：八字盘「存为档案」→ 计数 +1；切紫微再存 → 2
  const archCount = panel.locator('.pn-arch-count')
  await expect(archCount).toHaveText('档案（0）')
  const saveBtn = panel.locator('.scene-pb-arch')
  await saveBtn.click()
  await expect(saveBtn).toHaveText('已存为档案')
  await expect(archCount).toHaveText('档案（1）')
  await panel.locator('.scene-pb-tab', { hasText: '紫微' }).click()
  await saveBtn.click()
  await expect(archCount).toHaveText('档案（2）')

  // 抽屉：展开 → 选一（回看）→ 再选一（异类盘仅并排，不逐项差异）
  await panel.locator('.pn-arch-head').click()
  await expect(panel.locator('.pn-arch-row')).toHaveCount(2)
  await panel.locator('.pn-arch-main').first().click()
  await expect(panel.locator('.pn-arch-view')).toBeVisible()
  await panel.locator('.pn-arch-main').nth(1).click()
  await expect(panel.locator('.pn-arch-pair')).toBeVisible()
  await expect(panel.locator('.pn-arch-mix')).toContainText('异类盘仅并排')
})

test('M54-B · 八字盘主路径：点柱详情 / 大运 scrub 空态补算 / 请教草稿', async ({ page }) => {
  const card = await setupBoard(page, A4_BAZI, '.pn-bazi')

  // 结构：四柱 / 五行能量 / 大运轨道（当前甲申 29-38）/ 流年条（当前 2026）
  await expect(card.locator('.pn-pillar')).toHaveCount(4)
  await expect(card.locator('.pn-wx-row')).toHaveCount(5)
  await expect(card.locator('.pn-dyseg')).toHaveCount(8)
  await expect(card.locator('.pn-dyseg.is-current')).toContainText('甲申')
  await expect(card.locator('.pn-lnchip')).toHaveCount(3)
  await expect(card.locator('.pn-lnchip.is-current')).toContainText('2026')

  // 点日柱 → 详情（十神 / 藏干 / 纳音）；再点取消
  await card.locator('.pn-pillar').nth(2).click()
  await expect(card.locator('.pn-detail')).toContainText('日柱 丁丑')
  await expect(card.locator('.pn-detail')).toContainText('十神 日主')
  await expect(card.locator('.pn-detail')).toContainText('藏干 丑(己癸辛)')
  await expect(card.locator('.pn-detail')).toContainText('纳音 涧下水')
  await card.locator('.pn-pillar').nth(2).click()
  await expect(card.locator('.pn-detail')).toHaveCount(0)

  // 请教日柱（模板 4）→ 草稿入 Composer（不发送）
  await card.locator('.pn-pillar').nth(2).click()
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.getByRole('button', { name: '请教日柱' }).click()
  await expect(composer).toHaveValue(/请解读此柱（日柱 丁丑）在四柱中的十神与藏干背景/)

  // 大运 scrub：非当前步（丁亥 59-68）→ 流年空态 + 补算草稿（绝不虚构行运数据）
  await card.locator('.pn-dyseg[data-idx="5"]').click()
  await expect(card.locator('.pn-dyseg.is-on')).toContainText('丁亥')
  await expect(card.locator('.pn-ln-empty')).toContainText('该步流年未随盘计算')
  await composer.fill('')
  await card.getByRole('button', { name: '请研习师补算该步流年' }).click()
  await expect(composer).toHaveValue(/请补算丁亥大运（59-68 岁）内的十个流年/)

  // 回当前 → 流年条还原
  await card.getByRole('button', { name: '回当前' }).click()
  await expect(card.locator('.pn-lnchip')).toHaveCount(3)
})

test('M54-B · 紫微盘主路径：点宫三方四正 / 四化定位 / 大限巡游 / 请教草稿', async ({ page }) => {
  const card = await setupBoard(page, A4_ZIWEI, '.pn-ziwei')

  // 12 宫：命宫戌（太阴科）/ 当前大限田宅丑（35-44）
  await expect(card.locator('.pn-palace')).toHaveCount(12)
  await expect(card.locator('.pn-palace[data-branch="戌"]')).toContainText('命宫')
  await expect(card.locator('.pn-palace[data-branch="戌"]')).toContainText('太阴')
  await expect(card.locator('.pn-palace.is-current')).toHaveAttribute('data-branch', '丑')

  // 点命宫 → 三方四正高亮（戌 → 寅 / 午 / 辰，设计 §7.8 口径②）+ 详情
  await card.locator('.pn-palace[data-branch="戌"]').click()
  await expect(card.locator('.pn-palace[data-branch="戌"]')).toHaveClass(/is-on/)
  await expect(card.locator('.pn-palace.is-rel')).toHaveCount(3)
  await expect(card.locator('.pn-detail')).toContainText('命宫 丙戌')

  // 请教命宫（模板 7）→ 草稿入 Composer（不发送）
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.getByRole('button', { name: '请教命宫' }).click()
  await expect(composer).toHaveValue(/请重点解读命宫（丙戌）主星与四化背景/)

  // 再点取消 → 三方四正清除
  await card.locator('.pn-palace[data-branch="戌"]').click()
  await expect(card.locator('.pn-palace.is-rel')).toHaveCount(0)

  // 四化定位：点「科 太阴」→ 命宫戌 is-mu；再点清除
  const keBtn = card.locator('.pn-mu-btn', { hasText: '太阴' })
  await keBtn.click()
  await expect(keBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(card.locator('.pn-palace.is-mu')).toHaveCount(1)
  await expect(card.locator('.pn-palace.is-mu')).toHaveAttribute('data-branch', '戌')
  await keBtn.click()
  await expect(card.locator('.pn-palace.is-mu')).toHaveCount(0)

  // 大限巡游：本限（35-44 田宅）→ 下一限（官禄寅 is-xun）→ 回本限还原
  await expect(card.locator('.pn-center-xun')).toContainText('大限 35-44')
  await card.getByRole('button', { name: /下一限/ }).click()
  await expect(card.locator('.pn-center-xun')).toContainText('官禄')
  await expect(card.locator('.pn-palace[data-branch="寅"]')).toHaveClass(/is-xun/)
  await card.getByRole('button', { name: '回本限' }).click()
  await expect(card.locator('.pn-palace.is-xun')).toHaveCount(0)
})
