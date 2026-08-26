/**
 * Cache des 100 dernières phrases résolues (demande utilisateur, 26/08/2026) — permet d'envoyer
 * une commande directement, sans repasser par l'interpréteur déterministe NI par Mistral, quand la
 * MÊME phrase a déjà été résolue récemment. Alimenté par les trois origines possibles d'une
 * décision (`IaService.handleChat`/`handleTestCommand`, `DeployResponder`), partagé entre les
 * trois — une seule instance construite par `IaService`.
 *
 * Clé : texte normalisé (minuscules, sans accents — même normalisation que le moteur
 * d'interprétation, `tokenizer.ts::normalizeText`) pour que deux formulations qui ne diffèrent que
 * par la casse/les accents partagent la même entrée. Valeur : la décision déjà résolue, dans le
 * même format `DeterministicOutcome[]` que produit l'interpréteur — permet de la rejouer
 * (`executeOutcomes`/`outcomesToExecutionSteps`) sans savoir si elle vient de l'interpréteur ou de
 * Mistral à l'origine.
 *
 * LRU simple : `Map` préserve l'ordre d'insertion, une entrée relue est retirée puis réinsérée en
 * fin (donc en position "la plus récente"), la plus ancienne est évincée au-delà de `maxSize`.
 */

import { normalizeText } from './interpreter/tokenizer';
import type { DeterministicOutcome } from './interpreter/index';

const DEFAULT_MAX_SIZE = 100;

export class PhraseCache {
  private readonly entries = new Map<string, DeterministicOutcome[]>();

  constructor(private readonly maxSize: number = DEFAULT_MAX_SIZE) {}

  get(phrase: string): DeterministicOutcome[] | undefined {
    const key = normalizeText(phrase);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(phrase: string, outcomes: DeterministicOutcome[]): void {
    const key = normalizeText(phrase);
    this.entries.delete(key);
    this.entries.set(key, outcomes);
    if (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
