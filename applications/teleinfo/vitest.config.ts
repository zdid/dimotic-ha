import { defineConfig } from 'vitest/config';

// Essais de la surveillance des cycles de l'agent teleinfo (18/10/2026) : vitest est celui du cœur.
export default defineConfig({
  test: { environment: 'node', include: ['device-agent/**/*.test.js', 'src/**/*.test.ts'] }
});
