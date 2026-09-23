import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Pyodide downloads numpy/pandas wheels on first load and the agent
    // test makes several model round-trips, so both need generous limits.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // The Pyodide worker holds a WASM heap; keep tests in one process so
    // the distribution is fetched once and files never race each other.
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
    // Print the agent's event log and streamed tokens to the terminal as they
    // happen instead of buffering them behind the reporter.
    disableConsoleIntercept: true,
  },
})
