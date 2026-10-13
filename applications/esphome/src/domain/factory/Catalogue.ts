/**
 * Catalogue de l'usine : modèles de matériel et appareils CONNUS d'après les paquets reçus et les cartes flashées
 * (fonctionnelles-esphome_specs §5.4). Sert de référence à la reconnaissance d'une carte (MAC déjà vue, modèle
 * compatible). Fichier JSON écrit de façon atomique ; en attendant le catalogue de l'assembleur (étape 3).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModeleFiche, AppareilEnregistre } from './Reconnaissance';

export interface DonneesCatalogue {
  modeles: ModeleFiche[];
  appareils: (Omit<AppareilEnregistre, 'mac'> & { mac?: string })[];
}

export class Catalogue {
  constructor(private readonly fichier: string) {}

  lire(): DonneesCatalogue {
    try {
      const d = JSON.parse(fs.readFileSync(this.fichier, 'utf8'));
      return { modeles: Array.isArray(d.modeles) ? d.modeles : [], appareils: Array.isArray(d.appareils) ? d.appareils : [] };
    } catch {
      return { modeles: [], appareils: [] };
    }
  }

  private ecrire(d: DonneesCatalogue): void {
    fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
    const tmp = `${this.fichier}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
    fs.renameSync(tmp, this.fichier);
  }

  /** Note le modèle et l'appareil d'un paquet reçu (la MAC éventuelle d'un appareil déjà flashé est conservée). */
  noterPaquet(modele: ModeleFiche, appareil: string): void {
    const d = this.lire();
    const i = d.modeles.findIndex((m) => m.id === modele.id);
    if (i >= 0) d.modeles[i] = modele; else d.modeles.push(modele);
    const a = d.appareils.find((x) => x.appareil === appareil);
    if (a) a.modele = modele.id; else d.appareils.push({ appareil, modele: modele.id });
    this.ecrire(d);
  }

  /** Associe une adresse MAC (carte flashée) à un appareil. */
  noterMac(appareil: string, mac: string): void {
    const d = this.lire();
    const a = d.appareils.find((x) => x.appareil === appareil);
    if (!a) throw new Error(`appareil inconnu du catalogue : ${appareil}`);
    a.mac = mac.toLowerCase();
    this.ecrire(d);
  }

  appareilsAvecMac(): AppareilEnregistre[] {
    return this.lire().appareils.filter((a): a is AppareilEnregistre => !!a.mac);
  }
}
