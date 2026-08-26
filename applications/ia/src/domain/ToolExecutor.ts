/**
 * Exécution des appels d'outils décidés par Mistral (specs §8).
 *  - lister_entites / obtenir_etat (lecture) : résolus localement via HaStructureRegistry, jamais
 *    de sollicitation de planificateur.
 *  - executer_action (action) : transmis à planificateur via ia:tool:execute (corrélation +
 *    timeout), qui résout l'intention en resolved_service_call et l'exécute (voir
 *    fonctionnelles-planificateur_specs §6/§7/§8).
 */

import type { HaBridgeClient, Logger, IEventBus } from '../../../core/dist/exports';
import { CorrelatedRequester } from '../../../core/dist/exports';
import type { MistralToolCall, ExecuterActionParams, CorrelatedReponse } from './types';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

// Résolution déléguée à HaStructureRegistry.getEntitiesByQuoiAndLieux (graphe de lieux,
// indépendant du niveau taxonomique — voir applications/planificateur/src/domain/resolution.ts
// pour la même logique côté exécution) : évite de dupliquer ici un matching area-seule qui ne
// couvrait ni lieu_precis ni lieu_pere.
async function resolveEntities(registry: HaBridgeClient, quoi?: string, lieux?: string[]): Promise<Array<{ entity_id: string; state?: string; name?: string }>> {
  const quoiId = quoi ? slugify(quoi) : undefined;
  const entities = await registry.getEntitiesByQuoiAndLieux(quoiId, lieux ?? []);
  return entities.map((e) => ({ entity_id: e.entity_id, state: e.state, name: e.friendly_name }));
}

export class ToolExecutor {
  private readonly toolExecuteRequester: CorrelatedRequester<ExecuterActionParams, CorrelatedReponse>;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly registry: HaBridgeClient,
    private readonly toolExecuteTimeoutMs: number
  ) {
    this.toolExecuteRequester = new CorrelatedRequester<ExecuterActionParams, CorrelatedReponse>(
      eventBus,
      'ia:tool:execute',
      'ia:tool:execute:reply'
    );
  }

  /** Exécute un appel d'outil et retourne le contenu à réinjecter en message role:tool.
   *  `dryRun` (comparatif Claude/Mistral, IaService.handleCompareCommand) : les outils de lecture
   *  (lister_entites/obtenir_etat) s'exécutent normalement (sans effet de bord, la comparaison
   *  reste fidèle au comportement réel du modèle), seul executer_action est intercepté — jamais
   *  transmis à planificateur, pour ne jamais agir deux fois sur la maison depuis un test. */
  async execute(call: MistralToolCall, dryRun = false): Promise<string> {
    const args = typeof call.function.arguments === 'string'
      ? safeParse(call.function.arguments)
      : call.function.arguments;

    switch (call.function.name) {
      case 'lister_entites': {
        if (!this.registry.isAvailable()) return JSON.stringify({ error: 'référentiel HA indisponible' });
        const entities = await resolveEntities(this.registry, args?.quoi as string | undefined, args?.lieux as string[] | undefined);
        return JSON.stringify({ entities: entities.map((e) => ({ entity_id: e.entity_id, name: e.name })) });
      }

      case 'obtenir_etat': {
        if (!this.registry.isAvailable()) return JSON.stringify({ error: 'référentiel HA indisponible' });
        const entities = await resolveEntities(this.registry, args?.quoi as string | undefined, args?.lieux as string[] | undefined);
        return JSON.stringify({ entities });
      }

      case 'executer_action': {
        const params: ExecuterActionParams = {
          verbe: String(args?.verbe ?? ''),
          quoi: String(args?.quoi ?? ''),
          lieux: Array.isArray(args?.lieux) ? (args!.lieux as string[]) : [],
          valeur: args?.valeur as string | number | undefined
        };
        if (dryRun) {
          // ⭐ Vérification quoi/lieux AVANT de répondre (12/08/2026) — sans ça, le dry-run
          // affirmait toujours "succès" même quand quoi/lieux ne résolvaient à aucune entité
          // réelle : bug trouvé en creusant le comparatif ("baisse le volet de la cuisine" — aucun
          // volet roulant en cuisine — Mistral Small et Claude Haiku répondaient "action réussie"
          // sans jamais vérifier, contrairement à Claude Sonnet qui avait interrogé lister_entites
          // et correctement refusé). Même principe que referenceValidator.ts pour le JSON structuré
          // — ici directement au point d'exécution de l'outil, seul endroit qui voit params
          // vraiment résolus.
          const resolved = this.registry.isAvailable() ? await resolveEntities(this.registry, params.quoi, params.lieux) : [];
          if (this.registry.isAvailable() && resolved.length === 0) {
            return JSON.stringify({
              success: false,
              message: `Aucune entité trouvée pour quoi="${params.quoi}" dans ${JSON.stringify(params.lieux)} — vérifie via lister_entites/obtenir_etat avant de conclure, ne réponds pas "quoi_introuvable" sans l'avoir fait.`
            });
          }
          // ⭐ Formulation sans ambiguïté (12/08/2026) — "success: true" + "non exécutée" dans le
          // même message se contredisaient, et Mistral Medium (contrairement à Small/Claude
          // Haiku/Sonnet, testés sur la même phrase) réagissait à cette contradiction en rappelant
          // le même executer_action à l'identique round après round au lieu de conclure, jusqu'à
          // épuiser MAX_TOOL_ROUNDS ("Trop d'appels d'outils enchaînés") — bug trouvé en creusant
          // ce comportement au comparatif. Le message doit affirmer sans détour que la vérification
          // est terminée avec succès, pas suggérer un échec à corriger.
          return JSON.stringify({ success: true, message: 'Action vérifiée avec succès — mode comparatif, aucune exécution réelle n\'a lieu par conception (ne pas retenter, c\'est terminé).', dryRun: true });
        }
        const reply = await this.executeDirect(params);
        return JSON.stringify(reply);
      }

      default:
        this.logger.warn('ToolExecutor', `Outil inconnu: ${call.function.name}`);
        return JSON.stringify({ error: `outil inconnu: ${call.function.name}` });
    }
  }

  /**
   * ⭐ 26/08/2026 — extrait de `execute()` (cas `executer_action` non-dryRun) pour être réutilisé
   * par le nouveau chemin déterministe (`interpreter/`, specs §16) : même corrélation
   * `ia:tool:execute` vers `planificateur`, que l'appel vienne d'un outil décidé par Mistral ou
   * d'une phrase reconnue localement sans lui.
   */
  async executeDirect(params: ExecuterActionParams): Promise<{ success: boolean; message: string }> {
    try {
      const reply = await this.toolExecuteRequester.request(params, this.toolExecuteTimeoutMs);
      return { success: reply.success, message: reply.message };
    } catch (error) {
      this.logger.error('ToolExecutor', `Timeout executer_action: ${error}`);
      return { success: false, message: 'planificateur ne répond pas' };
    }
  }
}

function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
