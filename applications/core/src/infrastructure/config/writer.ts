import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { AppConfig, configSchema } from './schema';
import { writeLayered, CORE_DECLARATION, APP_DECLARATIONS, type LayerDeclaration } from './layers';

/**
 * Résultat de la sauvegarde
 */
export interface SaveResult {
  success: boolean;
  error?: string;
}

/**
 * Écrit la configuration de manière atomique (fichier temporaire → rename)
 */
const YAML_DUMP_OPTIONS = { indent: 2, sortKeys: false, lineWidth: -1 };

export class ConfigWriter {
  private readonly configPath: string;
  private readonly schema: any;
  private readonly tmpSuffix: string;
  private readonly appDataRoot?: string;

  /**
   * @param configPath - Chemin vers le config.yaml du socle (default: /app/data/core/config.yaml)
   * @param schema - Schéma Zod (default: configSchema)
   * @param tmpSuffix - Suffixe pour le fichier temporaire (default: .tmp)
   * @param appDataRoot - Répertoire `data/` contenant un sous-dossier par application — requis
   *   pour utiliser `saveModuleFile()`. Absent : comportement inchangé pour `save()`.
   */
  constructor(
    configPath: string = process.env.CONFIG_PATH || '/app/data/core/config.yaml',
    schema: any = configSchema,
    tmpSuffix: string = '.tmp',
    appDataRoot?: string
  ) {
    this.configPath = configPath;
    this.schema = schema;
    this.tmpSuffix = tmpSuffix;
    this.appDataRoot = appDataRoot;
  }

  /**
   * Écrit `data` en YAML de façon atomique (fichier temporaire → rename), en créant le
   * répertoire parent si nécessaire (indispensable depuis qu'un premier save doit créer
   * `data/{app}/`, jamais nécessaire tant que `data/` existait déjà à plat).
   */
  private writeYamlAtomic(filePath: string, data: unknown): SaveResult {
    const tmpPath = `${filePath}${this.tmpSuffix}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const yamlContent = yaml.dump(data, YAML_DUMP_OPTIONS);
      fs.writeFileSync(tmpPath, yamlContent, 'utf-8');
      fs.renameSync(tmpPath, filePath);
      return { success: true };
    } catch (error) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      const errorMessage = error instanceof Error ? error.message : 'Unknown write error';
      return { success: false, error: `Write failed: ${errorMessage}` };
    }
  }

  /**
   * Valide et sauvegarde la configuration du socle (ha/web/logging) dans `configPath`.
   * @param config - Config à sauvegarder
   * @returns Résultat { success, error? }
   */
  save(config: AppConfig, options: { skipHaConnectionValidation?: boolean } = {}): SaveResult {
    try {
      // ⭐ 01/10/2026 (démarrage tolérant) : quand on n'écrit PAS la section `ha` (liste d'applications, cibles,
      // diffusion…) alors qu'elle est invalide en mémoire, ses connexions fautives ne doivent pas bloquer l'écriture
      // du reste. La section `ha` modifiée depuis l'IHM reste, elle, validée strictement.
      let toValidate: unknown = config;
      if (options.skipHaConnectionValidation && config.ha) {
        const { ws: _ws, mqtt: _mqtt, ...haRest } = config.ha as unknown as Record<string, unknown>;
        toValidate = { ...config, ha: haRest };
      }
      this.schema.parse(toValidate);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorDetails = error.errors
          .map((err: any) => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        return { success: false, error: `Validation failed: ${errorDetails}` };
      }
      return { success: false, error: `Validation error: ${error}` };
    }

    // ⭐ 29/09/2026 — réparti dans config.yaml / machine_config.yaml / secrets_config.yaml (layers.ts).
    return this.writeLayeredSafe(path.dirname(this.configPath), config as unknown as Record<string, unknown>, CORE_DECLARATION);
  }

  /** Déclarations `storage` des champs de formulaire des applications (voir registerStorage). */
  private readonly storageDeclarations = new Map<string, LayerDeclaration>();

  /**
   * ⭐ 29/09/2026 — réglages d'une application déclarés `storage: 'machine' | 'secret'` sur leur
   * ConfigField : décide du fichier d'un réglage NOUVEAU (un réglage existant reste là où il est).
   */
  registerStorage(moduleId: string, decl: LayerDeclaration): void {
    this.storageDeclarations.set(moduleId, decl);
  }

  private declarationFor(moduleId: string): LayerDeclaration {
    const a = APP_DECLARATIONS[moduleId] ?? {};
    const b = this.storageDeclarations.get(moduleId) ?? {};
    return { machine: [...(a.machine ?? []), ...(b.machine ?? [])], secrets: [...(a.secrets ?? []), ...(b.secrets ?? [])] };
  }

  private writeLayeredSafe(dir: string, data: Record<string, unknown>, decl: LayerDeclaration): SaveResult {
    try {
      writeLayered(dir, data, decl, this.tmpSuffix);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown write error';
      return { success: false, error: `Write failed: ${errorMessage}` };
    }
  }

  /**
   * Sauvegarde la section d'une application dans son propre fichier
   * (`{appDataRoot}/{moduleId}/config.yaml`, objet nu, pas de clé d'app en tête). Pas de
   * validation de schéma générique ici — chaque appelant (ConfigService.savePartialConfig/
   * saveModuleConfig) gère sa propre validation le cas échéant.
   */
  saveModuleFile(moduleId: string, data: unknown): SaveResult {
    if (!this.appDataRoot) {
      return { success: false, error: 'ConfigWriter: appDataRoot non fourni, saveModuleFile() indisponible' };
    }
    // ⭐ 29/09/2026 — trois fichiers (layers.ts) ; une section qui n'est pas un objet reste écrite telle quelle.
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return this.writeLayeredSafe(path.join(this.appDataRoot, moduleId), data as Record<string, unknown>, this.declarationFor(moduleId));
    }
    const filePath = path.join(this.appDataRoot, moduleId, 'config.yaml');
    return this.writeYamlAtomic(filePath, data);
  }
}

export { configSchema };
