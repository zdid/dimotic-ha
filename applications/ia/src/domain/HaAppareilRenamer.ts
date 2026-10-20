/**
 * Renommage d'un APPAREIL Home Assistant (outil MCP `renommer_appareil_ha`) : `name_by_user` par la commande WebSocket
 * `config/device_registry/update` (appel générique du cœur, seul détenteur du jeton HA).
 *
 * Le nom doit suivre la convention `quoi---[précis--]lieu[--père[--grand-père]]`. Garde-fous : sans `confirme: true` rien n'est
 * modifié (aperçu) ; un appareil déjà classé par NOMMAGE (une de ses entités porte `attributs_taxonomie`) est refusé : son nom vient de
 * la découverte MQTT. Le renommage ne change PAS les entity_id existants (HA ne les recalcule pas) : l'aperçu le rappelle.
 */

import type { HaBridgeClient } from '../../../core/dist/exports';
import { suitLaConvention } from './HaAuditNomsClient';

interface Appareil { id: string; name?: string | null; name_by_user?: string | null; area_id?: string | null }
interface Entite { entity_id: string; device_id?: string | null }

/** Problèmes d'un nom d'appareil (liste vide = valide). */
export function problemesNom(nom: string): string[] {
  const erreurs: string[] = [];
  if (!suitLaConvention(nom)) erreurs.push('le nom doit suivre quoi---[précis--]lieu[--père[--grand-père]] (QUOI, « --- », au moins un lieu)');
  if (/["\\/#+]/.test(nom)) erreurs.push('caractère interdit dans le nom (" \\ / # +)');
  const i = nom.indexOf('---');
  if (i >= 0) {
    const quoi = nom.slice(0, i).trim();
    const segments = nom.slice(i + 3).split('--');
    if (quoi.includes('--')) erreurs.push('le QUOI contient « -- »');
    if (segments.length > 4) erreurs.push('quatre lieux au plus (précis, lieu, père, grand-père)');
    if (segments.some((s) => s.trim() === '')) erreurs.push('un lieu est vide');
    if (segments.some((s) => /^-|-$/.test(s.trim()))) erreurs.push('un lieu commence ou finit par un tiret');
  }
  return erreurs;
}

export class HaAppareilRenamer {
  constructor(private readonly ha: Pick<HaBridgeClient, 'callWs'>) {}

  async renommer(deviceId: string, nom: string, confirme: boolean): Promise<unknown> {
    const nouveau = nom.trim();
    if (!deviceId) throw new Error('device_id manquant (voir auditer_noms_ha)');
    const problemes = problemesNom(nouveau);
    if (problemes.length) throw new Error(`Nom refusé : ${problemes.join(' ; ')}`);

    const [appareils, entites, etats] = await Promise.all([
      this.ha.callWs({ type: 'config/device_registry/list' }) as Promise<Appareil[]>,
      this.ha.callWs({ type: 'config/entity_registry/list' }) as Promise<Entite[]>,
      this.ha.callWs({ type: 'get_states' }) as Promise<Array<{ entity_id: string; attributes?: Record<string, unknown> }>>
    ]);
    const appareil = appareils.find((d) => d.id === deviceId);
    if (!appareil) throw new Error(`Appareil inconnu : ${deviceId}`);
    const miennes = entites.filter((e) => e.device_id === deviceId).map((e) => e.entity_id);
    const classe = etats.some((s) => miennes.includes(s.entity_id) && s.attributes && typeof s.attributes.attributs_taxonomie === 'object');
    if (classe) throw new Error('Appareil déjà classé par NOMMAGE (taxonomie présente) : son nom vient de la découverte MQTT, à changer à la source (nom dans l\'appareil)');

    const apercu = {
      avant: { device_id: deviceId, nom: appareil.name_by_user ?? appareil.name ?? null, nom_par_utilisateur: appareil.name_by_user ?? null },
      apres: { nom: nouveau },
      entites: miennes.length,
      avertissement: 'Les entity_id existants ne changent pas (les noms affichés oui) : renommer_entite_ha après verifier_entity_ids si besoin',
      annuler: `renommer_appareil_ha device_id=${deviceId} nom=${JSON.stringify(appareil.name_by_user ?? '')} confirme=true (nom vide = nom d'origine)`
    };
    if (!confirme) return { apercu: true, ...apercu, note: 'Rien n\'a été modifié. Refaire l\'appel avec confirme:true après accord de l\'utilisateur.' };

    await this.ha.callWs({ type: 'config/device_registry/update', device_id: deviceId, name_by_user: nouveau });
    return { fait: true, ...apercu };
  }
}
