import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    // 对话框 / 消息流用例包含多次真实渲染，满载并行时 5s 默认值会产生假超时。
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      // 基线（2026-10-25 实测 75.4% / 78.4% / 68.3%）：阈值略低 2 个点，拦住明显回退
      thresholds: { lines: 73, statements: 73, functions: 66, branches: 76 },
    },
  },
})
