import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'integration',
      include: ['test/integration/*.test.ts'],
      globalSetup: ['./test/integration/global-setup.ts'],
      testTimeout: 30_000,
      hookTimeout: 180_000,
      // One database per run, shared by every file: they must not overlap.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
])
