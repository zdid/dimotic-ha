/**
 * ConfigFileManager
 *
 * Chargement/sauvegarde du fichier de configuration centralisé EVOO7
 * (config-evoo7-donnees-v1.0.yaml — les 43 données), distinct de data/config.yaml qui ne garde
 * que les paramètres généraux (evoo7.bridgeInstance, evoo7.mqtt, ...).
 *
 * Contrairement à RFXCOM (dont le fichier de devices démarre vide), les 43 données EVOO7 sont
 * connues à l'avance : si le fichier n'existe pas encore, il est pré-rempli (seedé) depuis
 * seed/evoo7_donnees.json plutôt que créé vide.
 *
 * Couche : Infrastructure (I/O fichier) — pas de dépendance EventBus/MQTT.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { Logger } from '../../../../core/dist/exports';
import { evoo7DonneesConfigSchema, DEFAULT_DONNEES_CONFIG, type Evoo7DonneesConfigFile } from '../donnees-config-schema';
import { seedFromJsonFile } from '../seed';

export interface SaveResult {
  success: boolean;
  error?: string;
}

export class ConfigFileManager {
  constructor(
    private readonly filePath: string,
    private readonly seedJsonPath: string,
    private readonly logger: Logger
  ) {}

  /**
   * Charge le fichier. S'il n'existe pas encore (première installation), le pré-remplit depuis
   * le JSON source des 43 données EVOO7 et le crée sur disque.
   */
  load(): Evoo7DonneesConfigFile {
    if (!fs.existsSync(this.filePath)) {
      const seeded = this.seed();
      this.save(seeded);
      return seeded;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = yaml.load(raw);
      const config = evoo7DonneesConfigSchema.parse(parsed ?? {});
      this.logger.info('ConfigFileManager', `Chargé: ${Object.keys(config.evoo7_donnees).length} donnée(s)`);
      return config;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        this.logger.error('ConfigFileManager', `Fichier de configuration EVOO7 invalide: ${details}`);
      } else {
        this.logger.error('ConfigFileManager', `Erreur de lecture de ${this.filePath}: ${error}`);
      }
      this.logger.warn('ConfigFileManager', 'Démarrage avec une configuration vide (fichier existant non chargé)');
      return DEFAULT_DONNEES_CONFIG;
    }
  }

  private seed(): Evoo7DonneesConfigFile {
    try {
      const seeded = seedFromJsonFile(this.seedJsonPath);
      const validated = evoo7DonneesConfigSchema.parse(seeded);
      this.logger.info('ConfigFileManager',
        `Fichier ${this.filePath} absent, pré-remplissage depuis ${this.seedJsonPath}: ${Object.keys(validated.evoo7_donnees).length} donnée(s)`);
      return validated;
    } catch (error) {
      this.logger.error('ConfigFileManager', `Échec du pré-remplissage depuis ${this.seedJsonPath}: ${error}`);
      this.logger.warn('ConfigFileManager', 'Démarrage avec une configuration vide (aucune donnée EVOO7 connue)');
      return DEFAULT_DONNEES_CONFIG;
    }
  }

  /**
   * Sauvegarde le fichier de manière atomique (tmp → rename), avec copie de sauvegarde (.bak)
   * du fichier précédent si présent.
   */
  save(config: Evoo7DonneesConfigFile): SaveResult {
    try {
      evoo7DonneesConfigSchema.parse(config);
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

      this.logger.debug('ConfigFileManager', `Configuration EVOO7 sauvegardée dans ${this.filePath}`);
      return { success: true };
    } catch (error) {
      this.logger.error('ConfigFileManager', `Échec de la sauvegarde: ${error}`);
      return { success: false, error: String(error) };
    }
  }
}
