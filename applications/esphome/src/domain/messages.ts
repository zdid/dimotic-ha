/**
 * Messages MQTT de l'application ESPHOME — fonctionnelles-esphome_specs v1.2 §4.
 *
 * Tous en JSON avec les champs communs `v` (version du format), `site`, `appareil`, `revision`, `at`.
 * Messages CONSERVÉS (retain) : un message dit « quoi prendre et où » et attend son destinataire ; il est
 * supprimé (message vide conservé) après prise en charge. Chaque message reste sur le broker de son site.
 */

import { z } from 'zod';

export const MESSAGE_VERSION = 1;

/** États publiés sur `status/<appareil>` (§4). */
export const ETATS = [
  'en_attente',
  'recuperation',
  'reconnaissance',
  'compilation',
  'pret_a_poser',
  'envoi',
  'verification',
  'termine',
  'echec'
] as const;
export type Etat = (typeof ETATS)[number];

const slug = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'identifiant invalide (lettres, chiffres, _ et -)');

const commun = {
  v: z.literal(MESSAGE_VERSION),
  site: slug,
  appareil: slug,
  revision: z.number().int().nonnegative(),
  at: z.string().datetime({ offset: true })
};

/** Demande de l'assembleur à l'usine. */
export const jobSchema = z.object({
  ...commun,
  action: z.enum(['amorce', 'firmware']),
  origine: z.string().min(1),
  paquet: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
export type Job = z.infer<typeof jobSchema>;

/** Firmware prêt : message de l'usine au poseur. */
export const poseSchema = z.object({
  ...commun,
  firmware: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  // Taille du firmware en octets : le poseur contrôle le nombre d'octets reçus (§5.5, §6.1).
  tailleOctets: z.number().int().positive(),
  esp: z.string().min(1),
  // Ports de l'ESP : API native (déclaration dans HA) et mise à jour OTA.
  portApi: z.number().int().positive().default(6053),
  portOta: z.number().int().positive().default(3232),
  nomAffichage: z.string().min(1),
  // Clé API : présente UNIQUEMENT pour un appareil neuf, visible une seule fois.
  cle: z.string().optional(),
  options: z.object({ autoriserAppelsService: z.boolean().default(false) }).default({})
});
export type Pose = z.infer<typeof poseSchema>;

/** Occupation relevée à la fin de la compilation (§5.5). */
export const mesuresSchema = z.object({
  flashUtilisee: z.number().int().nonnegative(),
  flashDisponible: z.number().int().positive(),
  ramUtilisee: z.number().int().nonnegative(),
  ramDisponible: z.number().int().positive(),
  tailleOctets: z.number().int().positive()
});
export type Mesures = z.infer<typeof mesuresSchema>;

/** État courant d'un appareil (usine puis poseur). */
export const statusSchema = z.object({
  ...commun,
  etat: z.enum(ETATS),
  detail: z.string().default(''),
  versionFirmware: z.string().optional(),
  mesures: mesuresSchema.optional()
});
export type Status = z.infer<typeof statusSchema>;

/** Présence d'un agent (usine ou poseur) ; le testament MQTT publie `enLigne: false`. */
export const presenceSchema = z.object({
  v: z.literal(MESSAGE_VERSION),
  enLigne: z.boolean(),
  instance: z.string().min(1),
  port: z.number().int().positive(),
  at: z.string().datetime({ offset: true })
});
export type Presence = z.infer<typeof presenceSchema>;

// --- Sujets ---------------------------------------------------------------------------------------------------

const T = 'dimotic/esphome';

export const topics = {
  job: (site: string, appareil: string) => `${T}/${site}/jobs/${appareil}`,
  jobs: (site: string) => `${T}/${site}/jobs/+`,
  pose: (site: string, appareil: string) => `${T}/${site}/pose/${appareil}`,
  poses: (site: string) => `${T}/${site}/pose/+`,
  status: (site: string, appareil: string) => `${T}/${site}/status/${appareil}`,
  usine: (machineEsphome: string) => `${T}/agent/${machineEsphome}`,
  poseur: (site: string) => `${T}/${site}/poseur`,
  appareilsAssembleur: (site: string) => `dimotic/esps-assemble/${site}/appareils`,
  demandeGenerer: (site: string) => `${T}/${site}/demande-generer`
} as const;

/** Appareil porté par un sujet `…/jobs/<appareil>` ou `…/pose/<appareil>` ; null si le sujet n'a pas cette forme. */
export function appareilDuSujet(topic: string): string | null {
  const m = /\/(?:jobs|pose|status)\/([a-zA-Z0-9_-]+)$/.exec(topic);
  return m ? m[1] : null;
}

// --- Lecture et validation --------------------------------------------------------------------------------------

export type Lecture<T> = { ok: true; valeur: T } | { ok: false; raison: string };

/** Décode et valide une charge MQTT ; une charge vide est « message supprimé » (ok:false, raison 'vide'). */
export function lire<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, charge: Buffer | string): Lecture<T> {
  const texte = typeof charge === 'string' ? charge : charge.toString('utf8');
  if (texte.trim() === '') return { ok: false, raison: 'vide' };
  let json: unknown;
  try {
    json = JSON.parse(texte);
  } catch {
    return { ok: false, raison: 'JSON invalide' };
  }
  const r = schema.safeParse(json);
  return r.success ? { ok: true, valeur: r.data } : { ok: false, raison: r.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ') };
}

/**
 * Une demande de révision plus ancienne que celle déjà traitée est ignorée ; la même révision déjà traitée l'est
 * aussi (elle ne doit pas relancer une compilation) ; une plus récente remplace l'ancienne (§4, règles).
 */
export function revisionAcceptee(revision: number, derniereTraitee: number | undefined): boolean {
  return derniereTraitee === undefined || revision > derniereTraitee;
}
