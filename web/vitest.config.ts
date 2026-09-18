import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/integration/*.test.tsx'],
    globalSetup: ['./test/integration/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    environment: 'jsdom',
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // One database and one API server per run; serialize like every other
    // package here.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
