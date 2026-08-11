/**
 * Chargement et rechargement à chaud du fichier de règles domotiques (regles_mistral.txt, specs
 * §5), et injection en fin de message system existant (ou création si absent) — accompagné du
 * catalogue quoi/lieux connu (voir buildCatalogText ci-dessous).
 */

import * as fs from 'node:fs';
import type { Logger, HaStructureRegistry } from '../../../core/dist/exports';
import type { OllamaMessage } from './types';

export class RulesProvider {
  private rules = '';
  private watcher?: fs.FSWatcher;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    // Optionnel : sans lui, le catalogue quoi/lieux n'est simplement pas injecté (comportement
    // antérieur inchangé) — voir buildCatalogText.
    private readonly registry?: HaStructureRegistry
  ) {}

  load(): void {
    try {
      this.rules = fs.readFileSync(this.filePath, 'utf8');
      this.logger.info('RulesProvider', `Règles chargées depuis ${this.filePath} (${this.rules.length} caractères)`);
    } catch (error) {
      this.logger.error('RulesProvider', `Impossible de lire ${this.filePath}: ${error}`);
      this.rules = '';
    }

    this.watcher?.close();
    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.logger.info('RulesProvider', 'Changement détecté, rechargement des règles');
        this.load();
      });
    } catch (error) {
      this.logger.warn('RulesProvider', `Surveillance du fichier de règles indisponible: ${error}`);
    }
  }

  stop(): void {
    this.watcher?.close();
  }

  getRules(): string {
    return this.rules;
  }

  /** Injecte les règles (+ catalogue quoi/lieux, voir buildCatalogText) en fin de message system
   *  existant, ou en crée un. */
  inject(messages: OllamaMessage[]): OllamaMessage[] {
    if (!this.rules) {
      this.logger.warn('RulesProvider', 'Aucune règle disponible, injection ignorée');
      return messages;
    }

    const catalog = this.buildCatalogText();
    const content = catalog ? `${this.rules}\n\n${catalog}` : this.rules;

    const result = [...messages];
    const systemIdx = result.findIndex((m) => m.role === 'system');

    if (systemIdx >= 0) {
      result[systemIdx] = { ...result[systemIdx], content: `${result[systemIdx].content}\n\n${content}` };
    } else {
      result.unshift({ role: 'system', content });
    }

    return result;
  }

  /**
   * ⭐ Catalogue quoi/lieux connu, recalculé à chaque appel depuis `HaStructureRegistry` (coût
   * négligeable, voir `getLieuCatalog()`) — demande utilisateur : ces listes sont quasi statiques
   * (ne changent qu'à l'ajout/modification/suppression de matériel), transmettre une vérité déjà
   * connue plutôt que de forcer un aller-retour d'outil à chaque fois, et surtout éviter que
   * Mistral devine/halluciner qu'un lieu ou un quoi n'existe pas faute de donnée sous les yeux
   * (source du bug "quoi_introuvable" injustifié constaté en conditions réelles, ex: "allume la
   * salle" refusé à tort alors que l'area existe bien). Le contenu reste identique à chaque appel
   * tant que le matériel ne change pas — profite donc du cache de prompt côté Mistral comme le
   * reste du message system.
   */
  private buildCatalogText(): string {
    if (!this.registry) return '';

    // Pas des cibles adressables par une commande domotique — demande utilisateur : "bouton"
    // (déclencheur physique, pas un "quoi" qu'on allume/éteint), "telecommande"/"scenes_switch"
    // (accessoires de déclenchement), "zigbee2mqtt_bridge" (infrastructure technique). Filtré ici
    // uniquement (pas dans getQuoiCatalog() lui-même, réutilisé ailleurs — ex: arbreouquoi — où
    // ces quoi restent des catégories légitimes à parcourir).
    const EXCLUDED_QUOI_IDS = new Set(['bouton', 'telecommande', 'scenes_switch', 'zigbee2mqtt_bridge']);
    const quoiList = this.registry.getQuoiCatalog()
      .filter((q) => !EXCLUDED_QUOI_IDS.has(q.quoi_id))
      .map((q) => q.label || q.quoi_id)
      .join(', ');
    const lieuxList = this.registry.getLieuCatalog().join(', ');
    if (!quoiList && !lieuxList) return '';

    return [
      '━━━ CATALOGUE CONNU DE LA MAISON (à jour, vérité de terrain) ━━━',
      '',
      `QUOI existants : ${quoiList || 'aucun'}`,
      '',
      `Lieux existants (tous niveaux confondus — lieu précis, pièce, étage/zone, maison) : ${lieuxList || 'aucun'}`,
      '',
      'Utilise cette liste pour vérifier qu\'un quoi ou un lieu existe AVANT de répondre',
      '"quoi_introuvable" (section 0.4) — si le terme y figure, ne réponds jamais cette erreur',
      'sans avoir d\'abord appelé lister_entites/obtenir_etat pour le résoudre réellement.'
    ].join('\n');
  }
}
