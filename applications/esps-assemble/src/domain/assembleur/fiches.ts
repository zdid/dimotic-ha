/**
 * Fiches de la bibliothèque (fonctionnelles-esphome_specs §4bis, conception-esphome-assembleur §3) :
 *  - fiche d'un **modèle de matériel** (`bibliotheque/materiels/<id>/fiche.yaml`) : une carte avec ses périphériques câblés, UNE fois par modèle ;
 *  - fiche d'un **élément** (`bibliotheque/elements/<id>/fiche.yaml`) : paramètres demandés et exigences ;
 *  - fiche d'un **appareil** (`appareils/<nom>.fiche.yaml`) : un exemplaire physique (nom d'affichage, matériel, adresse de l'ESP, options).
 * Les fichiers ESPHome eux-mêmes (`base.yaml`, `element.yaml`, `<appareil>.yaml`) ne changent pas : les fiches sont à côté.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

const identifiant = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'identifiant en minuscules, chiffres, _ et -');
const gpio = z.number().int().min(0).max(48);

export const ficheMaterielSchema = z.object({
  id: identifiant,
  nom: z.string().min(1),
  plateforme: z.enum(['esp32', 'esp8266']),
  /** Puce normalisée (comparée à la reconnaissance d'une carte) : esp32, esp32-s3, esp32-c3, esp8266… */
  puce: z.string().min(1),
  cadre: z.enum(['arduino', 'esp-idf']),
  carte: z.string().min(1),
  flash: z.string().regex(/^\d+MB$/, 'ex. 16MB'),
  /** Tailles de la fiche pour le contrôle après compilation (§5.5). */
  memoire: z.object({
    emplacementOtaOctets: z.number().int().positive(),
    ramInterneOctets: z.number().int().positive(),
    psram: z.boolean().default(false)
  }),
  /** Port de mise à jour par le réseau (3232 sur ESP32, 8266 sur ESP8266). */
  portOta: z.number().int().positive().default(3232),
  ecran: z.object({ largeur: z.number().int().positive(), hauteur: z.number().int().positive(), tactile: z.string().optional() }).optional(),
  audio: z.boolean().default(false),
  /** Broches déjà utilisées par la carte (écran, tactile, codecs…). Les broches libres sont relevées plus tard (décision du 13/10/2026). */
  brochesPrises: z.array(gpio).default([]),
  brochesLibres: z.array(gpio).default([])
});
export type FicheMateriel = z.infer<typeof ficheMaterielSchema>;

const parametreSchema = z.object({
  nom: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().default(''),
  requis: z.boolean().default(true),
  defaut: z.string().optional()
});

export const ficheElementSchema = z.object({
  id: identifiant,
  nom: z.string().min(1),
  description: z.string().default(''),
  parametres: z.array(parametreSchema).default([]),
  exigences: z
    .object({
      plateformes: z.array(z.enum(['esp32', 'esp8266'])).optional(),
      /** Écran exigé (dimensions exactes) ; absent = pas d'écran requis. */
      ecran: z.object({ largeur: z.number().int().positive(), hauteur: z.number().int().positive() }).optional(),
      audio: z.boolean().default(false),
      /** Éléments qui doivent aussi figurer dans l'appareil. */
      elements: z.array(identifiant).default([]),
      /** Si renseigné, matériels seuls acceptés. */
      materiels: z.array(identifiant).optional()
    })
    .default({}),
  /** Broches que l'élément utilise lui-même (détection de conflits). */
  broches: z.array(gpio).default([])
});
export type FicheElement = z.infer<typeof ficheElementSchema>;

export const ficheAppareilSchema = z.object({
  nom: identifiant,
  /** Nom d'affichage dans HA (`friendly_name`) : unique par appareil. */
  nomAffichage: z.string().min(1),
  materiel: identifiant,
  esp: z.object({ adresse: z.string().default(''), port: z.number().int().positive().default(6053), portOta: z.number().int().positive().optional() }).default({}),
  options: z.object({ autoriserAppelsService: z.boolean().default(false) }).default({}),
  /** Sites dont le wifi figure dans l'appareil (identifiants dans le secrets.yaml de l'usine). */
  wifi: z.array(identifiant).default([])
});
export type FicheAppareil = z.infer<typeof ficheAppareilSchema>;

/** Convertit les clés `snake_case` de la fiche YAML en `camelCase` du schéma (broches_prises → brochesPrises, nom_affichage → nomAffichage, …). */
function camel(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(camel);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), camel(v)]));
  return x;
}

export class FicheInvalide extends Error {}

function lire<T>(fichier: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, quoi: string): T {
  let brut: unknown;
  try {
    brut = yaml.load(fs.readFileSync(fichier, 'utf8'));
  } catch (e) {
    throw new FicheInvalide(`${quoi} illisible (${fichier}) : ${(e as Error).message}`);
  }
  const r = schema.safeParse(camel(brut));
  if (!r.success) throw new FicheInvalide(`${quoi} invalide (${path.basename(path.dirname(fichier))}/${path.basename(fichier)}) : ${r.error.issues.map((i) => `${i.path.join('.') || '(racine)'} ${i.message}`).join(' ; ')}`);
  return r.data;
}

export class Bibliotheque {
  constructor(readonly racine: string) {}

  materiel(id: string): FicheMateriel {
    const f = lire(path.join(this.racine, 'bibliotheque', 'materiels', id, 'fiche.yaml'), ficheMaterielSchema, `fiche du matériel ${id}`);
    if (f.id !== id) throw new FicheInvalide(`fiche du matériel ${id} : l'id « ${f.id} » ne correspond pas au dossier`);
    return f;
  }

  element(id: string): FicheElement {
    const f = lire(path.join(this.racine, 'bibliotheque', 'elements', id, 'fiche.yaml'), ficheElementSchema, `fiche de l'élément ${id}`);
    if (f.id !== id) throw new FicheInvalide(`fiche de l'élément ${id} : l'id « ${f.id} » ne correspond pas au dossier`);
    return f;
  }

  appareil(nom: string): FicheAppareil {
    const f = lire(path.join(this.racine, 'appareils', `${nom}.fiche.yaml`), ficheAppareilSchema, `fiche de l'appareil ${nom}`);
    if (f.nom !== nom) throw new FicheInvalide(`fiche de l'appareil ${nom} : le nom « ${f.nom} » ne correspond pas au fichier`);
    return f;
  }

  /** Noms des appareils qui ont une fiche. */
  appareils(): string[] {
    const dossier = path.join(this.racine, 'appareils');
    return fs.existsSync(dossier) ? fs.readdirSync(dossier).filter((n) => n.endsWith('.fiche.yaml')).map((n) => n.replace(/\.fiche\.yaml$/, '')).sort() : [];
  }
}
