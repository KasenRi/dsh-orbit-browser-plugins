import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  resolve: {
    alias: {
      // The published primitives root pulls in its whole markdown/shiki graph;
      // component specs only need the three members the control consumes.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./client/tests/helpers/primitives-stub.tsx', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['client/tests/**/*.test.ts', 'client/tests/**/*.test.tsx'],
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
  },
})
