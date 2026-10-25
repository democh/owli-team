/**
 * ESLint 扁平配置（M1）：TS 全局 + client 追加 react-hooks。
 *
 * 级别策略：可自动修复/风格类规则保持 warn（不阻断门禁），真实缺陷类规则保持 error。
 */
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'data/**',
      'workspace/**',
      'evals/reports/**',
      '**/*.d.ts',
      // 本地临时探针（git 已忽略，内容随任务变化）与上游数据夹具（保持原样以便对照）
      'scripts/tmp-*',
      'server/tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // 风格 / 未使用变量：warn（不阻断门禁），参数与变量允许 `_` 前缀豁免
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-console': 'off',
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'server/tests/**/*.ts', 'client/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
