import { defineConfig } from 'vitest/config';

// Configuration propre à outils : sans elle, Vitest remonte jusqu'à la configuration du cœur / de la racine du dépôt.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts']
  }
});
