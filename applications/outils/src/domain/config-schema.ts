/**
 * Schéma de configuration Outils — section `outils` de data/config.yaml.
 *
 * Bibliothèque de scripts shell paramétrables : titre + description en config, contenu du script
 * lui-même dans un fichier séparé (`data/outils/scripts/<id>.sh`) — même principe que les autres
 * applications qui séparent config.yaml (petit, structuré) de leurs données volumineuses (arexx
 * sépare déjà `arexx-sensors-v1.0.yaml`, par exemple).
 */

import { z } from 'zod';

/**
 * Un script de la bibliothèque — ⭐ 18/09/2026, demande explicite : "gérer des scripts, titre et
 * description... stockés dans l'image elle-même... comme les autres applications qui ont des
 * données". Les VARIABLES ne sont PAS déclarées ici : détectées automatiquement dans le contenu du
 * script (jetons `__NOM__`, même convention que `BackupScript.ts` de l'app sauvegarde) — voir
 * `detectVariables()` dans `ScriptTemplate.ts`. Pas de round-trip serveur pour la génération : le
 * contenu est envoyé au navigateur à la sélection, la substitution et le téléchargement se font
 * côté client.
 */
const outilScriptSchema = z.object({
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

export const outilsConfigSchema = z.object({
  scripts: z.array(outilScriptSchema).default([])
}).refine(
  (config) => new Set(config.scripts.map((s) => s.id)).size === config.scripts.length,
  { message: 'Chaque script doit avoir un id unique', path: ['scripts'] }
);

export type OutilsConfig = z.infer<typeof outilsConfigSchema>;
export type OutilScriptConfig = z.infer<typeof outilScriptSchema>;

export const DEFAULT_OUTILS_CONFIG: OutilsConfig = {
  scripts: []
};
