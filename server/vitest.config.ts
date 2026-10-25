import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // 脚本类（一次性迁移 / 探针）不计入：入口是 CLI 而非被业务调用
      exclude: ['src/**/*.d.ts', 'src/scripts/**'],
      // 基线（2026-10-25 实测 84.2% / 77.2% / 88.8%）：阈值略低 2-4 个点，用于拦截回退而非制造噪声
      thresholds: { lines: 82, statements: 82, functions: 86, branches: 75 },
    },
  },
})
