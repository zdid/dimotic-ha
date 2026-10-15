import { defineConfig } from 'vitest/config';

// Tests du pilote AREXX (gestion des pilotes, 15/10/2026) : vitest est celui du cœur (`npm test` l'appelle par chemin).
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
});
