/**
 * ConfigFileManager
 *
 * Chargement/sauvegarde du fichier de configuration centralisé HAPLAN
 * (config-haplan-floorplans-v1.0.yaml — plans + positions des icônes), distinct de
 * data/haplan/config.yaml qui ne garde que les paramètres généraux.
 *
 * Couche : Infrastructure (I/O fichier) — pas de dépendance EventBus/HA.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { Logger } from '../../../../core/dist/exports';
import { haplanFloorplansConfigSchema, DEFAULT_FLOORPLANS_CONFIG, type HaplanFloorplansConfigFile } from '../floorplans-config-schema';

export interface SaveResult {
  success: boolean;
  error?: string;
}

export class ConfigFileManager {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger
  ) {}

  /**
   * Charge le fichier. S'il n'existe pas encore (première installation), retourne une
   * configuration vide et la crée sur disque.
   */
  load(): HaplanFloorplansConfigFile {
    if (!fs.existsSync(this.filePath)) {
      this.logger.info('ConfigFileManager', `Fichier ${this.filePath} absent, création avec une configuration vide`);
      this.save(DEFAULT_FLOORPLANS_CONFIG);
      return DEFAULT_FLOORPLANS_CONFIG;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = yaml.load(raw);
      const config = haplanFloorplansConfigSchema.parse(parsed ?? {});
      this.logger.info('ConfigFileManager', `Chargé: ${Object.keys(config.floorplans).length} plan(s)`);
      return config;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        this.logger.error('ConfigFileManager', `Fichier de configuration HAPLAN invalide: ${details}`);
      } else {
        this.logger.error('ConfigFileManager', `Erreur de lecture de ${this.filePath}: ${error}`);
      }
      this.logger.warn('ConfigFileManager', 'Démarrage avec une configuration vide (fichier existant non chargé)');
      return DEFAULT_FLOORPLANS_CONFIG;
    }
  }

  /**
   * Sauvegarde le fichier de manière atomique (tmp → rename), avec copie de sauvegarde (.bak)
   * du fichier précédent si présent.
   */
  save(config: HaplanFloorplansConfigFile): SaveResult {
    try {
      haplanFloorplansConfigSchema.parse(config);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        return { success: false, error: `Validation échouée: ${details}` };
      }
      return { success: false, error: `Erreur de validation: ${error}` };
    }

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

      if (fs.existsSync(this.filePath)) {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
      }

      const tmpPath = `${this.filePath}.tmp`;
      const content = yaml.dump(config, { indent: 2, sortKeys: false });
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, this.filePath);

      this.logger.debug('ConfigFileManager', `Configuration HAPLAN sauvegardée dans ${this.filePath}`);
      return { success: true };
    } catch (error) {
      this.logger.error('ConfigFileManager', `Échec de la sauvegarde: ${error}`);
      return { success: false, error: String(error) };
    }
  }
}
