/**
 * Exécution des appels d'outils décidés par Mistral (specs §8).
 *  - lister_entites / obtenir_etat (lecture) : résolus localement via HaStructureRegistry, jamais
 *    de sollicitation de planificateur.
 *  - executer_action (action) : transmis à planificateur via ia:tool:execute (corrélation +
 *    timeout), qui résout l'intention en resolved_service_call et l'exécute (voir
 *    fonctionnelles-planificateur_specs §6/§7/§8).
 */

import type { HaStructureRegistry, Logger, IEventBus } from '../../../core/dist/exports';
import type { MistralToolCall, ExecuterActionParams, CorrelatedReponse } from './types';
import { CorrelatedRequester } from './correlation';

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
function resolveEntities(registry: HaStructureRegistry, quoi?: string, lieux?: string[]): Array<{ entity_id: string; state?: string; name?: string }> {
  const quoiId = quoi ? slugify(quoi) : undefined;
  const entities = registry.getEntitiesByQuoiAndLieux(quoiId, lieux ?? []);
  return entities.map((e) => ({ entity_id: e.entity_id, state: e.state, name: e.friendly_name }));
}

export class ToolExecutor {
  private readonly toolExecuteRequester: CorrelatedRequester<ExecuterActionParams, CorrelatedReponse>;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly registry: HaStructureRegistry | undefined,
    private readonly toolExecuteTimeoutMs: number
  ) {
    this.toolExecuteRequester = new CorrelatedRequester<ExecuterActionParams, CorrelatedReponse>(
      eventBus,
      'ia:tool:execute',
      'ia:tool:execute:reply'
    );
  }

  /** Exécute un appel d'outil et retourne le contenu à réinjecter en message role:tool. */
  async execute(call: MistralToolCall): Promise<string> {
    const args = typeof call.function.arguments === 'string'
      ? safeParse(call.function.arguments)
      : call.function.arguments;

    switch (call.function.name) {
      case 'lister_entites': {
        if (!this.registry) return JSON.stringify({ error: 'référentiel HA indisponible' });
        const entities = resolveEntities(this.registry, args?.quoi as string | undefined, args?.lieux as string[] | undefined);
        return JSON.stringify({ entities: entities.map((e) => ({ entity_id: e.entity_id, name: e.name })) });
      }

      case 'obtenir_etat': {
        if (!this.registry) return JSON.stringify({ error: 'référentiel HA indisponible' });
        const entities = resolveEntities(this.registry, args?.quoi as string | undefined, args?.lieux as string[] | undefined);
        return JSON.stringify({ entities });
      }

      case 'executer_action': {
        const params: ExecuterActionParams = {
          verbe: String(args?.verbe ?? ''),
          quoi: String(args?.quoi ?? ''),
          lieux: Array.isArray(args?.lieux) ? (args!.lieux as string[]) : [],
          valeur: args?.valeur as string | number | undefined
        };
        try {
          const reply = await this.toolExecuteRequester.request(params, this.toolExecuteTimeoutMs);
          return JSON.stringify({ success: reply.success, message: reply.message });
        } catch (error) {
          this.logger.error('ToolExecutor', `Timeout executer_action: ${error}`);
          return JSON.stringify({ success: false, message: 'planificateur ne répond pas' });
        }
      }

      default:
        this.logger.warn('ToolExecutor', `Outil inconnu: ${call.function.name}`);
        return JSON.stringify({ error: `outil inconnu: ${call.function.name}` });
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
