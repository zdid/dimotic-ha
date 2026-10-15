/**
 * `secrets.yaml` d'ESPHome, côté usine : lecture et ajout de la clé API d'un appareil neuf
 * (fonctionnelles-esphome_specs §5.1 étape 5). Le fichier est modifié par AJOUT de ligne (ses commentaires et son
 * ordre sont conservés) ; écriture atomique ; une clé existante n'est JAMAIS remplacée (reprise des appareils en
 * service sans réappairage dans HA).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export class SecretsStore {
  constructor(private readonly fichier: string, private readonly genererCle: () => string = () => crypto.randomBytes(32).toString('base64')) {}

  private lire(): Record<string, unknown> {
    if (!fs.existsSync(this.fichier)) return {};
    const doc = yaml.load(fs.readFileSync(this.fichier, 'utf8'));
    return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  }

  nomCle(appareil: string): string {
    return `api_${appareil}`;
  }

  existe(appareil: string): boolean {
    return typeof this.lire()[this.nomCle(appareil)] === 'string';
  }

  /** Parmi `noms`, ceux qui sont absents (ou vides) du secrets.yaml. */
  manquants(noms: string[]): string[] {
    const doc = this.lire();
    return noms.filter((n) => doc[n] === undefined || doc[n] === null || String(doc[n]) === '');
  }

  /** Crée la clé de l'appareil si elle est absente ; renvoie la clé NEUVE, ou null si elle existait déjà. */
  creerSiAbsente(appareil: string): string | null {
    if (this.existe(appareil)) return null;
    const cle = this.genererCle();
    const ancien = fs.existsSync(this.fichier) ? fs.readFileSync(this.fichier, 'utf8') : '';
    const sep = ancien === '' || ancien.endsWith('\n') ? '' : '\n';
    const tmp = `${this.fichier}.tmp`;
    fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
    fs.writeFileSync(tmp, `${ancien}${sep}${this.nomCle(appareil)}: "${cle}"\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.fichier);
    return cle;
  }
}
