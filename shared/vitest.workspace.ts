import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['test/*.test.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      include: ['test/integration/*.test.ts'],
      globalSetup: ['./test/integration/global-setup.ts'],
      testTimeout: 30_000,
      hookTimeout: 180_000,
      // Integration files share one database (and the RLS suite creates a
      // cluster-wide role), so they must not run concurrently.
      // `fileParallelism` is ignored inside a project config; a single fork is
      // honoured and gives real serialization.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
])
