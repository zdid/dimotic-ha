/**
 * Schéma de stockage des scripts déposés — métadonnées dans un fichier YAML dédié
 * (scriptsha-scripts-v1.0.yaml, même convention que rpigpio-pins-v1.0.yaml), le contenu YAML brut
 * de chaque script vivant séparément dans data/scriptsha/scripts/<id>.yaml (voir ScriptsHaService).
 */

import { z } from 'zod';

/**
 * Provisionnement optionnel associé à un script — métadonnées structurées, pas un nouveau format
 * de fichier (le contenu YAML du script reste un script HA pur). Décrit une ressource HA à
 * garantir présente par entité surveillée (ex: un helper timer par lumière) — le moteur
 * générique (ScriptsHaService::reconcileEntityHelpers) ne connaît aucun script en particulier,
 * seul ce champ, quand présent, active le mécanisme. Voir fonctionnelles-scriptsha_specs §4bis.
 */
export const provisioningSchema = z.object({
  /** Domaine HA à surveiller (ex: 'light') — la "condition" au sens le plus simple aujourd'hui,
   *  volontairement isolée côté service (ScriptsHaService::matchesWatchCondition) pour pouvoir
   *  évoluer vers un filtre plus riche sans toucher ce schéma. */
  watchDomain: z.string().min(1),
  /** Domaine de helper HA à créer (ex: 'timer') — voir HaHelperBridge. */
  helperDomain: z.string().min(1),
  /** Préfixe du nom (ex: 'Minuterie') — le reste du nom vient de la taxonomie OÙ de l'entité
   *  surveillée (lieu_precis/lieu_principal/lieu_pere/lieu_grand_pere), voir buildHelperName(). */
  namePrefix: z.string().min(1),
  /** Champs additionnels passés tels quels à la création du helper (ex: { duration: '00:10:00' } pour un timer). */
  helperData: z.record(z.unknown()).optional()
});

export type ProvisioningConfig = z.infer<typeof provisioningSchema>;

export const scriptEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  originalFilename: z.string().min(1),
  /** Domaine HA cible pour la diffusion (§4 fonctionnelles-scriptsha_specs) — 'script' pour un
   *  script.* classique (pas de déclencheur propre), 'automation' pour une automation.* qui a
   *  besoin de réagir seule à des changements d'état (ex: la minuterie des lumières). Même API
   *  REST générique des deux côtés (HaRestBridge), seul le domaine cible change. */
  haDomain: z.enum(['script', 'automation']).default('script'),
  deployed: z.boolean().default(false),
  deployedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  provisioning: provisioningSchema.optional(),
  /** Vrai si ce script vient du registre intégré à l'application (BUILTIN_SCRIPTS,
   *  ScriptsHaService.ts) — déposé automatiquement au démarrage s'il est absent. Un script
   *  téléversé par l'utilisateur qui réutiliserait le même id n'est jamais marqué ainsi (voir
   *  seedBuiltinScripts) : seul un script réellement issu du registre peut ensuite être comparé/
   *  signalé comme divergent. */
  builtin: z.boolean().default(false),
  /** Vrai si le contenu sur disque diffère du modèle intégré actuel (comparaison normalisée — les
   *  parties légitimement régénérées par l'app, ex: liste de lumières de la minuterie, sont
   *  neutralisées avant comparaison). Recalculé à chaque démarrage, affiché comme avertissement
   *  dans l'IHM — jamais utilisé pour écraser automatiquement une modification locale. */
  driftsFromBuiltin: z.boolean().default(false)
});

export type ScriptEntry = z.infer<typeof scriptEntrySchema>;

export const scriptsConfigSchema = z.object({
  scripts: z.array(scriptEntrySchema).default([])
});

export type ScriptsConfigFile = z.infer<typeof scriptsConfigSchema>;

export const DEFAULT_SCRIPTS_CONFIG: ScriptsConfigFile = { scripts: [] };
