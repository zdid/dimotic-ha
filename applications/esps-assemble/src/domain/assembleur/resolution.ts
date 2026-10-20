/**
 * Résolution des sources d'un appareil : lit `appareils/<nom>.yaml`, suit ses `packages:` (`!include` simple ou avec `vars`, y compris
 * les inclusions imbriquées des éléments), classe chaque fichier (matériel, élément) et relève les fichiers annexes locaux (images,
 * polices, tables de partitions) à embarquer dans le paquet. ESPHome fait lui-même la fusion et la substitution des variables :
 * l'assembleur ne fait que collecter, vérifier et empaqueter.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export class ResolutionImpossible extends Error {}

/** Marqueurs des étiquettes ESPHome (`!include`, `!secret`, `!lambda`…) : on ne les évalue pas, on les repère. */
export interface Marqueur { __etiquette: string; valeur: unknown }

const ETIQUETTES = ['include', 'secret', 'lambda', 'extend', 'remove', 'include_dir_list', 'include_dir_merge_list', 'include_dir_named', 'include_dir_merge_named'];
const TYPES = ETIQUETTES.flatMap((e) =>
  (['scalar', 'mapping', 'sequence'] as const).map(
    (kind) => new yaml.Type(`!${e}`, { kind, construct: (valeur: unknown): Marqueur => ({ __etiquette: e, valeur }) })
  )
);
const SCHEMA = yaml.DEFAULT_SCHEMA.extend(TYPES);

export const estMarqueur = (x: unknown): x is Marqueur => !!x && typeof x === 'object' && '__etiquette' in (x as object);

export function chargerYaml(fichier: string): unknown {
  try {
    return yaml.load(fs.readFileSync(fichier, 'utf8'), { schema: SCHEMA });
  } catch (e) {
    throw new ResolutionImpossible(`${fichier} illisible : ${(e as Error).message}`);
  }
}

export function chargerYamlTexte(texte: string, nom: string): unknown {
  try {
    return yaml.load(texte, { schema: SCHEMA });
  } catch (e) {
    throw new ResolutionImpossible(`${nom} illisible : ${(e as Error).message}`);
  }
}

export interface Inclusion {
  /** Chemin dans le paquet (relatif à la racine de configuration d'ESPHome). */
  chemin: string;
  vars: Record<string, string>;
  /** Fichier qui inclut (chemin dans le paquet). */
  depuis: string;
}

export interface SourcesAppareil {
  nom: string;
  /** Fichiers à embarquer : chemin dans le paquet → contenu. L'appareil lui-même est `<nom>.yaml` à la racine. */
  fichiers: Map<string, Buffer>;
  materiel: string | null;
  /** Éléments utilisés, avec les variables de chaque inclusion (un même élément peut être inclus plusieurs fois, ex. page-climatisation). */
  elements: { id: string; vars: Record<string, string> }[];
  /** Fichiers annexes (images, polices…) référencés mais introuvables. */
  annexesManquantes: string[];
  /** Blocs de transport vers HA présents dans les sources (clés `api` et `mqtt` de premier niveau, éléments compris). */
  transports: { api: boolean; mqtt: boolean };
  /** Composants ESPHome LOCAUX (`external_components` de type local) embarqués : identifiants rangés sous `components/<id>/`. */
  composants: string[];
}

const RE_MATERIEL = /^bibliotheque\/materiels\/([a-z0-9_-]+)\/base\.yaml$/;
const RE_ELEMENT = /^bibliotheque\/elements\/([a-z0-9_-]+)\/element\.yaml$/;
const RE_ANNEXE = /\.(png|jpe?g|gif|bmp|ttf|otf|csv|bin)$/i;
const RE_COMPOSANT = /^[a-z0-9_]+$/;

/** Chemin normalisé POSIX, refusé s'il sort de la racine. */
function normaliser(base: string, relatif: string): string {
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(base), relatif));
  if (p.startsWith('..') || path.posix.isAbsolute(p)) throw new ResolutionImpossible(`inclusion hors de la racine : ${relatif} (depuis ${base})`);
  return p;
}

function inclusionsDe(noeud: unknown, depuis: string, sortie: Inclusion[]): void {
  if (estMarqueur(noeud)) {
    if (noeud.__etiquette === 'include') {
      if (typeof noeud.valeur === 'string') sortie.push({ chemin: normaliser(depuis, noeud.valeur), vars: {}, depuis });
      else if (noeud.valeur && typeof noeud.valeur === 'object') {
        const o = noeud.valeur as { file?: unknown; vars?: Record<string, unknown> };
        if (typeof o.file !== 'string') throw new ResolutionImpossible(`!include sans fichier dans ${depuis}`);
        sortie.push({ chemin: normaliser(depuis, o.file), vars: Object.fromEntries(Object.entries(o.vars ?? {}).map(([k, v]) => [k, String(v)])), depuis });
      }
    }
    return;
  }
  if (Array.isArray(noeud)) noeud.forEach((n) => inclusionsDe(n, depuis, sortie));
  else if (noeud && typeof noeud === 'object') Object.values(noeud).forEach((n) => inclusionsDe(n, depuis, sortie));
}

function annexesDe(noeud: unknown, sortie: Set<string>): void {
  if (estMarqueur(noeud)) return;
  if (Array.isArray(noeud)) { noeud.forEach((n) => annexesDe(n, sortie)); return; }
  if (noeud && typeof noeud === 'object') {
    for (const [k, v] of Object.entries(noeud)) {
      if ((k === 'file' || k === 'path' || k === 'partitions') && typeof v === 'string' && RE_ANNEXE.test(v) && !v.includes('://') && !v.includes('${')) sortie.add(v);
      else annexesDe(v, sortie);
    }
  }
}

/** Identifiants des composants listés par les `external_components` de type local d'un document. */
function composantsLocauxDe(doc: unknown): string[] {
  const ids: string[] = [];
  const liste = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>).external_components : undefined;
  if (!Array.isArray(liste)) return ids;
  for (const entree of liste) {
    if (!entree || typeof entree !== 'object') continue;
    const e = entree as { source?: { type?: unknown }; components?: unknown };
    if (e.source && typeof e.source === 'object' && e.source.type === 'local' && Array.isArray(e.components)) {
      for (const c of e.components) if (typeof c === 'string') ids.push(c);
    }
  }
  return ids;
}

/**
 * `racine` : dossier de l'application (contient `appareils/` et `bibliotheque/`). Les annexes sont cherchées dans
 * `bibliotheque/annexes/<chemin>` puis `appareils/<chemin>` ; celles qui sont introuvables sont signalées (pas d'échec).
 */
export function resoudreAppareil(racine: string, nom: string, generes: Map<string, Buffer> = new Map()): SourcesAppareil {
  const fichierAppareil = path.join(racine, 'appareils', `${nom}.yaml`);
  if (!fs.existsSync(fichierAppareil)) throw new ResolutionImpossible(`appareil ${nom} : appareils/${nom}.yaml introuvable`);
  const fichiers = new Map<string, Buffer>();
  const annexes = new Set<string>();
  const elements: { id: string; vars: Record<string, string> }[] = [];
  let materiel: string | null = null;
  const transports = { api: false, mqtt: false };
  const composants = new Set<string>();

  const visite = (cheminPaquet: string, absolu: string, pile: string[]): void => {
    if (pile.includes(cheminPaquet)) throw new ResolutionImpossible(`inclusion circulaire : ${[...pile, cheminPaquet].join(' → ')}`);
    // Fichier GÉNÉRÉ à l'assemblage (pages de plans) : fourni par `generes`, pas lu sur le disque.
    const genere = generes.get(cheminPaquet);
    if (genere === undefined && !fs.existsSync(absolu)) throw new ResolutionImpossible(`fichier inclus introuvable : ${cheminPaquet}`);
    const contenu = genere ?? fs.readFileSync(absolu);
    fichiers.set(cheminPaquet, contenu);
    const doc = genere !== undefined ? chargerYamlTexte(genere.toString('utf8'), cheminPaquet) : chargerYaml(absolu);
    annexesDe(doc, annexes);
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      if ('api' in doc) transports.api = true;
      if ('mqtt' in doc) transports.mqtt = true;
    }
    for (const c of composantsLocauxDe(doc)) composants.add(c);
    const incs: Inclusion[] = [];
    inclusionsDe(doc, cheminPaquet, incs);
    for (const inc of incs) {
      const m = RE_MATERIEL.exec(inc.chemin);
      const e = RE_ELEMENT.exec(inc.chemin);
      if (m) { if (materiel && materiel !== m[1]) throw new ResolutionImpossible(`deux matériels dans l'appareil : ${materiel} et ${m[1]}`); materiel = m[1]; }
      if (e) elements.push({ id: e[1], vars: inc.vars });
      visite(inc.chemin, path.join(racine, inc.chemin), [...pile, cheminPaquet]);
    }
  };
  visite(`${nom}.yaml`, fichierAppareil, []);

  // Composants ESPHome locaux : `bibliotheque/composants/<id>/*` est embarqué sous `components/<id>/*` (chemin `components`, voir external_components).
  for (const id of [...composants].sort()) {
    const dossier = path.join(racine, 'bibliotheque', 'composants', id);
    if (!RE_COMPOSANT.test(id) || !fs.existsSync(dossier) || !fs.statSync(dossier).isDirectory()) throw new ResolutionImpossible(`composant local « ${id} » introuvable (bibliotheque/composants/${id}/)`);
    for (const f of fs.readdirSync(dossier).sort()) {
      const fichier = path.join(dossier, f);
      if (fs.statSync(fichier).isFile()) fichiers.set(`components/${id}/${f}`, fs.readFileSync(fichier));
    }
  }

  const annexesManquantes: string[] = [];
  for (const a of annexes) {
    const candidats = [path.join(racine, 'bibliotheque', 'annexes', a), path.join(racine, 'appareils', a)];
    const trouve = candidats.find((c) => fs.existsSync(c));
    if (generes.has(a)) fichiers.set(a, generes.get(a) as Buffer); // image de fond générée à l'assemblage
    else if (trouve) fichiers.set(a, fs.readFileSync(trouve)); else annexesManquantes.push(a);
  }
  return { nom, fichiers, materiel, elements, annexesManquantes: annexesManquantes.sort(), transports, composants: [...composants].sort() };
}
