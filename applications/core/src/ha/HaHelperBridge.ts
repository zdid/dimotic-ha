// src/ha/HaHelperBridge.ts
//
// Pont générique entre les apps en process séparé et deux capacités HA au-delà de la config REST
// (couverte par HaRestBridge) : le CRUD des "helpers" HA (timer, input_boolean...) — de vraies
// commandes WebSocket, voir HaWsClient.listHelpers/createHelper/deleteHelper — et une requête
// ponctuelle du référentiel d'entités structuré par domaine (photo initiale ; le suivi des
// nouvelles entités passe par l'événement générique déjà existant `ha:entity:updated`, pas par ce
// pont).
//
// Générique par construction, comme HaRestBridge : ce fichier ne connaît AUCUN nom d'app. Sens
// app→core automatique, sens core→app explicite via `<appId>:ha:helper:result` /
// `<appId>:ha:entities:list:result` déclarés dans le `bridgedEvents` de l'app intéressée.

import type { IEventBus } from '../application/IEventBus';
import type { HaWsClient } from './sync/HaWsClient';
import type { HaStructureRegistry } from './sync/HaStructureRegistry';
import type { Logger } from '../infrastructure/logger/index';
import { PILOTES_EVENTS } from '../pilotes/types';
import { entiteCorrespond, type PiloteRetraitDemande, type PiloteRetraitResultat } from '../pilotes/attenteRetraitHa';

export interface HaHelperRequest {
  appId: string;
  /** Généré par l'appelant, échoé tel quel dans la réponse — nécessaire car, contrairement à
   *  HaRestBridge (corrélé naturellement par l'id du script/automation ciblé), une app peut avoir
   *  plusieurs requêtes helper concurrentes sans identifiant commun (ex: une création par lumière
   *  manquante, en parallèle). */
  requestId: string;
  method: 'list' | 'create' | 'delete';
  domain: string;
  id?: string;
  data?: Record<string, unknown>;
}

export interface HaHelperResult {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface HaEntitiesListRequest {
  appId: string;
  domain: string;
}

export interface HaEntityTaxonomy {
  lieuPrecis?: string | null;
  lieuPrincipal?: string | null;
  lieuPere?: string | null;
  lieuGrandPere?: string | null;
}

export interface HaEntitiesListResult {
  domain: string;
  entities: Array<{ entity_id: string; name?: string; area_id?: string; quoiIds?: string[]; taxonomy?: HaEntityTaxonomy }>;
}

export class HaHelperBridge {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly haWsClient: HaWsClient | undefined,
    private readonly haStructureRegistry: HaStructureRegistry | undefined,
    private readonly logger: Logger
  ) {
    this.eventBus.onGeneric<HaHelperRequest>('ha:helper:request', (req) => {
      void this.handleHelperRequest(req);
    });
    this.eventBus.onGeneric<HaEntitiesListRequest>('ha:entities:list:request', (req) => {
      this.handleEntitiesListRequest(req);
    });
    this.eventBus.onGeneric<PiloteRetraitDemande>(PILOTES_EVENTS.HA_RETRAIT_DEMANDE, (req) => {
      void this.attendreRetrait(req);
    });
  }

  private async handleHelperRequest(req: HaHelperRequest): Promise<void> {
    const replyEvent = `${req.appId}:ha:helper:result`;

    if (!this.haWsClient) {
      this.eventBus.emitGeneric<HaHelperResult>(replyEvent, { requestId: req.requestId, success: false, error: 'HA non connecté' });
      return;
    }

    try {
      let result: unknown;
      if (req.method === 'list') {
        result = await this.haWsClient.listHelpers(req.domain);
      } else if (req.method === 'create') {
        result = await this.haWsClient.createHelper(req.domain, req.data ?? {});
      } else {
        if (!req.id) throw new Error('id requis pour delete');
        await this.haWsClient.deleteHelper(req.domain, req.id);
      }
      this.eventBus.emitGeneric<HaHelperResult>(replyEvent, { requestId: req.requestId, success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('HaHelperBridge', `Échec ${req.method} helper ${req.domain} pour ${req.appId}: ${message}`);
      this.eventBus.emitGeneric<HaHelperResult>(replyEvent, { requestId: req.requestId, success: false, error: message });
    }
  }

  private handleEntitiesListRequest(req: HaEntitiesListRequest): void {
    const replyEvent = `${req.appId}:ha:entities:list:result`;

    if (!this.haStructureRegistry) {
      this.eventBus.emitGeneric<HaEntitiesListResult>(replyEvent, { domain: req.domain, entities: [] });
      return;
    }

    const entities = this.haStructureRegistry
      .getAllEntities()
      .filter((e) => e.domain === req.domain)
      .map((e) => {
        // attributs_taxonomie posé par TaxonomyHaClassifier (toujours présent après classify(),
        // au moins sous forme "virtuelle" — voir TaxonomyHaClassifier.ts) — type non exporté,
        // lu ici en générique plutôt que dupliquer l'interface interne.
        const t = e.attributes?.attributs_taxonomie as
          | { lieu_precis?: string | null; lieu_principal?: string | null; lieu_pere?: string | null; lieu_grand_pere?: string | null }
          | undefined;
        return {
          entity_id: e.entity_id,
          name: e.friendly_name,
          area_id: e.area_id,
          quoiIds: e.quoi_ids,
          taxonomy: t
            ? { lieuPrecis: t.lieu_precis, lieuPrincipal: t.lieu_principal, lieuPere: t.lieu_pere, lieuGrandPere: t.lieu_grand_pere }
            : undefined
        };
      });

    this.eventBus.emitGeneric<HaEntitiesListResult>(replyEvent, { domain: req.domain, entities });
  }

  /**
   * ⭐ 16/10/2026 — remplacement d'un capteur/récepteur : HA doit avoir SUPPRIMÉ l'ancienne entité avant que le pilote ne
   * crée la neuve (sinon HA suffixe `_2`). Attend (sondage 500 ms) que plus aucune entité ne porte les noms donnés.
   */
  private async attendreRetrait(req: PiloteRetraitDemande): Promise<void> {
    const debut = Date.now();
    const delai = Math.min(Math.max(req.delaiMs ?? 20000, 1000), 120000);
    const restantes = (): string[] =>
      (this.haStructureRegistry?.getAllEntities() ?? [])
        .filter((e) => req.noms.some((n) => entiteCorrespond(n, e.friendly_name)))
        .map((e) => e.entity_id);

    let presentes = this.haStructureRegistry ? restantes() : [];
    const vuAuDepart = presentes.length > 0;
    if (!vuAuDepart) await new Promise((r) => setTimeout(r, 1500)); // rien reconnu : courte marge pour le message déjà en vol
    else while (presentes.length > 0 && Date.now() - debut < delai) {
      await new Promise((r) => setTimeout(r, 500));
      presentes = restantes();
    }
    const resultat: PiloteRetraitResultat = {
      appId: req.appId,
      requestId: req.requestId,
      absent: presentes.length === 0,
      vuAuDepart,
      attenteMs: Date.now() - debut,
      restantes: presentes
    };
    this.eventBus.emitGeneric(PILOTES_EVENTS.HA_RETRAIT_RESULTAT, resultat);
  }
}
