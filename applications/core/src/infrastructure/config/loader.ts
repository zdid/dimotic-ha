import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { AppConfig, configSchema } from './schema';

/**
 * Valeurs par défaut complètes pour la configuration
 */
const DEFAULT_CONFIG: AppConfig = {
  core: {
    machineId: os.hostname()
  },
  disabledApps: [],
  targets: [],
  haStackTargets: [],
  ha: {
    ws_enable: false,
    mqtt_enable: false,
    ws: {
      host: '',
      port: 8123,
      token: '',
      reconnect_delay: 5,
    },
    structure: {
      include_unassigned: false,
      unassigned_label: 'Non assigné',
    },
  },
  web: {
    port: 8080,
    host: '0.0.0.0',
  },
  logging: {
    level: 'info',
    rotate: {
      max_size_mb: 10,
      max_files: 5,
    },
  },
};

/**
 * Deep merge : fusionne les valeurs par défaut avec la config fournie.
 * `null` est traité comme "non fourni" au même titre que `undefined` : aucun champ du schéma
 * n'accepte `null` (schema.ts), donc un YAML édité à la main avec une clé laissée vide
 * (`token:` sans valeur → `null` en YAML, pas `""`) doit retomber sur la valeur par défaut, pas
 * écraser silencieusement celle-ci avec `null` — bug réel constaté en production : le fichier
 * réécrit par l'UI ne peut pas produire ce cas (ConfigWriter.save() valide avant écriture), mais
 * un config.yaml pré-rempli à la main avant le premier démarrage le peut, et provoquait un crash
 * ("Expected string, received null") en boucle au démarrage plutôt que le message habituel
 * "required" ou le repli sur "section non configurée".
 */
function deepMerge<T>(defaults: T, input: Partial<T>): T {
  const result = { ...defaults };
  for (const key in input) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined && input[key] !== null) {
      if (input[key] && typeof input[key] === 'object' && typeof result[key] === 'object' && !Array.isArray(input[key])) {
        result[key] = deepMerge(result[key] as any, input[key] as any);
      } else {
        result[key] = input[key] as any;
      }
    }
  }
  return result;
}

/**
 * Chargeur de configuration.
 * Lit et valide le fichier YAML de configuration.
 * Applique les valeurs par défaut aux champs manquants.
 */
export class ConfigLoader {
  private readonly configPath: string;
  private readonly schema: any;
  private readonly appDataRoot?: string;

  /**
   * @param configPath - Chemin vers le config.yaml du socle (default: /app/data/core/config.yaml)
   * @param schema - Schéma Zod (default: configSchema)
   * @param appDataRoot - Répertoire `data/` contenant un sous-dossier par application
   *   (`{appDataRoot}/{app}/config.yaml`) — si fourni, chaque section d'app est fusionnée dans
   *   l'objet retourné par `load()` sous sa propre clé, en plus de `ha`/`web`/`logging`. Si
   *   omis, comportement inchangé (un seul fichier) — utilisé par `config.test.ts`, qui ne
   *   connaît pas cette notion de sous-dossiers par app.
   */
  constructor(
    configPath: string = process.env.CONFIG_PATH || '/app/data/core/config.yaml',
    schema: any = configSchema,
    appDataRoot?: string
  ) {
    this.configPath = configPath;
    this.schema = schema;
    this.appDataRoot = appDataRoot;
  }

  /**
   * Charge et valide la configuration. Un fichier manquant n'est PAS une erreur fatale : il est
   * créé avec les valeurs par défaut (`DEFAULT_CONFIG`), comme le fait déjà tout autre
   * `ConfigFileManager` du projet (RFXCOM/AREXX/HAPLAN/EVOO7) pour son propre fichier — sans quoi
   * un premier démarrage sur une machine neuve (ex: déploiement Docker, `data/` vide) plante
   * immédiatement plutôt que d'afficher une UI vierge à configurer (comportement pourtant déjà
   * documenté ailleurs : "l'UI reste accessible même si HA n'est pas configuré", `PresentationServer`).
   * @returns AppConfig typé avec valeurs par défaut
   * @throws Error si YAML invalide ou validation échouée (pas si le fichier est simplement absent)
   */
  load(): AppConfig {
    if (!fs.existsSync(this.configPath)) {
      this.createDefaultConfigFile();
    }

    const fileContent = fs.readFileSync(this.configPath, 'utf-8');

    let parsedConfig: unknown;
    try {
      parsedConfig = yaml.load(fileContent);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown YAML parsing error';
      throw new Error(`Invalid YAML in configuration file: ${errorMessage}`);
    }

    const configWithDefaults = deepMerge(DEFAULT_CONFIG, parsedConfig as Partial<AppConfig>);
    this.omitDisabledHaSections(configWithDefaults);

    if (this.appDataRoot) {
      this.mergeAppSections(configWithDefaults as Record<string, unknown>);
    }

    try {
      return this.schema.parse(configWithDefaults);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorDetails = error.errors
          .map((err: any) => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        throw new Error(`Configuration validation failed: ${errorDetails}`);
      }
      throw new Error(`Configuration validation error: ${error}`);
    }
  }

  /**
   * `ha.ws`/`ha.mqtt` sont `.optional()` dans le schéma (voir schema.ts), mais `DEFAULT_CONFIG`
   * peuple `ws` avec un objet complet (host/token vides) pour que le *merge* de defaults
   * fonctionne correctement sur une config partielle (ex: `ha.ws.port` fourni sans `host`/`token`
   * — voir "should apply defaults for minimal config"). Conséquence : sur une config fraîche où
   * l'utilisateur n'a jamais rien saisi, `ws.host`/`ws.token` vides restent quand même validés
   * (`min(1)`), même si `ws_enable: false` — la connexion WS n'a pourtant aucune importance tant
   * qu'elle est désactivée.
   *
   * Retire `ws`/`mqtt` juste avant validation **uniquement** quand leur flag `_enable`
   * correspondant est `false` ET que la section n'a jamais été réellement renseignée (tous ses
   * champs obligatoires encore vides) — jamais si l'utilisateur a de vraies données en attente
   * (désactivé temporairement mais prêt à être réactivé) : dans ce cas la validation stricte reste
   * utile pour signaler une saisie partielle/invalide, comme avant ce correctif.
   */
  private omitDisabledHaSections(config: Record<string, unknown>): void {
    const ha = config.ha as Record<string, unknown> | undefined;
    if (!ha) return;
    if (ha.ws_enable !== true && this.isUnconfigured(ha.ws, ['host', 'token'])) delete ha.ws;
    if (ha.mqtt_enable !== true && this.isUnconfigured(ha.mqtt, ['host', 'client_id'])) delete ha.mqtt;
  }

  /** Vrai si `section` est absente, ou si tous les champs listés y sont vides/falsy. */
  private isUnconfigured(section: unknown, requiredStringFields: string[]): boolean {
    if (!section || typeof section !== 'object') return true;
    return requiredStringFields.every((field) => !(section as Record<string, unknown>)[field]);
  }

  /**
   * Crée `configPath` avec `DEFAULT_CONFIG` — appelé uniquement quand le fichier n'existe pas
   * encore. `ha.ws_enable`/`ha.mqtt_enable` restent à `false` par défaut, donc ce fichier fraîchement
   * créé ne tente aucune connexion tant que l'utilisateur n'a pas renseigné HA/MQTT via l'UI.
   */
  private createDefaultConfigFile(): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, yaml.dump(DEFAULT_CONFIG, { indent: 2, sortKeys: false }), 'utf-8');
  }

  /**
   * Fusionne `{appDataRoot}/{app}/config.yaml` (un sous-dossier par application, chacun un objet
   * nu — pas de clé d'app en tête, le dossier fait déjà cette distinction) dans `target`, sous la
   * clé `{app}`. Miroir de l'ancien `.passthrough()` sur un seul fichier : une app absente ou sans
   * fichier n'apparaît simplement pas, pas d'erreur.
   */
  private mergeAppSections(target: Record<string, unknown>): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.appDataRoot!, { withFileTypes: true });
    } catch {
      return; // data/ absent ou pas encore créé (première installation) — rien à fusionner
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'core') continue;

      const sectionPath = path.join(this.appDataRoot!, entry.name, 'config.yaml');
      if (!fs.existsSync(sectionPath)) continue;

      try {
        const parsed = yaml.load(fs.readFileSync(sectionPath, 'utf-8'));
        target[entry.name] = parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid YAML in ${sectionPath}: ${message}`);
      }
    }
  }
}

export { configSchema };
