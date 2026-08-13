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

export const espDisplayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  esphomeContainer: z.string().default('esphome'),
  esphomeConfigDir: z.string().default('/docker/esphome/config'),
  // Vide = résolu par défaut vers applications/haplan/tools/generate_esphome_floorplan.py
  // (relatif à PROJECT_ROOT) — voir EspDisplayService.resolvePipelineScript().
  pipelineScriptPath: z.string().default(''),
  pythonBin: z.string().default('python3')
});

export type EspDisplayConfig = z.infer<typeof espDisplayConfigSchema>;

export const DEFAULT_ESPDISPLAY_CONFIG: EspDisplayConfig = {
  enabled: true,
  esphomeContainer: 'esphome',
  esphomeConfigDir: '/docker/esphome/config',
  pipelineScriptPath: '',
  pythonBin: 'python3'
};
