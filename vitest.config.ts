import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 2 プロジェクト構成(設計 §1-2):
//   - node: core / cli / mcp / server の単体テスト(*.test.ts)
//   - web : React SPA(src/web)の単体テスト(*.test.tsx、jsdom + @testing-library/react)
export default defineConfig({
  test: {
    // スキャフォールド直後などテストが 1 件も無くても起動を成功させる。
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['node_modules/**', 'dist/**', 'src/web/**', 'test/web/**'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['test/web/**/*.test.tsx', 'src/web/**/*.test.tsx'],
          exclude: ['node_modules/**', 'dist/**'],
        },
      },
    ],
  },
});
