/**
 * Limiteur de débit générique (requêtes/s + tokens/min, fenêtre glissante) — module dédié plutôt
 * que codé en dur dans MistralClient, pour pouvoir instancier un profil différent (autres limites)
 * si un autre fournisseur/modèle IA est ajouté un jour (demande utilisateur, §6 routage multi-IA).
 *
 * Le budget de tokens ne peut être qu'à moitié préventif : Mistral ne renvoie le coût réel d'une
 * requête (prompt + completion) qu'une fois la réponse reçue, jamais avant l'envoi — impossible de
 * refuser par avance une requête dont on ne connaît pas encore le coût. waitForSlot() ne peut donc
 * que retarder une requête si le budget des 60 dernières secondes est déjà épuisé par les requêtes
 * PRÉCÉDENTES (recordUsage), pas garantir qu'une requête individuelle ne le dépassera jamais.
 */

import type { Logger } from '../../../core/dist/exports';

const TOKEN_WINDOW_MS = 60_000;

export class RateLimiter {
  private lastRequestAt = 0;
  private readonly tokenWindow: Array<{ at: number; tokens: number }> = [];

  constructor(
    private readonly label: string,
    private readonly requestsPerSecond: number,
    private readonly tokensPerMinute: number,
    private readonly logger: Logger
  ) {}

  /** À appeler juste avant chaque requête sortante — attend si nécessaire pour respecter
   *  l'espacement minimum entre requêtes ET le budget de tokens/minute. */
  async waitForSlot(): Promise<void> {
    const minIntervalMs = 1000 / this.requestsPerSecond;
    const sinceLast = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && sinceLast < minIntervalMs) {
      const wait = minIntervalMs - sinceLast;
      this.logger.info('RateLimiter', `[${this.label}] Espacement requêtes (${this.requestsPerSecond}/s): attente ${Math.round(wait)}ms`);
      await sleep(wait);
    }

    this.pruneWindow();
    const used = this.tokenWindow.reduce((sum, e) => sum + e.tokens, 0);
    if (used >= this.tokensPerMinute) {
      const oldest = this.tokenWindow[0];
      const waitMs = oldest ? Math.max(0, oldest.at + TOKEN_WINDOW_MS - Date.now()) : 0;
      if (waitMs > 0) {
        this.logger.warn('RateLimiter', `[${this.label}] Budget tokens/min atteint (${used}/${this.tokensPerMinute}) — attente ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        this.pruneWindow();
      }
    }

    this.lastRequestAt = Date.now();
  }

  /** À appeler après chaque requête réussie, avec le total de tokens réellement consommés
   *  (prompt + completion) — connu seulement une fois la réponse de Mistral reçue en entier. */
  recordUsage(totalTokens: number): void {
    if (totalTokens <= 0) return;
    this.tokenWindow.push({ at: Date.now(), tokens: totalTokens });
    this.pruneWindow();
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - TOKEN_WINDOW_MS;
    while (this.tokenWindow.length && this.tokenWindow[0].at < cutoff) {
      this.tokenWindow.shift();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
