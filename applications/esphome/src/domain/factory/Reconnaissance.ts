/**
 * Reconnaissance d'une carte branchée en USB, AVANT tout premier flash (fonctionnelles-esphome_specs §5.4) :
 * `esptool flash-id` lancé dans le conteneur ESPHome (lecture seule, rien n'est écrit sur la carte) donne la puce, la
 * taille de la flash et l'adresse MAC ; on les compare au modèle de matériel choisi et aux appareils déjà enregistrés.
 *
 * Le format de sortie d'esptool 5 est lu de façon tolérante (lignes « Chip type », « MAC », « Flash Size »…) ; à valider
 * sur la carte d'essai.
 */

import type { DockerClient } from './DockerApi';

export interface Releve {
  /** Puce normalisée : `esp32`, `esp32-s3`, `esp32-c3`, `esp8266`… */
  puce: string;
  /** Texte brut de la puce (« ESP32-S3 (QFN56) (revision v0.2) »). */
  puceBrute: string;
  mac: string;
  /** Taille de la flash normalisée : `16MB`, `4MB`… ; null si non relevée. */
  flash: string | null;
  fonctions: string[];
}

export interface ModeleFiche { id: string; puce: string; flash: string }
export interface AppareilEnregistre { appareil: string; mac: string; modele: string }

export type Verdict =
  | { type: 'appareil_connu'; appareil: string; modele: string; conforme: boolean; detail?: string }
  | { type: 'nouvel_exemplaire'; modeles: string[] }
  | { type: 'carte_inconnue'; propositionModele: { puce: string; flash: string | null } }
  | { type: 'non_conforme'; attendu: ModeleFiche; detail: string };

/** `esp32-s3`, `ESP32-S3 (QFN56)…`, `ESP32S3` → `esp32-s3`. */
export function normaliserPuce(texte: string): string {
  const m = /esp\s*-?\s*(8266|32)(?:\s*-?\s*([a-z]\d{1,2}))?/i.exec(texte);
  if (!m) return texte.trim().toLowerCase();
  const base = m[1] === '8266' ? 'esp8266' : 'esp32';
  return m[2] ? `${base}-${m[2].toLowerCase()}` : base;
}

export function normaliserFlash(texte: string | null | undefined): string | null {
  if (!texte) return null;
  const m = /(\d+)\s*(?:MB|Mo|M)\b/i.exec(texte);
  return m ? `${m[1]}MB` : null;
}

export class ReconnaissanceEchouee extends Error {}

/** Lit la sortie de `esptool flash-id`. */
export function lireSortieEsptool(sortie: string): Releve {
  const champ = (re: RegExp): string | null => { const m = re.exec(sortie); return m ? m[1].trim() : null; };
  const puceBrute = champ(/Chip type:\s*(.+)/i) ?? champ(/Connected to\s+(\S+)/i);
  const mac = champ(/\bMAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i);
  if (!puceBrute || !mac) {
    throw new ReconnaissanceEchouee(`carte non reconnue : ${/(fatal|failed|error|no serial)/i.test(sortie) ? sortie.trim().split('\n').slice(-3).join(' | ') : 'sortie d\'esptool inattendue'}`);
  }
  const flash = normaliserFlash(champ(/Detected flash size:\s*(\S+)/i) ?? champ(/Flash Size:\s*(\S+)/i));
  const fonctions = (champ(/Features:\s*(.+)/i) ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  return { puce: normaliserPuce(puceBrute), puceBrute, mac: mac.toLowerCase(), flash, fonctions };
}

/** Interroge la carte branchée sur `peripherique` (aucune écriture). */
export async function reconnaitre(docker: DockerClient, conteneur: string, peripherique: string): Promise<Releve> {
  const etat = await docker.etat(conteneur);
  if (!etat.existe) throw new ReconnaissanceEchouee(`conteneur ${conteneur} introuvable`);
  if (!etat.enMarche) await docker.demarrer(conteneur);
  const r = await docker.exec(conteneur, ['esptool', '--port', peripherique, 'flash-id'], { delaiMs: 60_000 });
  if (r.codeSortie !== 0) throw new ReconnaissanceEchouee(`esptool a échoué (code ${r.codeSortie}) : ${r.sortie.trim().split('\n').slice(-3).join(' | ')}`);
  return lireSortieEsptool(r.sortie);
}

/**
 * Verdict (§5.4). `attendu` : modèle choisi pour l'appareil qu'on veut poser (absent = carte quelconque).
 * Ordre : MAC connue → appareil existant ; sinon contrôle de conformité au modèle attendu ; sinon modèles compatibles.
 */
export function juger(releve: Releve, modeles: ModeleFiche[], appareils: AppareilEnregistre[], attendu?: ModeleFiche): Verdict {
  const connu = appareils.find((a) => a.mac.toLowerCase() === releve.mac);
  const fiche = (id: string) => modeles.find((m) => m.id === id);
  const ecart = (m: ModeleFiche): string | null => {
    if (normaliserPuce(m.puce) !== releve.puce) return `détectée : ${releve.puce.toUpperCase()}${releve.flash ? ', ' + releve.flash.replace('MB', ' Mo') : ''} ; la fiche attend ${normaliserPuce(m.puce).toUpperCase()}, ${(normaliserFlash(m.flash) ?? m.flash).replace('MB', ' Mo')}`;
    const f = normaliserFlash(m.flash);
    if (releve.flash && f && releve.flash !== f) return `détectée : ${releve.puce.toUpperCase()}, ${releve.flash.replace('MB', ' Mo')} ; la fiche attend ${normaliserPuce(m.puce).toUpperCase()}, ${f.replace('MB', ' Mo')}`;
    return null;
  };
  if (connu) {
    const m = fiche(connu.modele);
    const e = m ? ecart(m) : null;
    return { type: 'appareil_connu', appareil: connu.appareil, modele: connu.modele, conforme: !e, ...(e ? { detail: e } : {}) };
  }
  if (attendu) {
    const e = ecart(attendu);
    if (e) return { type: 'non_conforme', attendu, detail: e };
  }
  const compatibles = modeles.filter((m) => !ecart(m)).map((m) => m.id);
  if (compatibles.length > 0) return { type: 'nouvel_exemplaire', modeles: compatibles };
  return { type: 'carte_inconnue', propositionModele: { puce: releve.puce, flash: releve.flash } };
}
