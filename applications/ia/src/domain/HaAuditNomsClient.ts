/**
 * Audit des noms de HA (lecture seule) pour l'outil MCP `auditer_noms_ha` — par les commandes WebSocket `config/device_registry|
 * entity_registry|area_registry/list` via l'appel générique du cœur. Deux constats :
 *  - `horsConvention` : appareils SANS taxonomie (aucune de leurs entités ne porte l'attribut `attributs_taxonomie` posé par NOMMAGE) et dont
 *    le nom ne suit pas `quoi---[précis--]lieu[--père[--grand-père]]` — avec la pièce actuelle et une suggestion de nom à affiner avec
 *    l'utilisateur. (Le nom d'un appareil passé par NOMMAGE est raccourci dans HA : sa convention est dans la taxonomie, pas dans le nom.)
 *  - `identifiantsDecales` : entités dont l'`entity_id` commence par le nom d'une pièce (la forme fabriquée par HA : `<pièce>_<nom>`) qui
 *    n'est PLUS leur pièce actuelle (appareil déplacé depuis), avec l'identifiant qu'on aurait aujourd'hui. Seules les entités RATTACHÉES À UN
 *    APPAREIL sont examinées (HA ne préfixe par la pièce que celles-là : automatisations, scripts et aides n'ont pas de pièce).
 * Rien n'est modifié. Renommer : `renommer_entite_ha` (identifiant) après `verifier_entity_ids` (références).
 */

import type { HaBridgeClient } from '../../../core/dist/exports';

type Ws = Pick<HaBridgeClient, 'callWs'>;

interface Piece { area_id: string; name: string }
interface Appareil { id: string; name?: string | null; name_by_user?: string | null; area_id?: string | null; entry_type?: string | null; disabled_by?: string | null; manufacturer?: string | null; model?: string | null }
interface Entite { entity_id: string; device_id?: string | null; area_id?: string | null; disabled_by?: string | null; hidden_by?: string | null; platform?: string; entity_category?: string | null }

export interface HorsConvention { device_id: string; nom: string; fabricant: string | null; modele: string | null; piece: string | null; entites: number; plateformes: string[]; suggestion: string | null }
export interface IdentifiantDecale { entity_id: string; piece_dans_identifiant: string; piece_actuelle: string | null; attendu: string; attendu_deja_pris: boolean }

/** Slug d'identifiant HA : sans accents, minuscules, tout bloc non alphanumérique devient `_`. */
export function slug(texte: string): string {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Le nom suit-il la convention (au moins un QUOI, `---` et un lieu) ? */
export function suitLaConvention(nom: string): boolean {
  const i = nom.indexOf('---');
  if (i < 0) return false;
  return nom.slice(0, i).trim() !== '' && nom.slice(i + 3).split('--').some((s) => s.trim() !== '');
}

export class HaAuditNomsClient {
  constructor(private readonly ha: Ws) {}

  private ws<T = unknown>(message: Record<string, unknown>): Promise<T> {
    return this.ha.callWs(message, 30000) as Promise<T>;
  }

  async auditer(portee: 'appareils' | 'identifiants' | 'tous' = 'tous', limite = 40): Promise<unknown> {
    const brutPieces = await this.ws<Piece[] | { areas: Piece[] }>({ type: 'config/area_registry/list' });
    const pieces = Array.isArray(brutPieces) ? brutPieces : brutPieces.areas ?? [];
    const [appareils, entites, etats] = await Promise.all([
      this.ws<Appareil[]>({ type: 'config/device_registry/list' }),
      this.ws<Entite[]>({ type: 'config/entity_registry/list' }),
      this.ws<Array<{ entity_id: string; attributes?: Record<string, unknown> }>>({ type: 'get_states' })
    ]);
    const avecTaxonomie = new Set((Array.isArray(etats) ? etats : []).filter((s) => s.attributes && typeof s.attributes.attributs_taxonomie === 'object').map((s) => s.entity_id));
    const nomPiece = (areaId?: string | null): string | null => (areaId ? pieces.find((p) => p.area_id === areaId)?.name ?? null : null);
    const actives = entites.filter((e) => !e.disabled_by);

    // --- appareils hors convention -------------------------------------------------------------------------------
    const horsConvention: HorsConvention[] = [];
    let appareilsExamines = 0;
    for (const d of appareils) {
      if (d.entry_type === 'service' || d.disabled_by) continue;
      const mesEntites = actives.filter((e) => e.device_id === d.id);
      if (!mesEntites.length) continue;
      appareilsExamines++;
      const nom = (d.name_by_user ?? d.name ?? '').trim();
      if (suitLaConvention(nom) || mesEntites.some((e) => avecTaxonomie.has(e.entity_id))) continue;
      const piece = nomPiece(d.area_id);
      horsConvention.push({
        device_id: d.id,
        nom: nom || '(sans nom)',
        fabricant: d.manufacturer ?? null,
        modele: d.model ?? null,
        piece,
        entites: mesEntites.length,
        plateformes: [...new Set(mesEntites.map((e) => e.platform ?? '?'))].sort(),
        suggestion: nom && piece ? `${nom}---${piece.toLowerCase()}` : null
      });
    }
    horsConvention.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

    // --- identifiants décalés ------------------------------------------------------------------------------------
    const tousIds = new Set(entites.map((e) => e.entity_id));
    const slugsPieces = pieces.map((p) => ({ piece: p, s: slug(p.name) })).filter((x) => x.s).sort((a, b) => b.s.length - a.s.length);
    const decales: IdentifiantDecale[] = [];
    for (const e of actives) {
      if (!e.device_id) continue; // pas d'appareil : HA ne préfixe pas l'identifiant par une pièce
      const d = appareils.find((x) => x.id === e.device_id);
      const areaActuelle = e.area_id ?? d?.area_id ?? null;
      const point = e.entity_id.indexOf('.');
      const domaine = e.entity_id.slice(0, point), objet = e.entity_id.slice(point + 1);
      const prefixe = slugsPieces.find((x) => objet.startsWith(`${x.s}_`));
      if (!prefixe || prefixe.piece.area_id === areaActuelle) continue;
      const reste = objet.slice(prefixe.s.length + 1);
      const actuelle = areaActuelle ? pieces.find((p) => p.area_id === areaActuelle) : undefined;
      const attendu = `${domaine}.${actuelle ? `${slug(actuelle.name)}_` : ''}${reste}`;
      decales.push({ entity_id: e.entity_id, piece_dans_identifiant: prefixe.piece.name, piece_actuelle: actuelle?.name ?? null, attendu, attendu_deja_pris: tousIds.has(attendu) });
    }
    decales.sort((a, b) => a.entity_id.localeCompare(b.entity_id));

    const voir = (liste: unknown[]) => liste.slice(0, Math.max(1, Math.min(limite, 200)));
    const resultat: Record<string, unknown> = {
      lectureSeule: true,
      resume: { appareilsExamines, horsConvention: horsConvention.length, identifiantsDecales: decales.length },
      note: "Aucune modification. Pour un nom d'appareil hors convention : proposer un nom quoi---[précis--]lieu à l'utilisateur ; pour un identifiant décalé : verifier_entity_ids (références) puis renommer_entite_ha avec confirme."
    };
    if (portee !== 'identifiants') resultat.horsConvention = voir(horsConvention);
    if (portee !== 'appareils') resultat.identifiantsDecales = voir(decales);
    if (horsConvention.length > limite || decales.length > limite) resultat.tronque = `listes limitées à ${limite} lignes (paramètre « limite », 200 au plus)`;
    return resultat;
  }
}
