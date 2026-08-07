/**
 * ConfigFileManager
 *
 * Chargement/sauvegarde du fichier de configuration centralisé RFXCOM
 * (config-rfxcom-devices-v1.0.yaml — devices physiques + récepteurs logiques), distinct de
 * data/config.yaml qui ne garde que les paramètres généraux (rfxcom.port, baudRate, ...).
 *
 * Conforme à fonctionnelles-rfxcom_specs_v5.6.md §10.2 : chargement au démarrage, sauvegarde à
 * chaque modification, validation Zod obligatoire, backup automatique avant écriture.
 *
 * Couche : Infrastructure (I/O fichier) — pas de dépendance EventBus/MQTT.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { Logger } from '../../../../core/dist/exports';
import { rfxComDevicesConfigSchema, DEFAULT_DEVICES_CONFIG, type RfxComDevicesConfigFile } from '../devices-config-schema';

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
  load(): RfxComDevicesConfigFile {
    if (!fs.existsSync(this.filePath)) {
      this.logger.info('ConfigFileManager', `Fichier ${this.filePath} absent, création avec une configuration vide`);
      this.save(DEFAULT_DEVICES_CONFIG);
      return DEFAULT_DEVICES_CONFIG;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = yaml.load(raw);
      const config = rfxComDevicesConfigSchema.parse(parsed ?? {});
      this.logger.info('ConfigFileManager',
        `Chargé: ${Object.keys(config.rfxcom_devices).length} device(s), ${Object.keys(config.rfxcom_receivers).length} récepteur(s)`);
      return config;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        this.logger.error('ConfigFileManager', `Fichier de configuration RFXCOM invalide: ${details}`);
      } else {
        this.logger.error('ConfigFileManager', `Erreur de lecture de ${this.filePath}: ${error}`);
      }
      this.logger.warn('ConfigFileManager', 'Démarrage avec une configuration vide (fichier existant non chargé)');
      return DEFAULT_DEVICES_CONFIG;
    }
  }

  /**
   * Sauvegarde le fichier de manière atomique (tmp → rename), avec copie de sauvegarde (.bak)
   * du fichier précédent si présent.
   */
  save(config: RfxComDevicesConfigFile): SaveResult {
    try {
      rfxComDevicesConfigSchema.parse(config);
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

      this.logger.debug('ConfigFileManager', `Configuration RFXCOM sauvegardée dans ${this.filePath}`);
      return { success: true };
    } catch (error) {
      this.logger.error('ConfigFileManager', `Échec de la sauvegarde: ${error}`);
      return { success: false, error: String(error) };
    }
  }
}
