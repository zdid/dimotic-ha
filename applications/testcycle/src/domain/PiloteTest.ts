/**
 * PiloteTest — pilote FACTICE de testcycle pour éprouver le canal « gestion des pilotes » du cœur
 * (conception-gestion-pilotes_specs v1.1) sans aucun matériel : des capteurs de test (configurés), des « découverts »
 * simulés, et toute la mécanique réelle d'un pilote — aperçu, jeton, écriture de fichier AVEC sauvegarde, contrôle des
 * règles (qualification complète avant adoption, suppression avant ajout au remplacement).
 *
 * Fichier : data/testcycle/pilote-test.json (créé au premier ordre modifiant ; sauvegarde `.bak-AAAAMMJJ-HHMMSS` avant
 * chaque réécriture). Les découverts sont en MÉMOIRE seulement (comme ceux de l'AREXX et du RFXCOM).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PiloteGestionnaire } from '../../../core/dist/exports';

export interface CapteurTest {
  id: string;
  quoi: string;
  lieu: string;
  lieuPrecis: string;
  transmitToHa: boolean;
}

export interface DecouvertTest {
  id: string;
  valeur: number;
  vuLe: string;
  qualite: number;
}

interface FichierPiloteTest {
  capteurs: CapteurTest[];
  ignores: string[];
}

const PAR_DEFAUT: FichierPiloteTest = {
  capteurs: [{ id: 'test_1000', quoi: 'Température', lieu: 'salon', lieuPrecis: 'canapé', transmitToHa: true }],
  ignores: []
};

function horodatage(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export class PiloteTest implements PiloteGestionnaire {
  private decouverts: Map<string, DecouvertTest> = new Map();

  constructor(private readonly fichier: string, private readonly maintenant: () => Date = () => new Date()) {
    // Deux « découverts » simulés pour pouvoir essayer adopter / effacer / ignorer / remplacer.
    this.simuler('test_2001', 21.5, 80);
    this.simuler('test_2002', 18.0, 55);
  }

  private simuler(id: string, valeur: number, qualite: number): void {
    this.decouverts.set(id, { id, valeur, vuLe: this.maintenant().toISOString(), qualite });
  }

  private lireFichier(): FichierPiloteTest {
    try {
      if (fs.existsSync(this.fichier)) {
        const brut = JSON.parse(fs.readFileSync(this.fichier, 'utf8')) as Partial<FichierPiloteTest>;
        return { capteurs: brut.capteurs ?? [], ignores: brut.ignores ?? [] };
      }
    } catch {
      /* fichier illisible : on repart du défaut, la sauvegarde protège l'ancien */
    }
    return JSON.parse(JSON.stringify(PAR_DEFAUT)) as FichierPiloteTest;
  }

  private ecrireFichier(contenu: FichierPiloteTest): string | undefined {
    fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
    let sauvegarde: string | undefined;
    if (fs.existsSync(this.fichier)) {
      sauvegarde = `${this.fichier}.bak-${horodatage()}`;
      fs.copyFileSync(this.fichier, sauvegarde);
    }
    fs.writeFileSync(this.fichier, JSON.stringify(contenu, null, 2), 'utf8');
    return sauvegarde;
  }

  private visibles(f: FichierPiloteTest): DecouvertTest[] {
    return [...this.decouverts.values()].filter((d) => !f.ignores.includes(d.id) && !f.capteurs.some((c) => c.id === d.id));
  }

  async lire(ordre: 'lister' | 'decouverts'): Promise<unknown> {
    const f = this.lireFichier();
    return ordre === 'lister' ? { capteurs: f.capteurs } : { decouverts: this.visibles(f), ignores: f.ignores };
  }

  /** Applique l'ordre sur une COPIE et renvoie le résultat ; lève si l'ordre est invalide. */
  private simulerOrdre(
    ordre: string,
    p: Record<string, unknown>,
    f: FichierPiloteTest
  ): { apres: FichierPiloteTest; apercu: Record<string, unknown>; decouvertsRetires?: string[] } {
    const apres: FichierPiloteTest = JSON.parse(JSON.stringify(f)) as FichierPiloteTest;
    const id = String(p.id ?? '');
    const existe = (x: string): CapteurTest | undefined => apres.capteurs.find((c) => c.id === x);

    switch (ordre) {
      case 'adopter': {
        if (!this.decouverts.has(id)) throw new Error(`« ${id} » n'est pas dans les découverts`);
        for (const champ of ['quoi', 'lieu', 'lieuPrecis']) {
          if (!p[champ] || typeof p[champ] !== 'string') throw new Error(`Qualification incomplète : « ${champ} » est obligatoire pour adopter`);
        }
        const capteur: CapteurTest = {
          id, quoi: String(p.quoi), lieu: String(p.lieu), lieuPrecis: String(p.lieuPrecis), transmitToHa: p.transmitToHa === true
        };
        apres.capteurs.push(capteur);
        return { apres, apercu: { ajoute: capteur, entiteHa: capteur.transmitToHa ? `sera créée (${capteur.quoi}---${capteur.lieu}--${capteur.lieuPrecis})` : 'aucune (transmitToHa faux)' } };
      }
      case 'supprimer': {
        const c = existe(id);
        if (!c) throw new Error(`Capteur « ${id} » inconnu`);
        apres.capteurs = apres.capteurs.filter((x) => x.id !== id);
        return { apres, apercu: { retire: c, entiteHa: c.transmitToHa ? 'sera supprimée de HA' : 'aucune' } };
      }
      case 'remplacer': {
        const ancien = existe(String(p.ancien ?? ''));
        if (!ancien) throw new Error(`Capteur à remplacer « ${String(p.ancien)} » inconnu`);
        const nouveau = String(p.nouveau ?? '');
        if (!this.decouverts.has(nouveau)) throw new Error(`« ${nouveau} » n'est pas dans les découverts`);
        // Suppression D'ABORD (libère l'entity_id côté HA), puis ajout au même nommage (conception §7.2).
        apres.capteurs = apres.capteurs.filter((x) => x.id !== ancien.id);
        apres.capteurs.push({ ...ancien, id: nouveau });
        return {
          apres,
          apercu: { etapes: [`1. supprimer ${ancien.id}`, `2. ajouter ${nouveau} avec le même nommage`], nommage: `${ancien.quoi}---${ancien.lieu}--${ancien.lieuPrecis}`, entiteHa: ancien.transmitToHa ? 'supprimée puis recréée avec le même entity_id' : 'aucune' }
        };
      }
      case 'ignorer': {
        if (!this.decouverts.has(id)) throw new Error(`« ${id} » n'est pas dans les découverts`);
        if (!apres.ignores.includes(id)) apres.ignores.push(id);
        return { apres, apercu: { ignore: id } };
      }
      case 'effacer': {
        if (p.tout === true) return { apres, apercu: { efface: this.visibles(f).map((d) => d.id) }, decouvertsRetires: this.visibles(f).map((d) => d.id) };
        if (!this.decouverts.has(id)) throw new Error(`« ${id} » n'est pas dans les découverts`);
        return { apres, apercu: { efface: [id], note: 'réapparaît s\'il émet à nouveau ; HA non touché' }, decouvertsRetires: [id] };
      }
      case 'redemarrer':
        return { apres, apercu: { action: 'relecture de la configuration du pilote de test (sans effet réel)' } };
      default:
        throw new Error(`Ordre « ${ordre} » non géré par le pilote de test`);
    }
  }

  async preparer(ordre: string, parametres: Record<string, unknown>): Promise<{ apercu: unknown; etat: unknown }> {
    const f = this.lireFichier();
    const { apercu } = this.simulerOrdre(ordre, parametres, f);
    // L'état concerné : le fichier ET les découverts visibles (le jeton change si l'un d'eux change).
    return { apercu, etat: { capteurs: f.capteurs, ignores: f.ignores, decouverts: this.visibles(f).map((d) => d.id) } };
  }

  async appliquer(ordre: string, parametres: Record<string, unknown>): Promise<{ resultat?: unknown; sauvegarde?: string }> {
    const f = this.lireFichier();
    const { apres, decouvertsRetires } = this.simulerOrdre(ordre, parametres, f);
    for (const id of decouvertsRetires ?? []) this.decouverts.delete(id);
    if (ordre === 'redemarrer') return { resultat: { redemarre: true } };
    if (ordre === 'adopter' || ordre === 'remplacer') this.decouverts.delete(String(parametres.id ?? parametres.nouveau));
    if (ordre === 'effacer') return { resultat: { decouvertsRestants: this.visibles(f).length } };
    const sauvegarde = this.ecrireFichier(apres);
    return { resultat: { capteurs: apres.capteurs.length }, sauvegarde };
  }
}
