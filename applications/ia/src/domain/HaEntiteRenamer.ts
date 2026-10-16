/**
 * Renommage d'une entité Home Assistant (outil MCP `renommer_entite_ha`) : nouvel `entity_id` et/ou nom affiché, par la
 * commande WebSocket `config/entity_registry/update` (appel générique du cœur, seul détenteur du jeton HA).
 *
 * Garde-fous : sans `confirme: true` rien n'est modifié (aperçu : état actuel, identifiant libre ou pris, ce qui reste à
 * corriger) ; la commande inverse est renvoyée pour annuler. HA ne réécrit PAS les références (automatisations, tableaux
 * de bord, scripts) : l'aperçu le rappelle et liste les automatisations qui citent l'ancien identifiant.
 */

import type { HaBridgeClient } from '../../../core/dist/exports';

interface EntreeRegistre { entity_id: string; name?: string | null; original_name?: string | null; platform?: string; disabled_by?: string | null }

const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;

export class HaEntiteRenamer {
  constructor(
    private readonly ha: Pick<HaBridgeClient, 'callWs'>,
    private readonly automatisationsCitant: (entityId: string) => Promise<string[]> = async () => []
  ) {}

  async renommer(entityId: string, nouvelEntityId: string | undefined, nom: string | undefined, confirme: boolean): Promise<unknown> {
    if (!ENTITY_ID.test(entityId)) throw new Error(`entity_id invalide : « ${entityId} »`);
    if (nouvelEntityId === undefined && nom === undefined) throw new Error('Donner « nouvel_entity_id » et/ou « nom »');
    if (nouvelEntityId !== undefined) {
      if (!ENTITY_ID.test(nouvelEntityId)) throw new Error(`nouvel_entity_id invalide : « ${nouvelEntityId} »`);
      if (nouvelEntityId.split('.')[0] !== entityId.split('.')[0]) throw new Error('Le domaine (avant le point) ne peut pas changer');
    }

    let actuel: EntreeRegistre;
    try {
      actuel = (await this.ha.callWs({ type: 'config/entity_registry/get', entity_id: entityId })) as EntreeRegistre;
    } catch (e) {
      throw new Error(`« ${entityId} » n'est pas dans le registre des entités de HA (entité sans unique_id, non renommable) : ${e instanceof Error ? e.message : String(e)}`);
    }

    let identifiantPris = false;
    if (nouvelEntityId !== undefined && nouvelEntityId !== entityId) {
      try {
        await this.ha.callWs({ type: 'config/entity_registry/get', entity_id: nouvelEntityId });
        identifiantPris = true;
      } catch { /* introuvable = libre */ }
    }

    const citations = nouvelEntityId && nouvelEntityId !== entityId ? await this.automatisationsCitant(entityId) : [];
    const apercu = {
      avant: { entity_id: actuel.entity_id, nom: actuel.name ?? null, nom_d_origine: actuel.original_name ?? null, plateforme: actuel.platform },
      apres: { entity_id: nouvelEntityId ?? entityId, ...(nom !== undefined ? { nom: nom === '' ? null : nom } : {}) },
      identifiantLibre: !identifiantPris,
      ...(identifiantPris ? { blocage: `« ${nouvelEntityId} » existe déjà : supprimer d'abord l'entité qui le porte (sinon HA refuse)` } : {}),
      automatisationsCitantAncienIdentifiant: citations,
      avertissement: nouvelEntityId && nouvelEntityId !== entityId
        ? "HA ne réécrit pas les références : automatisations, scripts, scènes et tableaux de bord qui citent l'ancien entity_id sont à corriger"
        : undefined,
      annuler: `renommer_entite_ha entity_id=${nouvelEntityId ?? entityId}${nouvelEntityId ? ` nouvel_entity_id=${entityId}` : ''}${nom !== undefined ? ` nom=${JSON.stringify(actuel.name ?? '')}` : ''} confirme=true`
    };
    if (!confirme) return { apercu: true, ...apercu, note: 'Rien n\'a été modifié. Refaire l\'appel avec confirme:true après accord de l\'utilisateur.' };
    if (identifiantPris) throw new Error(`« ${nouvelEntityId} » existe déjà dans HA : renommage refusé`);

    const resultat = (await this.ha.callWs({
      type: 'config/entity_registry/update',
      entity_id: entityId,
      ...(nouvelEntityId !== undefined ? { new_entity_id: nouvelEntityId } : {}),
      ...(nom !== undefined ? { name: nom === '' ? null : nom } : {})
    })) as { entity_entry?: EntreeRegistre; require_restart?: boolean };
    return { fait: true, ...apercu, entite: resultat.entity_entry ? { entity_id: resultat.entity_entry.entity_id, nom: resultat.entity_entry.name ?? null } : undefined };
  }
}
