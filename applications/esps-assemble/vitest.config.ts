import { defineConfig } from 'vitest/config';

// Configuration propre à rfxcom : sans elle, Vitest remonte jusqu'à la configuration de la racine du dépôt.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts']
  }
});
