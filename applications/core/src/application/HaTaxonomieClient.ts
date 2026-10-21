/**
 * HaTaxonomieClient — lecture de la taxonomie « quoi / où » directement dans Home Assistant, par l'intégration
 * `dimotic_taxonomie` (dépôt dimotic-ha-taxonomie), au lieu du registre du cœur (conception-applications-vers-ha).
 *
 * Les commandes passent par `callWs` du `HaBridgeClient` : c'est le cœur qui parle à HA avec son jeton, l'application
 * n'en reçoit aucun. Les réponses sont converties à la volée en `HaStructuredEntity`, le format que les applications
 * connaissent déjà (aucune autre modification dans leur code que `await`). Pas de repli : si HA ou l'intégration ne
 * répond pas, l'appel échoue avec un message qui le dit.
 */

import type { HaStructuredEntity, HaQuoiDefinition } from '../ha/types/index';

/** Ce dont le client a besoin : `HaBridgeClient` le fournit. */
export interface HaTaxonomieTransport {
  callWs(message: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** Entité telle que la renvoie l'intégration (spec conception-integration-taxonomie-ha §6.3). */
export interface EntiteTaxonomie {
  entity_id: string;
  friendly_name: string;
  domaine: string;
  device_class: string | null;
  etat: string;
  attributs?: Record<string, unknown>;
  derniere_modification?: string | null;
  device_id: string | null;
  appareil?: string | null;
  area_id: string | null;
  piece: string | null;
  plateforme: string | null;
  entity_category: string | null;
  hidden_by: string | null;
  disabled_by: string | null;
  quoi_ids: string[];
}

const P = 'dimotic_taxonomie/';

/** Conversion à la volée d'une entité de l'intégration vers le format du cœur (sans les références circulaires). */
export function versEntiteDuCoeur(e: EntiteTaxonomie): HaStructuredEntity {
  return {
    entity_id: e.entity_id,
    friendly_name: e.friendly_name,
    domain: e.domaine as HaStructuredEntity['domain'],
    device_class: (e.device_class ?? undefined) as HaStructuredEntity['device_class'],
    state: e.etat,
    attributes: e.attributs ?? {},
    device_id: e.device_id ?? undefined,
    area_id: e.area_id ?? undefined,
    entity_category: e.entity_category,
    hidden_by: e.hidden_by,
    disabled_by: e.disabled_by,
    platform: e.plateforme ?? undefined,
    quoi_ids: e.quoi_ids ?? [],
    last_updated: new Date(e.derniere_modification ?? 0),
    device: e.device_id ? { device_id: e.device_id, name: e.appareil ?? undefined } : undefined,
    area: e.area_id ? { area_id: e.area_id, name: e.piece ?? undefined } : undefined
  };
}

export class HaTaxonomieClient {
  constructor(private readonly transport: HaTaxonomieTransport) {}

  private async appeler<T>(commande: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await this.transport.callWs({ type: P + commande, ...args })) as T;
    } catch (err) {
      const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
      throw new Error(`Taxonomie Home Assistant indisponible (${commande}) : ${detail} — l'intégration dimotic_taxonomie est-elle installée et HA joignable ?`);
    }
  }

  async getEntity(entityId: string): Promise<HaStructuredEntity | undefined> {
    const e = await this.appeler<EntiteTaxonomie | null>('entite', { entity_id: entityId });
    return e ? versEntiteDuCoeur(e) : undefined;
  }

  /** Toutes les entités, techniques comprises (comme `HaBridgeClient.getAllEntities`) ; `domaine` : un seul domaine HA. */
  async getAllEntities(domaine?: string): Promise<HaStructuredEntity[]> {
    const r = await this.appeler<{ entites: EntiteTaxonomie[] }>('entites', { inclure_techniques: true, ...(domaine ? { domaine } : {}) });
    return (r.entites ?? []).map(versEntiteDuCoeur);
  }

  async getEntitiesByQuoiAndLieux(quoi: string | undefined, lieux: string[], includeTechnical = false): Promise<HaStructuredEntity[]> {
    const r = await this.appeler<{ entites: EntiteTaxonomie[] }>('chercher', {
      ...(quoi ? { quoi } : {}), lieux, inclure_techniques: includeTechnical
    });
    return (r.entites ?? []).map(versEntiteDuCoeur);
  }

  async getQuoiCatalog(): Promise<HaQuoiDefinition[]> {
    return this.appeler<HaQuoiDefinition[]>('catalogue_quoi');
  }

  async getLieuCatalog(excludedQuoiIds?: Iterable<string>): Promise<string[]> {
    return this.appeler<string[]>('catalogue_lieux', { quoi_exclus: [...(excludedQuoiIds ?? [])] });
  }
}
