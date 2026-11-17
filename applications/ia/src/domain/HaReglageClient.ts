/**
 * Réglages des appareils Home Assistant (outils MCP `lire_reglages_appareil` et `modifier_reglage`, specs ia v1.43 §19.11decies).
 *
 * `executer_action` ne voit que les entités PRINCIPALES (taxonomie quoi/lieu) : les réglages qu'un appareil classe en
 * catégorie « configuration » (sensibilité d'un détecteur, mode de LED d'une prise, seuils…) lui échappent. Ces deux outils
 * les lisent et les modifient, par le registre et les services de HA (appel générique du cœur, seul détenteur du jeton).
 *
 * Garde-fous : seules les entités `entity_category: config` des domaines select / number / switch sont modifiables ;
 * la valeur est contrôlée (option existante, bornes et pas d'un nombre, marche/arrêt) ; sans `confirme: true`, aperçu
 * seulement ; l'aperçu donne la commande pour revenir à l'ancienne valeur.
 */

import type { HaBridgeClient } from '../../../core/dist/exports';

interface Appareil { id: string; name?: string | null; name_by_user?: string | null; model?: string | null; manufacturer?: string | null }
interface Entite { entity_id: string; device_id?: string | null; entity_category?: string | null; disabled_by?: string | null; name?: string | null; original_name?: string | null }
interface Etat { entity_id: string; state: string; attributes?: Record<string, unknown> }

export const DOMAINES_REGLAGE = ['select', 'number', 'switch'] as const;

/** Décrit un réglage (valeur actuelle et valeurs permises). */
function decrire(e: Entite, s: Etat | undefined): Record<string, unknown> {
  const a = s?.attributes ?? {};
  const domaine = e.entity_id.split('.')[0];
  const r: Record<string, unknown> = {
    entity_id: e.entity_id,
    nom: e.name ?? e.original_name ?? a.friendly_name ?? null,
    type: domaine,
    valeur: s?.state ?? null
  };
  if (domaine === 'select') r.options = a.options ?? [];
  if (domaine === 'number') { r.min = a.min; r.max = a.max; r.pas = a.step; if (a.unit_of_measurement) r.unite = a.unit_of_measurement; }
  if (domaine === 'switch') r.options = ['on', 'off'];
  if (s?.state === 'unavailable') r.remarque = 'indisponible (appareil injoignable)';
  return r;
}

/** Contrôle une valeur ; renvoie la valeur normalisée ou lève une erreur explicite. */
export function controlerValeur(domaine: string, s: Etat | undefined, valeur: unknown): string | number {
  const a = s?.attributes ?? {};
  if (domaine === 'select') {
    const options = Array.isArray(a.options) ? a.options.map(String) : [];
    const v = String(valeur);
    if (!options.includes(v)) throw new Error(`Valeur refusée : « ${v} » n'est pas une option (${options.join(', ')})`);
    return v;
  }
  if (domaine === 'number') {
    const v = typeof valeur === 'number' ? valeur : Number(String(valeur).replace(',', '.'));
    if (!Number.isFinite(v)) throw new Error(`Valeur refusée : « ${String(valeur)} » n'est pas un nombre`);
    const min = Number(a.min), max = Number(a.max), pas = Number(a.step);
    if (Number.isFinite(min) && v < min) throw new Error(`Valeur refusée : ${v} < minimum ${min}`);
    if (Number.isFinite(max) && v > max) throw new Error(`Valeur refusée : ${v} > maximum ${max}`);
    if (Number.isFinite(pas) && pas > 0 && Number.isFinite(min)) {
      const n = (v - min) / pas;
      if (Math.abs(n - Math.round(n)) > 1e-6) throw new Error(`Valeur refusée : ${v} ne tombe pas sur le pas de ${pas} (à partir de ${min})`);
    }
    return v;
  }
  if (domaine === 'switch') {
    const v = String(valeur).toLowerCase();
    if (['on', 'true', '1', 'marche'].includes(v)) return 'on';
    if (['off', 'false', '0', 'arrêt', 'arret'].includes(v)) return 'off';
    throw new Error(`Valeur refusée : « ${String(valeur)} » (on ou off attendu)`);
  }
  throw new Error(`Type non modifiable : ${domaine}`);
}

function normaliser(t: string): string {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export class HaReglageClient {
  constructor(private readonly ha: Pick<HaBridgeClient, 'callWs'>) {}

  private async charger(): Promise<{ appareils: Appareil[]; entites: Entite[]; etats: Etat[] }> {
    const [appareils, entites, etats] = await Promise.all([
      this.ha.callWs({ type: 'config/device_registry/list' }) as Promise<Appareil[]>,
      this.ha.callWs({ type: 'config/entity_registry/list' }) as Promise<Entite[]>,
      this.ha.callWs({ type: 'get_states' }) as Promise<Etat[]>
    ]);
    return { appareils, entites, etats };
  }

  /** Trouve l'appareil : device_id, entity_id d'une de ses entités, ou nom (exact, sinon partiel et unique). */
  private trouver(cible: string, appareils: Appareil[], entites: Entite[]): Appareil {
    const c = cible.trim();
    if (!c) throw new Error('cible manquante : device_id, entity_id d\'une entité de l\'appareil, ou nom de l\'appareil');
    const parId = appareils.find((d) => d.id === c);
    if (parId) return parId;
    const ent = entites.find((e) => e.entity_id === c);
    if (ent?.device_id) {
      const d = appareils.find((x) => x.id === ent.device_id);
      if (d) return d;
    }
    const n = normaliser(c);
    const nom = (d: Appareil) => normaliser(d.name_by_user ?? d.name ?? '');
    const exacts = appareils.filter((d) => nom(d) === n);
    if (exacts.length === 1) return exacts[0];
    const partiels = appareils.filter((d) => nom(d).includes(n));
    if (partiels.length === 1) return partiels[0];
    if (partiels.length > 1) {
      throw new Error(`Plusieurs appareils correspondent à « ${c} » : ${partiels.slice(0, 10).map((d) => `${d.name_by_user ?? d.name} (${d.id})`).join(' ; ')}`);
    }
    throw new Error(`Aucun appareil ne correspond à « ${c} »`);
  }

  async lire(cible: string): Promise<unknown> {
    const { appareils, entites, etats } = await this.charger();
    const d = this.trouver(cible, appareils, entites);
    const parId = new Map(etats.map((s) => [s.entity_id, s]));
    const siennes = entites.filter((e) => e.device_id === d.id && !e.disabled_by);
    const reglages = siennes
      .filter((e) => e.entity_category === 'config' && (DOMAINES_REGLAGE as readonly string[]).includes(e.entity_id.split('.')[0]))
      .map((e) => decrire(e, parId.get(e.entity_id)));
    const autres = siennes
      .filter((e) => e.entity_category === 'config' && !(DOMAINES_REGLAGE as readonly string[]).includes(e.entity_id.split('.')[0]))
      .map((e) => e.entity_id);
    return {
      appareil: { device_id: d.id, nom: d.name_by_user ?? d.name ?? null, modele: d.model ?? null, fabricant: d.manufacturer ?? null },
      reglages,
      ...(autres.length ? { non_modifiables: autres, note: 'réglages d\'un autre type (bouton, texte…) : non pris en charge par modifier_reglage' } : {})
    };
  }

  async modifier(entityId: string, valeur: unknown, confirme: boolean): Promise<unknown> {
    if (!entityId) throw new Error('entity_id manquant (voir lire_reglages_appareil)');
    if (valeur === undefined || valeur === null || valeur === '') throw new Error('valeur manquante');
    const domaine = entityId.split('.')[0];
    if (!(DOMAINES_REGLAGE as readonly string[]).includes(domaine)) throw new Error(`Seuls les réglages select, number et switch sont modifiables (ici : ${domaine})`);
    const { appareils, entites, etats } = await this.charger();
    const e = entites.find((x) => x.entity_id === entityId);
    if (!e) throw new Error(`Entité inconnue : ${entityId}`);
    if (e.entity_category !== 'config') {
      throw new Error(`${entityId} n'est pas un réglage de configuration (catégorie : ${e.entity_category ?? 'principale'}) : utiliser executer_action pour les entités principales`);
    }
    const s = etats.find((x) => x.entity_id === entityId);
    const v = controlerValeur(domaine, s, valeur);
    const d = appareils.find((x) => x.id === e.device_id);
    const avant = s?.state ?? null;
    const apercu = {
      appareil: d ? (d.name_by_user ?? d.name ?? d.id) : null,
      entity_id: entityId,
      avant,
      apres: v,
      annuler: avant !== null && avant !== 'unavailable' && avant !== 'unknown'
        ? `modifier_reglage entity_id=${entityId} valeur=${JSON.stringify(avant)} confirme=true`
        : 'ancienne valeur inconnue'
    };
    if (!confirme) return { apercu: true, ...apercu, note: 'Rien n\'a été modifié. Refaire l\'appel avec confirme:true après accord de l\'utilisateur.' };

    const message: Record<string, unknown> = { type: 'call_service', domain: domaine, target: { entity_id: entityId } };
    if (domaine === 'select') Object.assign(message, { service: 'select_option', service_data: { option: v } });
    if (domaine === 'number') Object.assign(message, { service: 'set_value', service_data: { value: v } });
    if (domaine === 'switch') Object.assign(message, { service: v === 'on' ? 'turn_on' : 'turn_off', service_data: {} });
    await this.ha.callWs(message);
    return {
      fait: true, ...apercu,
      note: 'Commande envoyée. Un appareil sur pile (détecteur…) ne la reçoit qu\'à son prochain réveil (mouvement, appui) : relire avec lire_reglages_appareil après.'
    };
  }
}
