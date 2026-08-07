/**
 * ConfigFileManager générique — chargement/sauvegarde d'un fichier YAML validé par un schéma Zod.
 * Miroir du pattern rfxcom/arexx (yaml/ConfigFileManager.ts) : écriture atomique + .bak, validation
 * Zod obligatoire avant écriture. Générique ici (une instance par fichier — macros, planifications)
 * plutôt que deux classes quasi identiques.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { Logger } from '../../../../core/dist/exports';

export interface SaveResult {
  success: boolean;
  error?: string;
}

export class ConfigFileManager<T> {
  constructor(
    private readonly filePath: string,
    // Input laissé libre (`any`) : les schémas avec .default() ont un _input optionnel distinct
    // du _output (T) — c'est précisément ce qui permet un fichier absent/partiel de se compléter
    // aux valeurs par défaut lors du parse().
    private readonly schema: z.ZodType<T, z.ZodTypeDef, any>,
    private readonly defaultConfig: T,
    private readonly logger: Logger,
    private readonly label: string
  ) {}

  load(): T {
    if (!fs.existsSync(this.filePath)) {
      this.logger.info('ConfigFileManager', `${this.label}: fichier ${this.filePath} absent, création avec une configuration vide`);
      this.save(this.defaultConfig);
      return this.defaultConfig;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = yaml.load(raw);
      const config = this.schema.parse(parsed ?? {});
      this.logger.info('ConfigFileManager', `${this.label}: chargé depuis ${this.filePath}`);
      return config;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
        this.logger.error('ConfigFileManager', `${this.label}: fichier invalide: ${details}`);
      } else {
        this.logger.error('ConfigFileManager', `${this.label}: erreur de lecture de ${this.filePath}: ${error}`);
      }
      this.logger.warn('ConfigFileManager', `${this.label}: démarrage avec une configuration vide (fichier existant non chargé)`);
      return this.defaultConfig;
    }
  }

  save(config: T): SaveResult {
    try {
      this.schema.parse(config);
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
      fs.writeFileSync(tmpPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');
      fs.renameSync(tmpPath, this.filePath);

      return { success: true };
    } catch (error) {
      return { success: false, error: `Erreur d'écriture: ${error}` };
    }
  }
}
