/**
 * Pièces (areas) de Home Assistant pour les outils MCP `lire_pieces_ha`, `affecter_piece_ha`, `renommer_piece_ha` et
 * `supprimer_pieces_vides_ha` — par les commandes WebSocket `config/area_registry|device_registry|entity_registry/…`
 * via l'appel générique du cœur (jeton administrateur requis).
 *
 * Garde-fous : sans `confirme: true`, aperçu seulement ; la première lettre d'un nom de pièce est toujours mise en
 * majuscule (comme le fait le cœur pour les pièces issues de `nommage`) ; une pièce supprimée est sauvegardée dans
 * data/ia/pieces-backups/ ; seules les pièces VIDES (aucun appareil, aucune entité) se suppriment.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HaBridgeClient } from '../../../core/dist/exports';

type Ws = Pick<HaBridgeClient, 'callWs'>;

interface Piece { area_id: string; name: string; picture?: string | null; aliases?: string[]; floor_id?: string | null; icon?: string | null; labels?: string[] }
interface Appareil { id: string; name?: string | null; name_by_user?: string | null; area_id?: string | null }
interface Entite { entity_id: string; area_id?: string | null; device_id?: string | null }

/** Même règle que le cœur (IntegrationBridge.capitalizeAreaName). */
export function majuscule(nom: string): string {
  const t = nom.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function norm(texte: string): string {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export class HaPieceClient {
  private readonly backupDir: string;

  constructor(
    private readonly ha: Ws,
    dataDir: string,
    private readonly automatisationsCitant: (texte: string) => Promise<string[]> = async () => []
  ) {
    this.backupDir = path.join(dataDir, 'pieces-backups');
  }

  private ws<T = unknown>(message: Record<string, unknown>): Promise<T> {
    return this.ha.callWs(message, 30000) as Promise<T>;
  }

  private async charger(): Promise<{ pieces: Piece[]; appareils: Appareil[]; entites: Entite[] }> {
    const [pieces, appareils, entites] = await Promise.all([
      this.ws<Piece[]>({ type: 'config/area_registry/list' }),
      this.ws<Appareil[]>({ type: 'config/device_registry/list' }),
      this.ws<Entite[]>({ type: 'config/entity_registry/list' })
    ]);
    return { pieces, appareils, entites };
  }

  /** Retrouve une pièce par area_id, sinon par nom (insensible à la casse et aux accents). */
  private trouver(pieces: Piece[], ref: string): Piece | undefined {
    return pieces.find((p) => p.area_id === ref) ?? pieces.find((p) => norm(p.name) === norm(ref));
  }

  private compter(pieces: Piece[], appareils: Appareil[], entites: Entite[]) {
    return pieces.map((p) => {
      const nbAppareils = appareils.filter((d) => d.area_id === p.area_id).length;
      const nbEntites = entites.filter((e) => e.area_id === p.area_id).length;
      return { area_id: p.area_id, nom: p.name, appareils: nbAppareils, entites_affectees: nbEntites, vide: nbAppareils === 0 && nbEntites === 0 };
    });
  }

  async lire(): Promise<unknown> {
    const { pieces, appareils, entites } = await this.charger();
    const liste = this.compter(pieces, appareils, entites).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
    return { total: liste.length, vides: liste.filter((p) => p.vide).length, pieces: liste };
  }

  // --- affecter ---------------------------------------------------------------------------------------------------

  /** `entites` : entity_id à affecter ; `appareils` : device_id. `piece` = nom ou area_id ; "" = retirer l'affectation directe. */
  async affecter(entitesIds: string[], appareilsIds: string[], piece: string, confirme: boolean): Promise<unknown> {
    if (!entitesIds.length && !appareilsIds.length) throw new Error('Donner « entites » (entity_id) et/ou « appareils » (device_id)');
    if (entitesIds.length + appareilsIds.length > 100) throw new Error('100 cibles au plus par appel');
    const { pieces, appareils, entites } = await this.charger();
    const existante = piece === '' ? undefined : this.trouver(pieces, piece);
    const aCreer = piece !== '' && !existante ? majuscule(piece) : undefined;

    const lignes: Array<{ cible: string; type: 'entite' | 'appareil'; avant: string | null; apres: string | null }> = [];
    const nom = (areaId?: string | null): string | null => (areaId ? pieces.find((p) => p.area_id === areaId)?.name ?? areaId : null);
    for (const id of entitesIds) {
      const e = entites.find((x) => x.entity_id === id);
      if (!e) throw new Error(`Entité « ${id} » absente du registre de HA`);
      lignes.push({ cible: id, type: 'entite', avant: nom(e.area_id), apres: piece === '' ? '(pièce de son appareil)' : existante?.name ?? aCreer ?? null });
    }
    for (const id of appareilsIds) {
      const d = appareils.find((x) => x.id === id);
      if (!d) throw new Error(`Appareil « ${id} » inconnu`);
      lignes.push({ cible: `${d.name_by_user ?? d.name ?? id} (${id})`, type: 'appareil', avant: nom(d.area_id), apres: piece === '' ? null : existante?.name ?? aCreer ?? null });
    }
    const apercu = {
      action: 'affecter',
      piece: existante?.name ?? aCreer ?? '(aucune)',
      creation_de_la_piece: aCreer ?? null,
      changements: lignes,
      avertissement: "nommage recalcule les pièces depuis le nom (quoi---lieu) à la création d'un appareil : une affectation manuelle contraire au nom peut être écrasée ; pour un changement durable, modifier aussi le lieu du nom (pilotes_modifier)"
    };
    if (!confirme) return { effectue: false, ...apercu, message: "AUCUNE modification faite. Montre cet aperçu à l'utilisateur, puis rappelle l'outil avec confirme: true seulement après son accord explicite." };

    let areaId = existante?.area_id ?? null;
    if (aCreer) areaId = (await this.ws<Piece>({ type: 'config/area_registry/create', name: aCreer })).area_id;
    for (const id of entitesIds) await this.ws({ type: 'config/entity_registry/update', entity_id: id, area_id: piece === '' ? null : areaId });
    for (const id of appareilsIds) await this.ws({ type: 'config/device_registry/update', device_id: id, area_id: piece === '' ? null : areaId });
    return { effectue: true, ...apercu, annuler: 'réaffecter chaque cible à sa pièce « avant » (affecter_piece_ha)' };
  }

  // --- renommer ---------------------------------------------------------------------------------------------------

  async renommer(ref: string, nouveauNom: string, confirme: boolean): Promise<unknown> {
    const nom = majuscule(nouveauNom);
    if (!nom) throw new Error('« nouveau_nom » vide');
    const { pieces, appareils, entites } = await this.charger();
    const p = this.trouver(pieces, ref);
    if (!p) throw new Error(`Pièce « ${ref} » inconnue (lire_pieces_ha)`);
    const doublon = pieces.find((x) => x.area_id !== p.area_id && norm(x.name) === norm(nom));
    if (doublon) throw new Error(`Une pièce « ${doublon.name} » existe déjà : pour les fusionner, affecter les entités puis supprimer la pièce vide`);
    const citations = await this.automatisationsCitant(p.area_id);
    const apercu = {
      action: 'renommer',
      avant: p.name,
      apres: nom,
      area_id: `${p.area_id} (inchangé : HA garde l'identifiant)`,
      contenu: this.compter([p], appareils, entites)[0],
      automatisationsCitantLaPiece: citations,
      avertissement: `nommage recrée une pièce « ${p.name} » dès qu'un nom d'appareil porte encore ce lieu : modifier aussi le lieu des noms concernés (pilotes_modifier), sinon l'ancienne pièce réapparaît`,
      annuler: `renommer_piece_ha piece=${p.area_id} nouveau_nom=${JSON.stringify(p.name)} confirme=true`
    };
    if (!confirme) return { effectue: false, ...apercu, message: "AUCUNE modification faite. Montre cet aperçu à l'utilisateur, puis rappelle l'outil avec confirme: true seulement après son accord explicite." };
    await this.ws({ type: 'config/area_registry/update', area_id: p.area_id, name: nom });
    return { effectue: true, ...apercu };
  }

  // --- supprimer les pièces vides ---------------------------------------------------------------------------------

  /** `refs` absent = toutes les pièces vides ; sinon seulement celles-ci (refusées si non vides). */
  async supprimerVides(refs: string[] | undefined, confirme: boolean): Promise<unknown> {
    const { pieces, appareils, entites } = await this.charger();
    const comptes = this.compter(pieces, appareils, entites);
    let cibles = comptes.filter((c) => c.vide);
    if (refs?.length) {
      cibles = [];
      for (const ref of refs) {
        const p = this.trouver(pieces, ref);
        if (!p) throw new Error(`Pièce « ${ref} » inconnue`);
        const c = comptes.find((x) => x.area_id === p.area_id)!;
        if (!c.vide) throw new Error(`La pièce « ${p.name} » n'est pas vide (${c.appareils} appareil(s), ${c.entites_affectees} entité(s)) : refusé`);
        cibles.push(c);
      }
    }
    const citations: Record<string, string[]> = {};
    for (const c of cibles) {
      const cit = await this.automatisationsCitant(c.area_id);
      if (cit.length) citations[c.nom] = cit;
    }
    const apercu = {
      action: 'supprimer les pièces vides',
      a_supprimer: cibles.map((c) => ({ area_id: c.area_id, nom: c.nom })),
      automatisationsCitantCesPieces: citations,
      note: 'Seules des pièces SANS appareil ni entité sont supprimées. Leur définition est sauvegardée avant (data/ia/pieces-backups/).'
    };
    if (!cibles.length) return { effectue: false, ...apercu, message: 'Aucune pièce vide.' };
    if (!confirme) return { effectue: false, ...apercu, message: "AUCUNE modification faite. Montre cet aperçu à l'utilisateur, puis rappelle l'outil avec confirme: true seulement après son accord explicite." };

    fs.mkdirSync(this.backupDir, { recursive: true });
    const sauvegarde = `pieces__${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(this.backupDir, sauvegarde), JSON.stringify(pieces.filter((p) => cibles.some((c) => c.area_id === p.area_id)), null, 2), 'utf8');
    for (const c of cibles) await this.ws({ type: 'config/area_registry/delete', area_id: c.area_id });
    return { effectue: true, ...apercu, sauvegarde };
  }
}
