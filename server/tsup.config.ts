import { cpSync } from 'node:fs'
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  // shared 是 TS 源码包，需打进 server 产物
  noExternal: ['@multi-agent/shared'],
  onSuccess: async () => {
    // Python 桥脚本随构建拷贝（产物 dist/py/fin_bridge.py，与 bridge/runner.ts 定位约定一致）
    cpSync('src/finance/bridge/py', 'dist/py', {
      recursive: true,
      filter: (src) => !src.includes('__pycache__'),
    })
  },
})
