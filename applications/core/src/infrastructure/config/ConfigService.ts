import type { z } from 'zod';
import { AppConfig, HaConfig, MqttConfig, WebConfig, LoggingConfig, DeploymentTargetConfig, HaStackTargetConfig } from './schema';
import { ConfigLoader } from './loader';
import { ConfigWriter, SaveResult } from './writer';
import type { Logger } from '../logger/index';

/**
 * Service centralisé d'accès à la configuration.
 * 
 * **Pattern :**
 * - Instancié UNE SEULE FOIS dans index.ts (bootstrap)
 * - Injecté dans les services via leurs constructeurs
 * - PAS de singleton global, PAS de méthodes statiques
 * 
 * **Règles :**
 * - Les couches ne lisent PAS config.yaml directement
 * - Les couches ne connaissent PAS ConfigLoader/ConfigWriter
 * - Toute modification de config passe par ConfigWriter (déclenché par Socket.io)
 * 
 * **Exemple d'utilisation :**
 * ```typescript
 * // index.ts (bootstrap)
 * const configService = new ConfigService();
 * const logger = new Logger(configService.getLoggingConfig());
 * const haWsClient = new HaWsClient(configService.getHaWsConfig());
 * 
 * // Dans un service (couche HA)
 * class HaSyncService {
 *   constructor(private configService: ConfigService) {}
 *   
 *   connect() {
 *     const wsConfig = this.configService.getHaWsConfig();
 *     // Utiliser wsConfig.host, wsConfig.port, etc.
 *   }
 * }
 * ```
 */
export class ConfigService {
  private config: AppConfig;
  private readonly loader: ConfigLoader;
  private readonly writer: ConfigWriter;
  private readonly logger: Logger;
  // Schéma Zod de chaque module, enregistré dynamiquement par AppService au chargement
  // (module.{moduleId}ConfigSchema, convention suivie par toutes les apps métier) — permet à
  // saveModuleConfig() de valider une section avant écriture, au lieu de tout laisser passer via
  // le .passthrough() de configSchema (qui ne valide que ha/web/logging, jamais les modules).
  private readonly moduleSchemas = new Map<string, z.ZodType>();

  /**
   * @param loader - ConfigLoader pour charger la configuration (default: new ConfigLoader())
   * @param writer - ConfigWriter pour sauvegarder la configuration (default: new ConfigWriter())
   * @param logger - Logger pour les logs
   */
  constructor(
    loader: ConfigLoader = new ConfigLoader(),
    writer: ConfigWriter = new ConfigWriter(),
    logger: Logger
  ) {
    this.loader = loader;
    this.writer = writer;
    this.logger = logger;
    this.config = this.loader.load();
  }

  /**
   * Retourne la configuration complète.
   * **À utiliser avec parcimonie** - préférer les méthodes typées ci-dessous.
   */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * Retourne la configuration Home Assistant.
   */
  getHaConfig(): HaConfig | undefined {
    return this.config.ha ? { ...this.config.ha } : undefined;
  }

  /**
   * Retourne la configuration WebSocket HA.
   */
  getHaWsConfig() {
    return this.config.ha?.ws ? { ...this.config.ha.ws } : undefined;
  }

  /**
   * Retourne la configuration de structuration HA.
   */
  getHaStructureConfig() {
    return this.config.ha?.structure ? { ...this.config.ha.structure } : undefined;
  }

  /**
   * Retourne la configuration MQTT (ou undefined si non présente).
   */
  getMqttConfig(): MqttConfig | undefined {
    return this.config.ha?.mqtt ? { ...this.config.ha.mqtt } : undefined;
  }

  /**
   * Retourne la configuration Web.
   */
  getWebConfig(): WebConfig {
    return { ...this.config.web };
  }

  /**
   * Retourne la configuration de logging.
   */
  getLoggingConfig(): LoggingConfig {
    return { ...this.config.logging };
  }

  /**
   * Sauvegarde une nouvelle configuration (via ConfigWriter).
   * **À utiliser uniquement** pour la configuration métier (pas pour HA/MQTT bas niveau).
   * 
   * @param newConfig - Nouvelle configuration complète
   * @returns Résultat de la sauvegarde
   */
  saveConfig(newConfig: AppConfig): SaveResult {
    console.log('[ConfigService SERVEUR] Sauvegarde configuration globale');
    console.log('[ConfigService SERVEUR] Config complète:', JSON.stringify(newConfig, null, 2));
    // Le client envoie l'objet fusionné complet (TechnicalConfigManager.config, qui reflète
    // config:current — toutes les sections d'app y compris), mais depuis la restructuration
    // data/{app}/ ce endpoint ne possède plus que le socle : on ne retient que ha/web/logging,
    // le reste (sections d'app) est ignoré ici, chacune ayant désormais son propre chemin de
    // sauvegarde (savePartialConfig/saveModuleConfig, vers son propre fichier).
    //
    // disabledApps fait exception : il vit dans CE MÊME fichier (pas un fichier par module), mais
    // le client (formulaire Web-Services) ne le connaît pas et ne l'envoie jamais — repris depuis
    // this.config (état en mémoire, source de vérité) plutôt que newConfig, sinon toute sauvegarde
    // de ce formulaire effaçait silencieusement la liste des applications désactivées (bug réel
    // constaté le 07/08/2026 sur ha2 : RFXCOM réactivé après une simple reconfiguration HA WS).
    // targets/haStackTargets (⭐ 23-24/08/2026, cibles de déploiement de dimotic-ha lui-même et de
    // Home Assistant+Mosquitto) : même risque, même traitement préventif — jamais envoyés par ce
    // formulaire non plus.
    const socleConfig = {
      ha: newConfig.ha,
      web: newConfig.web,
      logging: newConfig.logging,
      disabledApps: this.config.disabledApps,
      targets: this.config.targets,
      haStackTargets: this.config.haStackTargets,
    } as AppConfig;
    const result = this.writer.save(socleConfig);
    console.log('[ConfigService SERVEUR] Résultat sauvegarde:', result);
    return result;
  }

  /**
   * Sauvegarde une section partielle de la configuration.
   * Utile pour mettre à jour uniquement une partie.
   * 
   * @param section - Nom de la section à sauvegarder
   * @param partialConfig - Configuration partielle de la section
   * @returns Résultat de la sauvegarde
   */
  savePartialConfig<T extends keyof AppConfig>(section: T, partialConfig: AppConfig[T]): SaveResult {
    const result = this.writer.saveModuleFile(section as string, partialConfig);
    // Rafraîchit la vue en mémoire immédiatement après un succès — jusqu'ici cette méthode
    // n'avait aucun effet sur this.config, obligeant l'appelant à faire un reload() explicite
    // pour voir sa propre écriture (piège rencontré en direct sur RFXCOM/protocoles cette
    // session : le fichier était bien à jour, mais this.config restait périmé jusqu'au prochain
    // redémarrage). saveModuleConfig() ci-dessous le faisait déjà ; même comportement ici.
    if (result.success) {
      this.config = { ...this.config, [section]: partialConfig };
    }
    return result;
  }

  /**
   * Recharge la configuration depuis le fichier.
   * Utile pour les tests ou après une modification externe.
   */
  reload(): void {
    this.config = this.loader.load();
  }

  /**
   * Retourne la liste des applications désactivées (ApplicationManager.ts).
   */
  getDisabledApps(): string[] {
    return this.config.disabledApps ? [...this.config.disabledApps] : [];
  }

  /**
   * Sauvegarde la liste des applications désactivées, dans le même fichier que ha/web/logging
   * (data/core/config.yaml) — même narrowing que saveConfig() : les sections de module ne
   * transitent jamais par ce chemin, chacune a son propre fichier (saveModuleConfig).
   */
  setDisabledApps(disabledApps: string[]): SaveResult {
    const socleConfig = { ha: this.config.ha, web: this.config.web, logging: this.config.logging, disabledApps, targets: this.config.targets, haStackTargets: this.config.haStackTargets } as AppConfig;
    const result = this.writer.save(socleConfig);
    if (result.success) {
      this.config = { ...this.config, disabledApps };
    }
    return result;
  }

  /**
   * Retourne la liste des cibles de déploiement de dimotic-ha lui-même (⭐ 23/08/2026, voir
   * CoreDeployService.ts) — même patron que getDisabledApps().
   */
  getTargets(): DeploymentTargetConfig[] {
    return this.config.targets ? [...this.config.targets] : [];
  }

  /**
   * Sauvegarde la liste des cibles de déploiement, même narrowing que setDisabledApps() (préserve
   * ha/web/logging/disabledApps/haStackTargets depuis this.config, jamais depuis un payload client
   * partiel).
   */
  setTargets(targets: DeploymentTargetConfig[]): SaveResult {
    const socleConfig = { ha: this.config.ha, web: this.config.web, logging: this.config.logging, disabledApps: this.config.disabledApps, targets, haStackTargets: this.config.haStackTargets } as AppConfig;
    const result = this.writer.save(socleConfig);
    if (result.success) {
      this.config = { ...this.config, targets };
    }
    return result;
  }

  /**
   * Retourne la liste des cibles de déploiement Home Assistant + Mosquitto (⭐ nouveau 24/08/2026,
   * voir HaStackDeployService.ts) — liste séparée de `targets`, même patron sinon.
   */
  getHaStackTargets(): HaStackTargetConfig[] {
    return this.config.haStackTargets ? [...this.config.haStackTargets] : [];
  }

  /**
   * Sauvegarde la liste des cibles HA+Mosquitto, même narrowing défensif que setTargets().
   */
  setHaStackTargets(haStackTargets: HaStackTargetConfig[]): SaveResult {
    const socleConfig = { ha: this.config.ha, web: this.config.web, logging: this.config.logging, disabledApps: this.config.disabledApps, targets: this.config.targets, haStackTargets } as AppConfig;
    const result = this.writer.save(socleConfig);
    if (result.success) {
      this.config = { ...this.config, haStackTargets };
    }
    return result;
  }

  /**
   * Configurations par défaut pour les sections de modules
   * Utilisées pour auto-initialiser les sections manquantes
   * 
   * NOTE: Les modules peuvent enregistrer leurs propres configurations par défaut
   * dynamiquement via le mécanisme d'enregistrement des modules.
   */
  private static DEFAULT_MODULE_CONFIGS: Record<string, unknown> = {};

  /**
   * Vérifie et initialise les sections de configuration manquantes pour les modules.
   * Si une section n'existe pas dans la config mais que le module est détecté,
   * elle est créée avec ses valeurs par défaut.
   * 
   * @param moduleIds - Liste des identifiants de modules détectés
   */
  ensureModuleSections(moduleIds: string[]): void {
    for (const moduleId of moduleIds) {
      // Vérifier si la section existe déjà dans la config
      if (this.config[moduleId as keyof AppConfig] === undefined) {
        // Vérifier si on a une config par défaut pour ce module
        const defaultConfig = (ConfigService.DEFAULT_MODULE_CONFIGS as Record<string, unknown>)[moduleId];

        if (defaultConfig) {
          // Chaque module a son propre fichier (data/{moduleId}/config.yaml) depuis la
          // restructuration — écrire directement dedans, pas de sauvegarde groupée possible/
          // nécessaire (ce chemin reste inatteint en pratique tant que DEFAULT_MODULE_CONFIGS
          // n'est peuplé par aucun module).
          const result = this.writer.saveModuleFile(moduleId, defaultConfig);
          if (result.success) {
            (this.config as Record<string, unknown>)[moduleId] = defaultConfig;
            this.logger.info('ConfigService', `Section '${moduleId}' initialisée avec les valeurs par défaut`);
          } else {
            this.logger.error('ConfigService', `Échec d'initialisation de la section '${moduleId}': ${result.error}`);
          }
        } else {
          this.logger.warn('ConfigService', `Pas de configuration par défaut pour le module '${moduleId}'`);
        }
      }
    }
  }

  /**
   * Récupère la configuration d'un module spécifique.
   * @param moduleId - Identifiant du module
   * @returns La configuration du module ou undefined si non trouvée
   */
  getModuleConfig<T>(moduleId: string): T | undefined {
    return (this.config as Record<string, unknown>)[moduleId] as T | undefined;
  }

  /**
   * Sauvegarde la configuration d'un module spécifique.
   * @param moduleId - Identifiant du module
   * @param config - Configuration du module à sauvegarder
   * @returns Résultat de la sauvegarde
   */
  /**
   * Enregistre le schéma Zod d'un module — appelé par AppService au chargement de chaque
   * application (voir module.{moduleId}ConfigSchema). Permet à saveModuleConfig() de valider
   * la section avant écriture ; sans schéma enregistré pour ce moduleId, la sauvegarde procède
   * sans validation dédiée (comportement antérieur, pour ne pas bloquer un module qui n'en
   * fournit pas).
   */
  registerModuleSchema(moduleId: string, schema: z.ZodType): void {
    this.moduleSchemas.set(moduleId, schema);
  }

  saveModuleConfig<T>(moduleId: string, config: T): SaveResult {
    console.log('[ConfigService SERVEUR] Sauvegarde configuration module - moduleId:', moduleId);
    console.log('[ConfigService SERVEUR] Config module:', JSON.stringify(config, null, 2));

    // Valeur effectivement écrite : la sortie de Zod (validation.data), pas `config` brut — un
    // schéma peut porter un .transform() qui normalise/recalcule des champs (ex: discoveryTopics
    // de Nommage, dérivé de topicPrefix) ; utiliser `config` tel quel ignorerait cette
    // normalisation et écrirait la valeur brute soumise par le client.
    let configToSave: unknown = config;

    const schema = this.moduleSchemas.get(moduleId);
    if (schema) {
      const validation = schema.safeParse(config);
      if (!validation.success) {
        const errorDetails = validation.error.errors
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join('; ');
        const error = `Validation échouée pour le module "${moduleId}": ${errorDetails}`;
        this.logger.warn('ConfigService', error);
        return { success: false, error };
      }
      configToSave = validation.data;
    }

    const result = this.writer.saveModuleFile(moduleId, configToSave);
    console.log('[ConfigService SERVEUR] Résultat sauvegarde module:', result);
    if (result.success) {
      this.config = { ...this.config, [moduleId]: configToSave } as AppConfig;
    }
    return result;
  }
}

export { AppConfig, HaConfig, MqttConfig, WebConfig, LoggingConfig };
