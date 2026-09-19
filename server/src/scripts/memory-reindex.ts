/**
 * CLI：记忆向量后台重建（`npm run memory:reindex`，M25）。
 *
 * 场景：嵌入模型 / 维度切换后（连接中心选中项或 EMBEDDING_*）重建索引与镜像；
 * 断点续跑：队列持久化，失败条目重置重试、缺失向量全量补账，中断后可重复执行。
 *
 * 用法：
 *   npm run memory:reindex                       # 常规重建（清旧模型 BLOB + 补账 + 消费队列）
 *   npm run memory:reindex -- --force            # 同时丢弃 vec0 镜像（从 BLOB 全量重灌）
 *   npm run memory:reindex -- --timeout 600      # 队列消费等待上限（秒，默认 600）
 *
 * 退出码：0 全部完成；1 未配置嵌入服务 / 索引不可用 / 消费超时 / 存在失败条目。
 */
import { loadConfig } from '../config.js'
import { SecretVault } from '../connections/crypto.js'
import { EmbeddingManager } from '../embeddings/manager.js'
import { MemoryService } from '../memory/service.js'
import { applySettingsToConfig, readSettingsFile } from '../settings.js'
import { ConnectionStore } from '../store/connections.js'
import { openDatabase } from '../store/db.js'
import { MemoryStore } from '../store/memory.js'
import { EmbeddingCacheStore, EmbedQueueStore, MemoryVectorStore } from '../store/memory-vectors.js'

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const cfg = loadConfig()
applySettingsToConfig(cfg, readSettingsFile(cfg.settingsFile))

const force = process.argv.includes('--force')
const timeoutMs = Math.max(10, Number(argValue('--timeout') ?? 600)) * 1000

const db = openDatabase(cfg.dbFile)
const vault = SecretVault.load({
  keyMaterial: process.env.CONNECTION_SECRET_KEY,
  keyFile: cfg.connectionSecretFile,
})
const connections = new ConnectionStore(db, vault)
const embeddings = new EmbeddingManager({ cfg, connections, cache: new EmbeddingCacheStore(db) })

const spec = embeddings.resolve()
if (!spec) {
  console.error(
    '[reindex] 嵌入服务未配置：请在连接中心创建 embedding 连接并在设置中选中，或配置 EMBEDDING_* 环境变量',
  )
  db.close()
  process.exit(1)
}
console.log(
  `[reindex] 嵌入来源 ${spec.source} / 模型 ${spec.model} / 维度 ${spec.dim > 0 ? spec.dim : '待探测'}${force ? ' / 强制重建镜像' : ''}`,
)

const embedQueue = new EmbedQueueStore(db)
const store = new MemoryStore(db, embedQueue)
const memories = new MemoryService({
  cfg,
  db,
  store,
  vectors: new MemoryVectorStore(db),
  queue: embedQueue,
  embeddings,
})

await memories.start()
const result = await memories.reindex(force)
if (!result.ok) {
  console.error(`[reindex] 失败：${result.error ?? '未知错误'}`)
  memories.stop()
  db.close()
  process.exit(1)
}
console.log(
  `[reindex] 索引就绪：模型 ${result.model} / 维度 ${result.dim} / 清理旧向量 ${result.removed} 行 / 补账入队 ${result.requeued} 条`,
)

// 队列消费（worker 定时器 + poke 轮询；中断可直接重跑，队列持久化保证不丢不重）
const startedAt = Date.now()
let lastLogAt = 0
while (memories.stats().pending > 0) {
  if (Date.now() - startedAt > timeoutMs) break
  const flushed = await memories.poke()
  if (flushed === 0) await sleep(250)
  if (Date.now() - lastLogAt > 2000) {
    lastLogAt = Date.now()
    const stats = memories.stats()
    console.log(`[reindex] 消费中… 待处理 ${stats.pending} / 失败 ${stats.failed} / 向量总量 ${stats.vectorTotal}`)
  }
}

const final = memories.stats()
console.log(
  `[reindex] 汇总：后端 ${final.backend ?? '未引导'}（ext ${final.extVersion ?? '-'}）/ 向量总量 ${final.vectorTotal} / 待处理 ${final.pending} / 失败 ${final.failed}`,
)
memories.stop()
db.close()

if (final.pending > 0) {
  console.error('[reindex] 队列未消费完（超时）：可重新执行本脚本续跑（已完成部分不会重复）')
  process.exit(1)
}
if (final.failed > 0) {
  console.error(`[reindex] 有 ${final.failed} 条嵌入失败（已重试上限）：请检查嵌入服务可用性后重新执行`)
  process.exit(1)
}
console.log('[reindex] 全部完成')
