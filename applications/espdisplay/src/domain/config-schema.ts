/**
 * Schéma de configuration pour l'application ESPDISPLAY.
 *
 * Paramètres du pipeline de déploiement des écrans ESP (ESPHome/LVGL) : nom du conteneur Docker
 * esphome déjà en service sur CETTE machine (falbala — décision utilisateur 13/08/2026, après
 * échec du test sur ha2/Pi4 : RAM insuffisante pour la compilation ESP-IDF, voir mémoire projet),
 * répertoire de config monté dans ce conteneur, et chemin du script Python qui génère/fusionne/
 * compile (actuellement applications/haplan/tools/generate_esphome_floorplan.py — l'app HAPLAN
 * reste propriétaire des données de plan, ESPDISPLAY orchestre juste l'appel).
 */

import { z } from 'zod';

// Exécution à distance (SSH, clé dédiée sans mot de passe) — nécessaire quand ce service tourne
// sur une machine sans le conteneur Docker esphome ni python3 (ex: ha2, volontairement dépourvu
// de ces deux choses : le Pi4 n'a pas assez de RAM pour compiler ESP-IDF, voir essai du 13/08/2026
// et fonctionnelles-espdisplay_specs_v1.0.md §6.2). `host` vide = exécution locale (comportement
// d'origine, valable sur la machine qui héberge réellement le conteneur esphome — falbala en
// pratique). Même pattern que teleinfo/rpigpio (DeployService.ts, target.host/sshUser/sshKeyPath),
// mais ici la commande distante est une commande SSH FORCÉE (voir ~/bin/espdisplay-agent-run.sh
// sur la machine cible) qui ignore tout sauf l'identifiant de plan reçu via SSH_ORIGINAL_COMMAND —
// la clé ne permet donc RIEN d'autre que ce pipeline précis, pas un accès shell général.
const remoteTargetSchema = z.object({
  host: z.string().default(''),
  sshUser: z.string().default('didier'),
  sshKeyPath: z.string().default('')
});

export const espDisplayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  esphomeContainer: z.string().default('esphome'),
  esphomeConfigDir: z.string().default('/docker/esphome/config'),
  // Vide = résolu par défaut vers applications/haplan/tools/generate_esphome_floorplan.py
  // (relatif à PROJECT_ROOT) — voir EspDisplayService.resolvePipelineScript(). Sans effet si
  // `remote.host` est défini (la commande forcée côté cible ignore ce chemin, voir plus haut).
  pipelineScriptPath: z.string().default(''),
  pythonBin: z.string().default('python3'),
  remote: remoteTargetSchema.default({})
});

export type EspDisplayRemoteTarget = z.infer<typeof remoteTargetSchema>;
export type EspDisplayConfig = z.infer<typeof espDisplayConfigSchema>;

export const DEFAULT_ESPDISPLAY_CONFIG: EspDisplayConfig = {
  enabled: true,
  esphomeContainer: 'esphome',
  esphomeConfigDir: '/docker/esphome/config',
  pipelineScriptPath: '',
  pythonBin: 'python3',
  remote: { host: '', sshUser: 'didier', sshKeyPath: '' }
};
