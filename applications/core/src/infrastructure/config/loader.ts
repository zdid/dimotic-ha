import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { AppConfig, configSchema, generateRandomMachineId } from './schema';
import {
  readLayered,
  layersExist,
  writeLayered,
  migrateLayered,
  setMachineValue,
  CORE_DECLARATION,
  APP_DECLARATIONS,
  DATA_RENAMES
} from './layers';

/**
 * Valeurs par défaut complètes pour la configuration
 */
const DEFAULT_CONFIG: AppConfig = {
  core: {
    machineId: generateRandomMachineId(),
    site: '',
    appGossipIntervalSeconds: 300
  },
  disabledApps: [],
  targets: [],
  haStackTargets: [],
  zigbee2mqttTargets: [],
  externalSites: [],
  diffusion: {},
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
    // ⭐ 25/08/2026 : 8080 → 8087. Rencontré en réel sur stfort — l'ancien système dimotic legacy
    // occupe déjà 8080 sur cette machine (network_mode: host, pas de remapping possible), ce qui
    // faisait échouer le HEALTHCHECK Docker (ciblait 8080 en dur, voir Dockerfile) même quand
    // dimotic-ha tournait correctement sur un port différent. Le HEALTHCHECK lit maintenant le
    // port réellement configuré (voir Dockerfile) — ce changement de défaut réduit surtout le
    // risque de collision avec d'autres services déjà installés sur 8080.
    port: 8087,
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
/**
 * ⭐ 01/10/2026 — démarrage tolérant : une section `ha.ws` ou `ha.mqtt` INVALIDE (ex. hôte sans jeton, laissée
 * ainsi par une diffusion entre machines) ne fait plus planter tout le core. La connexion concernée est
 * désactivée en mémoire (`ws_enable`/`mqtt_enable` à false), les valeurs fautives sont conservées pour être
 * corrigées dans l'IHM, et l'anomalie est listée ici (voir `ConfigLoader.getLoadIssues()`).
 */
export interface ConfigLoadIssue {
  /** Section concernée : `ha.ws` ou `ha.mqtt`. */
  section: 'ha.ws' | 'ha.mqtt';
  /** Messages de validation (chemin : message). */
  messages: string[];
  /** Valeur de `ws_enable` / `mqtt_enable` dans le fichier, AVANT la désactivation en mémoire — à restituer à l'écriture. */
  wasEnabled: boolean;
}

export class ConfigLoader {
  private loadIssues: ConfigLoadIssue[] = [];
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
    // ⭐ 29/09/2026 — trois fichiers (config.yaml / machine_config.yaml / secrets_config.yaml, voir
    // layers.ts) : l'installation est neuve seulement si AUCUN n'existe.
    const coreDir = path.dirname(this.configPath);
    if (!layersExist(coreDir)) {
      this.createDefaultConfigFile();
      this.createdByThisProcess = true;
    }

    let parsedConfig: unknown;
    try {
      parsedConfig = readLayered(coreDir).merged ?? {};
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown YAML parsing error';
      throw new Error(`Invalid YAML in configuration file: ${errorMessage}`);
    }

    const configWithDefaults = deepMerge(DEFAULT_CONFIG, parsedConfig as Partial<AppConfig>);
    this.ensureMachineIdPersisted(parsedConfig as Partial<AppConfig> | null | undefined, configWithDefaults);
    this.omitDisabledHaSections(configWithDefaults);

    if (this.appDataRoot) {
      this.mergeAppSections(configWithDefaults as Record<string, unknown>);
    }

    this.loadIssues = [];
    try {
      return this.schema.parse(configWithDefaults);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const tolerated = this.tryTolerantHaLoad(configWithDefaults, error);
        if (tolerated) return tolerated as AppConfig;
        const errorDetails = error.errors
          .map((err: any) => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        throw new Error(`Configuration validation failed: ${errorDetails}`);
      }
      throw new Error(`Configuration validation error: ${error}`);
    }
  }

  /** Anomalies tolérées au dernier `load()` (sections HA invalides désactivées en mémoire) ; vide si tout est valide. */
  getLoadIssues(): ConfigLoadIssue[] {
    return this.loadIssues.map((i) => ({ section: i.section, messages: [...i.messages], wasEnabled: i.wasEnabled }));
  }

  /**
   * Démarrage tolérant (⭐ 01/10/2026) : si TOUTES les erreurs de validation portent sur `ha.ws` et/ou `ha.mqtt`,
   * valide le reste sans ces sections (donc le core démarre, l'IHM reste accessible), désactive la connexion
   * concernée et remet les valeurs brutes pour qu'elles se corrigent dans l'IHM. Toute erreur ailleurs
   * (port web, logging, schéma d'une application…) reste bloquante : retourne `undefined`.
   */
  private tryTolerantHaLoad(config: Record<string, any>, error: z.ZodError): Record<string, any> | undefined {
    const issues = new Map<'ha.ws' | 'ha.mqtt', string[]>();
    for (const err of error.errors) {
      const section = err.path[0] === 'ha' && (err.path[1] === 'ws' || err.path[1] === 'mqtt') ? (`ha.${err.path[1]}` as 'ha.ws' | 'ha.mqtt') : undefined;
      if (!section) return undefined;
      issues.set(section, [...(issues.get(section) ?? []), `${err.path.join('.')} : ${err.message}`]);
    }
    const rawWs = config.ha?.ws;
    const rawMqtt = config.ha?.mqtt;
    const wasEnabled = { 'ha.ws': config.ha?.ws_enable === true, 'ha.mqtt': config.ha?.mqtt_enable === true };
    const stripped = { ...config, ha: { ...config.ha } };
    if (issues.has('ha.ws')) { delete stripped.ha.ws; stripped.ha.ws_enable = false; }
    if (issues.has('ha.mqtt')) { delete stripped.ha.mqtt; stripped.ha.mqtt_enable = false; }
    let parsed: Record<string, any>;
    try {
      parsed = this.schema.parse(stripped);
    } catch {
      return undefined;                                  // une autre erreur, masquée jusque-là : on ne tolère pas
    }
    if (issues.has('ha.ws')) parsed.ha.ws = rawWs;
    if (issues.has('ha.mqtt')) parsed.ha.mqtt = rawMqtt;
    this.loadIssues = [...issues].map(([section, messages]) => ({ section, messages, wasEnabled: wasEnabled[section] }));
    for (const issue of this.loadIssues) {
      console.error(`[ConfigLoader] ${issue.section} invalide — connexion désactivée, démarrage poursuivi : ${issue.messages.join(' ; ')}`);
    }
    return parsed;
  }

  /**
   * ⭐ 06/09/2026 — `core.machineId` doit rester STABLE une fois généré (voir generateRandomMachineId
   * dans schema.ts), ce que le seul défaut Zod ne garantit pas : un défaut Zod se recalcule à
   * chaque `parse()` tant que la valeur n'est pas écrite sur le fichier, donc à chaque redémarrage
   * tant qu'on ne persiste rien explicitement — l'identité de la machine changerait alors à chaque
   * redémarrage, cassant le gossip inter-machines et les topics MQTT du superviseur qui en
   * dépendent. Si le fichier RÉEL sur disque n'a pas encore de `core.machineId` (première
   * installation, ou fichier antérieur à l'introduction de ce champ), on le génère une fois ici et
   * on l'écrit IMMÉDIATEMENT dans le fichier (fusion minimale — on ne réécrit que `core`, pas tout
   * le fichier avec les valeurs par défaut de chaque section, pour rester proche de ce que
   * l'utilisateur a réellement saisi).
   */
  private ensureMachineIdPersisted(rawConfig: Partial<AppConfig> | null | undefined, configWithDefaults: AppConfig): void {
    if ((rawConfig as any)?.core?.machineId) return; // déjà présent sur disque, rien à faire
    // ⭐ 29/09/2026 — écrit dans machine_config.yaml (propre à la machine, jamais reproduit).
    try {
      setMachineValue(path.dirname(this.configPath), 'core.machineId', configWithDefaults.core.machineId);
    } catch {
      // Best-effort : si l'écriture échoue (permissions, disque plein...), configWithDefaults
      // reste utilisable pour CE démarrage — seul un futur redémarrage regénérerait un id différent.
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
   * Retire `mqtt` uniquement quand `mqtt_enable` est `false` ET que la section n'a jamais été
   * réellement renseignée (tous ses champs obligatoires encore vides) — jamais si l'utilisateur a
   * de vraies données en attente (désactivé temporairement mais prêt à être réactivé) : dans ce
   * cas la validation stricte reste utile pour signaler une saisie partielle/invalide.
   *
   * `ws` est retiré dès qu'il est intégralement vide, **même si `ws_enable: true`** (⭐ 24/08/2026,
   * revu suite à un vrai crash au démarrage) : ConfigService.clearHaWsToken() efface tout le bloc
   * `ws` sur un token invalidé par HA lui-même, sans toucher à `ws_enable` (signal exploité par
   * CoreDeployService pour refuser de déployer avec un HA WS voulu-mais-cassé) — sans cet
   * assouplissement, le *prochain* redémarrage validerait `ws` intégralement vide contre le schéma
   * strict (`host`/`token` min(1)) et ferait planter TOUTE l'application au lieu de simplement ne
   * pas se connecter à HA. Un `ws` PARTIELLEMENT rempli (ex: host renseigné, token oublié) reste lui
   * validé strictement dans tous les cas — seule l'absence totale est tolérée.
   */
  private omitDisabledHaSections(config: Record<string, unknown>): void {
    const ha = config.ha as Record<string, unknown> | undefined;
    if (!ha) return;
    if (this.isUnconfigured(ha.ws, ['host', 'token'])) delete ha.ws;
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
  /** ⭐ 24/09/2026 — vrai si CE process a dû créer le fichier (installation neuve) : distingue une
   *  installation neuve (toutes les applications désactivées) d'une mise à jour d'une installation
   *  existante (état activé/désactivé conservé) quand `knownApps` n'existe pas encore. */
  private createdByThisProcess = false;

  wasCreatedByThisProcess(): boolean {
    return this.createdByThisProcess;
  }

  private createDefaultConfigFile(): void {
    writeLayered(path.dirname(this.configPath), DEFAULT_CONFIG as unknown as Record<string, unknown>, CORE_DECLARATION);
  }

  /**
   * ⭐ 29/09/2026 (techniques-diffusion-data_specs §8, temps 1) — migration vers les trois fichiers,
   * À APPELER PAR LE SEUL PROCESS DU CORE avant le premier load() (jamais par les applications en
   * process séparé, qui ne font que lire). Idempotente, refaite à chaque démarrage :
   * - core et applications déclarées : chemins machine/secrets sortis de config.yaml ;
   * - renommages de fichiers propres à la machine (layers.DATA_RENAMES : clé SSH, ha-structure-*,
   *   ia/comparatif.log, arexx/drivers/).
   * Retourne un compte rendu (une ligne par changement) pour le journal.
   */
  migrate(): string[] {
    const report: string[] = [];
    const coreDir = path.dirname(this.configPath);
    const dataRoot = this.appDataRoot ?? path.dirname(coreDir);
    const history = (app: string) => path.join(dataRoot, 'core', 'machine_diffusion', 'historique', app);

    const coreMoved = migrateLayered(coreDir, CORE_DECLARATION, history('core'));
    if (coreMoved.length) report.push(`core : ${coreMoved.join(', ')} → machine_config.yaml / secrets_config.yaml`);
    for (const [app, decl] of Object.entries(APP_DECLARATIONS)) {
      const moved = migrateLayered(path.join(dataRoot, app), decl, history(app));
      if (moved.length) report.push(`${app} : ${moved.join(', ')} → machine_config.yaml / secrets_config.yaml`);
    }

    for (const [from, to] of DATA_RENAMES) {
      const src = path.join(dataRoot, from);
      const dst = path.join(dataRoot, to);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.renameSync(src, dst);
        report.push(`${from} → ${to}`);
      }
    }
    return report;
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

      // ⭐ 29/09/2026 — config.yaml + machine_config.yaml + secrets_config.yaml fusionnés (layers.ts).
      const appDir = path.join(this.appDataRoot!, entry.name);
      if (!layersExist(appDir)) continue;
      target[entry.name] = readLayered(appDir).merged;
    }
  }
}

export { configSchema };
