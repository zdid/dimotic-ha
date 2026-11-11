import { defineConfig } from 'vitest/config';

// Tests de planificateur (11/11/2026, commande lecteur) : vitest est celui du cœur (`npm test` l'appelle par chemin).
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
});
