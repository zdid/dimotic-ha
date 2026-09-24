/**
 * Comptage de ce qui traite réellement une phrase (demande utilisateur, 26/08/2026) — cache
 * (`PhraseCache`), interpréteur déterministe (`interpreter/`), ou Mistral/Claude — partagé entre
 * les points d'entrée d'`IaService` (une seule instance ; DeployResponder supprimé le 24/09/2026). Objectif de
 * l'utilisateur : voir concrètement combien de charge Mistral quitte réellement au fil du temps.
 * En mémoire seulement, remis à zéro à chaque redémarrage — comme le reste des compteurs de ce
 * service (tokens, échanges récents).
 */
export class InterpreterMetrics {
  cacheHits = 0;
  interpreterHits = 0;
  mistralCalls = 0;

  recordCacheHit(): void {
    this.cacheHits++;
  }

  recordInterpreterHit(): void {
    this.interpreterHits++;
  }

  recordMistralCall(): void {
    this.mistralCalls++;
  }
}
