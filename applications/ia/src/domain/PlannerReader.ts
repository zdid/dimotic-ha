/**
 * Lecture (seule) des données du planificateur, pour l'outil MCP `lire_planificateur`
 * (specs ia v1.20 §19.8).
 *
 * `planificateur` publie déjà ses listes sur l'EventBus (pour son propre tableau de bord) et répond
 * aux événements `…:get` : ia les demande à la volée et attend la réponse. Aucun code n'est ajouté
 * côté planificateur ; il suffit que ia reçoive ces événements (bridgedEvents, index.ts) — les
 * `…:get` partent d'ia sans déclaration (app → core est générique) et atteignent planificateur
 * puisqu'ils font partie de ses propres événements de socket.
 */

import type { IEventBus } from '../../../core/dist/exports';

export type PlannerSection = 'statut' | 'planifications' | 'macros' | 'actions_recues' | 'commandes_ha' | 'yaml';

interface SectionSpec {
  /** Événement émis par planificateur avec la donnée. */
  reply: string;
  /** Événement à émettre pour la demander. */
  request: string;
}

const SECTIONS: Record<Exclude<PlannerSection, 'yaml'>, SectionSpec> = {
  statut: { reply: 'planificateur:status', request: 'planificateur:status:get' },
  planifications: { reply: 'planificateur:planifications:list', request: 'planificateur:planifications:list:get' },
  macros: { reply: 'planificateur:macros:list', request: 'planificateur:macros:list:get' },
  actions_recues: { reply: 'planificateur:actions:list', request: 'planificateur:actions:list:get' },
  commandes_ha: { reply: 'planificateur:ha-commands:list', request: 'planificateur:ha-commands:list:get' }
};
const YAML_REPLY = 'planificateur:planification:yaml';
const YAML_REQUEST = 'planificateur:planification:yaml:get';

/** Événements que ia doit recevoir de planificateur (à déclarer dans `bridgedEvents`). */
export const PLANNER_READ_EVENTS: string[] = [...Object.values(SECTIONS).map((s) => s.reply), YAML_REPLY];

export interface PlannerRead<T = unknown> {
  data: T | undefined;
  /** false si planificateur n'a pas répondu à temps (donnée absente, ou dernière connue) */
  frais: boolean;
  /** horodatage ISO de la donnée renvoyée */
  recu_a?: string;
}

export class PlannerReader {
  private readonly latest = new Map<string, { data: unknown; at: string }>();

  constructor(private readonly eventBus: IEventBus, private readonly timeoutMs = 2500) {
    for (const reply of PLANNER_READ_EVENTS) {
      this.eventBus.onGeneric(reply, (data) => this.latest.set(reply, { data, at: new Date().toISOString() }));
    }
  }

  /** Redemande une section à planificateur et attend sa réponse ; à défaut, renvoie la dernière connue. */
  async read(section: Exclude<PlannerSection, 'yaml'>): Promise<PlannerRead> {
    const spec = SECTIONS[section];
    return this.ask(spec.reply, spec.request, undefined, () => true);
  }

  /** Texte YAML d'une planification (calculé par planificateur à la demande). */
  async readYaml(name: string): Promise<PlannerRead<string>> {
    const result = await this.ask(YAML_REPLY, YAML_REQUEST, { name }, (data) => (data as { name?: string })?.name === name);
    const reply = result.data as { name: string; yaml: string } | undefined;
    // Sans réponse à temps, la dernière connue peut concerner une AUTRE planification : ne jamais la rendre.
    return { data: reply?.name === name ? reply.yaml : undefined, frais: result.frais, recu_a: result.recu_a };
  }

  private ask(replyEvent: string, requestEvent: string, payload: unknown, accept: (data: unknown) => boolean): Promise<PlannerRead> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (fresh: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.eventBus.offGeneric(replyEvent, listener);
        const known = this.latest.get(replyEvent);
        resolve({ data: known?.data, frais: fresh, recu_a: known?.at });
      };
      // Le listener du constructeur a déjà enregistré la donnée quand celui-ci est appelé.
      const listener = (data: unknown): void => {
        if (accept(data)) queueMicrotask(() => finish(true));
      };
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      this.eventBus.onGeneric(replyEvent, listener);
      this.eventBus.emitGeneric(requestEvent, payload ?? {});
    });
  }
}
