/**
 * Schéma de configuration Outils — section `outils` de data/config.yaml.
 *
 * ⭐ 20/09/2026 — la liste des scripts n'est PLUS stockée ici (ancien tableau `scripts` dans
 * data/outils/config.yaml, qui vivait entièrement en dehors du dépôt git donc jamais embarqué
 * dans l'image Docker). Chaque script est désormais son propre triplet de fichiers
 * (`<id>.yaml` + `<id>.sh` [+ moteur optionnel]) dans deux arborescences parallèles — voir
 * ScriptTemplate.ts :
 *   - `applications/outils/reposcripts/{yaml,wrappers,scripts}/` — scripts intégrés, dans le
 *     dépôt git, donc présents dans l'image Docker sur toute machine qui la fait tourner.
 *   - `data/outils/reposcripts/{yaml,wrappers,scripts}/` — scripts ajoutés par l'utilisateur
 *     (formulaire d'ajout), propres à cette machine comme avant.
 * `outilsConfigSchema` reste déclaré (vide) uniquement parce que chaque application enregistrée
 * doit fournir un schéma de config — aucun champ n'est actuellement utilisé.
 */

import { z } from 'zod';

/**
 * Métadonnées d'un script de la bibliothèque (contenu d'un fichier `<id>.yaml`) — ⭐ 18/09/2026,
 * demande explicite : "gérer des scripts, titre et description... stockés dans l'image
 * elle-même... comme les autres applications qui ont des données". Les VARIABLES ne sont PAS
 * déclarées ici : détectées automatiquement dans le contenu du script wrapper (jetons `__NOM__`,
 * même convention que `BackupScript.ts` de l'app sauvegarde) — voir `detectVariables()` dans
 * `ScriptTemplate.ts`. Pas de round-trip serveur pour la génération : le contenu est envoyé au
 * navigateur à la sélection, la substitution et le téléchargement se font côté client.
 */
export const outilScriptSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  // Nom de fichier proposé au téléchargement — indépendant de `id` (id est une clé technique,
  // filename est ce que l'utilisateur verra/exécutera, ex. "flash-sd-card.sh").
  filename: z.string().min(1),
  // Beaucoup de scripts de cette bibliothèque touchent au système (montage, écriture disque,
  // paquets...) — affiché dans la commande proposée (`sudo bash <filename>` vs `bash <filename>`).
  requiresSudo: z.boolean().default(false)
});

export type OutilScriptConfig = z.infer<typeof outilScriptSchema>;

export const outilsConfigSchema = z.object({}).passthrough();

export type OutilsConfig = z.infer<typeof outilsConfigSchema>;

export const DEFAULT_OUTILS_CONFIG: OutilsConfig = {};
