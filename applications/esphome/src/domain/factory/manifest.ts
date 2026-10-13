/**
 * Manifeste d'un paquet (fonctionnelles-esphome_specs §4bis) : `manifest.json` à la racine du zip. L'usine refuse un
 * paquet dont le manifeste est absent ou invalide, ou dont une somme de contrôle de fichier ne correspond pas.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';
import type { EntreeZip } from './zip';

const nom = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/);

export const manifesteSchema = z.object({
  v: z.literal(1),
  appareil: nom,
  nomAffichage: z.string().min(1),
  revision: z.number().int().nonnegative(),
  assemble: z.string().datetime({ offset: true }),
  modele: z.object({
    id: nom,
    puce: z.string().min(1),
    flash: z.string().min(1),
    cadre: z.string().min(1),
    // Valeurs de la fiche du modèle pour le contrôle des tailles (§5.5) ; absentes = contrôle de taille non fait.
    memoire: z.object({ emplacementOtaOctets: z.number().int().positive(), ramInterneOctets: z.number().int().positive() }).optional()
  }),
  esp: z.object({ adresse: z.string().min(1), port: z.number().int().positive().default(6053) }),
  options: z.object({ autoriserAppelsService: z.boolean().default(false) }).default({}),
  wifi: z.array(nom).default([]),
  fichiers: z.record(z.string().regex(/^[a-f0-9]{64}$/))
});
export type Manifeste = z.infer<typeof manifesteSchema>;

export const sha256 = (contenu: Buffer): string => crypto.createHash('sha256').update(contenu).digest('hex');

export type ResultatManifeste = { ok: true; manifeste: Manifeste; fichiers: EntreeZip[] } | { ok: false; raison: string };

/** Lit le manifeste du paquet et contrôle chaque fichier (présent, somme exacte) ; un fichier non déclaré est refusé. */
export function verifierPaquet(entrees: EntreeZip[]): ResultatManifeste {
  const m = entrees.find((e) => e.chemin === 'manifest.json');
  if (!m) return { ok: false, raison: 'manifest.json absent du paquet' };
  let json: unknown;
  try { json = JSON.parse(m.contenu.toString('utf8')); } catch { return { ok: false, raison: 'manifest.json : JSON invalide' }; }
  const r = manifesteSchema.safeParse(json);
  if (!r.success) return { ok: false, raison: `manifest.json invalide : ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}` };
  const manifeste = r.data;
  const fichiers = entrees.filter((e) => e.chemin !== 'manifest.json');
  const parChemin = new Map(fichiers.map((f) => [f.chemin, f]));
  for (const [chemin, somme] of Object.entries(manifeste.fichiers)) {
    const f = parChemin.get(chemin);
    if (!f) return { ok: false, raison: `fichier déclaré mais absent : ${chemin}` };
    if (sha256(f.contenu) !== somme) return { ok: false, raison: `somme de contrôle fausse : ${chemin}` };
  }
  for (const f of fichiers) if (!(f.chemin in manifeste.fichiers)) return { ok: false, raison: `fichier non déclaré dans le manifeste : ${f.chemin}` };
  if (!(`${manifeste.appareil}.yaml` in manifeste.fichiers)) return { ok: false, raison: `${manifeste.appareil}.yaml absent du paquet` };
  return { ok: true, manifeste, fichiers };
}
