/**
 * M65-C：设计域回填模板库（§8.3，常量注册表）——一切交互只写 Composer 草稿（ADR 0064 / 0118）。
 * 卡片与工作台共用；输出为「可编辑的起点」（含 <补述> 占位）而非命令句式。
 * 纯函数（可单测）；seed 等参数从卡片数据行提取后原样回填。
 */

/** 快照 → 图生图（工作台快照后的回填） */
export function tplSnapshotToRender(p: {
  snapshot: string
  style?: string
  material?: string
  view?: string
  seed?: string
}): string {
  const bits = [`基于 ${p.snapshot} 走图生图出效果图`]
  if (p.view) bits.push(`视角 ${p.view}`)
  if (p.style) bits.push(`风格 ${p.style}`)
  if (p.material) bits.push(`主材 ${p.material}`)
  const tail = p.seed ? `；参数 seed 沿用 ${p.seed}；` : '；'
  return `${bits.join('，')}${tail}`
}

/** 按风格板调整方案（styleboard 卡） */
export function tplApplyStyleboard(p: { theme: string; primary?: string; accent?: string }): string {
  const bits: string[] = []
  if (p.primary) bits.push(`主色 ${p.primary} 墙面`)
  if (p.accent) bits.push(`辅色 ${p.accent} 木作`)
  const detail = bits.length > 0 ? `：${bits.join('、')}` : '：'
  return `按「${p.theme}」风格板调整方案${detail}；保持现有布局不动；`
}

/** 调整房间（layout 卡房间行） */
export function tplAdjustRoom(p: { room: string; area?: string; note?: string }): string {
  const tail: string[] = []
  if (p.area) tail.push(`面积 ${p.area}`)
  if (p.note) tail.push(`现布局要点 ${p.note}`)
  const mid = tail.length > 0 ? `（${tail.join('，')}）` : ''
  return `@规方 想调整「${p.room}」：<补述改动>${mid}；`
}

/** 方案源未落盘（3D 工作台加载失败）：回填请规方补落盘指令（工作台错误卡） */
export function tplRelinkScene(p: { path: string }): string {
  return `@规方 3D 工作台加载失败：${p.path} 尚未落盘；请按 DesignScene v1（单位 mm）补齐该场景文件并与你发布的 layout 容器逐项一致，落盘后回执；`
}

/** 再生成一版效果图（render 卡） */
export function tplRegenRender(p: { title: string; seed?: string }): string {
  const seed = p.seed ? `seed 沿用 ${p.seed}` : 'seed 换新'
  return `再生成一版「${p.title}」：<变化点>（保持 <不变项>）；${seed}；`
}

/** 从 render 卡「参数」行提取 seed（`seed 12345 · 1024×768 · 步数 28`） */
export function seedOfParams(params: string): string | undefined {
  return /seed\s*([0-9]+)/i.exec(params)?.[1]
}
