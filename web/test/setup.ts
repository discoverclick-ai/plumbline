import '@testing-library/jest-dom/vitest'

/**
 * jsdom provides the DOM but no network stack. These tests talk to a real API
 * over real HTTP, so a missing `fetch` would surface as a confusing
 * "fetch is not defined" inside a component rather than an honest failure.
 */
if (typeof globalThis.fetch !== 'function') {
  throw new Error('global fetch is unavailable; the web integration tests need it')
}
