// =============================================================================
// IntegrationBridge — Orchestrateur EventBus ↔ HaMqttIntegrationService
//
// Écoute les événements des modules d'intégration (découverte, état, commandes,
// passthrough) et pilote HaMqttIntegrationService en conséquence. Gère
// l'activation/désactivation dynamique via `ha.mqtt_enable`.
//
// Conforme à techniques-socle-ha-mqtt_specs v4.9 §8.5 et integrationbridge-mqtt-auto_specs.
// =============================================================================

import type { IEventBus } from '../../application/IEventBus';
import type { Logger } from '../../infrastructure/logger/index';
import type { ConfigService } from '../../infrastructure/config/ConfigService';
import { HaMqttIntegrationService, type HaMqttBrokerConfig } from './HaMqttIntegrationService';
import type { EssentialEntityData } from './discovery';
import type { HaMqttStateMessage } from './types/ha-mqtt';
import type { AreaEnsureService } from '../sync/AreaEnsureService';

// =============================================================================
// Types des événements EventBus (voir techniques-socle-ha-mqtt_specs §8.5.5)
// =============================================================================

export interface BridgeRegisterEvent {
  moduleName: string;
  bridgeInstance: string;
}

export interface DiscoveryRequestEvent {
  bridgeInstance: string;
  component: string;
  objectId: string;
  deviceId: string;
  essential: EssentialEntityData;
}

export interface DiscoveryRemoveRequestEvent {
  bridgeInstance: string;
  component: string;
  objectId: string;
}

export interface StateRequestEvent {
  bridgeInstance: string;
  deviceId: string;
  state: HaMqttStateMessage;
  /** Défaut true (comportement historique). RFXCOM passe false pour ses états device (voir
   *  RfxComService) — sinon chaque reconnexion MQTT du pont ancien-système (rfxcombridge.js)
   *  fait rejouer tous les états retenus d'un coup, noyant rfxcomserv.js sous des évènements
   *  redondants (constaté le 17/08/2026). */
  retain?: boolean;
}

export interface PassthroughDiscoveryRequestEvent {
  bridgeInstance: string;
  sourceTopic: string;
  payload: unknown;
}

export interface PassthroughPublishRequestEvent {
  bridgeInstance: string;
  topic: string;
  payload: unknown;
  qos?: 0 | 1;
  retain?: boolean;
}

/** ⭐ fonctionnelles-supervisor_specs v2.3 §9.4 : demande d'abonnement à un topic arbitraire (RFXCOM
 *  §9.4, wildcards MQTT supportés) sur la connexion déjà ouverte du bridge. */
export interface PassthroughSubscribeRequestEvent {
  bridgeInstance: string;
  topic: string;
  qos?: 0 | 1;
}

/** Message reçu sur un topic souscrit via integration:{module}:passthrough:subscribe. */
export interface PassthroughMessageEvent {
  bridgeInstance: string;
  topic: string;
  payload: string;
}

interface ConfigSaveResult {
  success: boolean;
  error?: string;
}

// =============================================================================
// IntegrationBridge
// =============================================================================

export class IntegrationBridge {
  private readonly eventBus: IEventBus;
  private readonly logger: Logger;
  private readonly configService: ConfigService;
  private readonly haMqttService: HaMqttIntegrationService;
  private mqttEnabled: boolean;
  /** Optionnel : absent si ha.ws_enable est désactivé (Mode A/B indépendants) — voir attachAreaEnsureService. */
  private areaEnsureService?: AreaEnsureService;

  /** Bridges enregistrés par les modules, indépendamment de l'état connecté/déconnecté. */
  private registeredBridges: Map<string, BridgeRegisterEvent> = new Map();

  /** Clés (`{moduleName}:{bridgeInstance}`) des bridges actuellement connectés — sert à dériver
   *  un statut MQTT agrégé unique (`mqtt:connected`/`mqtt:disconnected`, voir §11 du socle pour
   *  l'indicateur équivalent côté HA WebSocket) : un bridge par application métier existe, mais
   *  le tableau de bord principal n'affiche qu'un seul voyant MQTT global. */
  private connectedBridgeKeys: Set<string> = new Set();

  constructor(eventBus: IEventBus, logger: Logger, configService: ConfigService) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.configService = configService;
    this.haMqttService = new HaMqttIntegrationService(logger);
    this.mqttEnabled = this.configService.getConfig().ha?.mqtt_enable === true;

    this.logger.info('bridge', this.mqttEnabled ? 'MQTT est ACTIF (ha.mqtt_enable: true)' : 'MQTT est DESACTIVE (ha.mqtt_enable: false)');
  }

  /**
   * Attache le service de garantie d'area HA — optionnel, absent si ha.ws_enable est désactivé
   * (Mode A, indépendant du Mode B/MQTT ici). Sans lui, device.suggested_area en découverte reste
   * sans effet (comportement inchangé). Doit être appelé après la création du HaWsClient/
   * HaStructureRegistry, avant toute découverte.
   */
  attachAreaEnsureService(areaEnsureService: AreaEnsureService): void {
    this.areaEnsureService = areaEnsureService;
    this.logger.info('bridge', 'AreaEnsureService attaché');
  }

  /**
   * Configure les listeners EventBus. À appeler une fois au démarrage.
   */
  initialize(): void {
    this.eventBus.onGeneric<BridgeRegisterEvent>('integration:bridge:register', (data) => this.handleBridgeRegister(data));
    this.eventBus.onGeneric<BridgeRegisterEvent>('integration:bridge:unregister', (data) => this.handleBridgeUnregister(data));
    this.eventBus.onGeneric<ConfigSaveResult>('config:save:result', (result) => this.handleConfigSaveResult(result));

    this.haMqttService.onCommand((command) => {
      this.eventBus.emitGeneric(`integration:${command.moduleName}:command`, command);
    });

    this.haMqttService.onConnectionChange((moduleName, bridgeInstance, connected) => {
      this.eventBus.emitGeneric(`integration:${moduleName}:bridge:connection`, { bridgeInstance, connected });
      this.updateAggregateMqttStatus(moduleName, bridgeInstance, connected);
    });

    // ⭐ Second déclencheur de republication de découverte (voir HA_STATUS_TOPIC dans ha-mqtt.ts) —
    // chaque module écoute cet événement s'il veut republier sa découverte quand HA redémarre
    // sans que notre propre bridge MQTT n'ait eu besoin de se reconnecter (ex: HA seul redémarré,
    // broker resté up).
    this.haMqttService.onHaOnline((moduleName, bridgeInstance) => {
      this.eventBus.emitGeneric(`integration:${moduleName}:ha:online`, { bridgeInstance });
    });

    // ⭐ fonctionnelles-supervisor_specs v2.3 §9.4 : redistribue tout message reçu sur un topic
    // passthrough souscrit — le module d'origine (celui dont c'est la connexion) filtre lui-même
    // les topics qui l'intéressent, voir RfxComService pour l'usage réel (registered-devices).
    this.haMqttService.onPassthroughMessage((moduleName, bridgeInstance, topic, payload) => {
      this.eventBus.emitGeneric(`integration:${moduleName}:passthrough:message`, {
        bridgeInstance,
        topic,
        payload: Buffer.isBuffer(payload) ? payload.toString() : payload
      });
    });

    this.logger.info('bridge', 'IntegrationBridge initialisé');
  }

  /**
   * Enregistre un bridge_instance pour un module et écoute ses événements de
   * découverte/état/passthrough. Connecte immédiatement si MQTT est activé.
   */
  private handleBridgeRegister(data: BridgeRegisterEvent): void {
    const key = `${data.moduleName}:${data.bridgeInstance}`;
    if (this.registeredBridges.has(key)) {
      this.logger.debug('bridge', `Bridge déjà enregistré: ${key}`);
      return;
    }

    this.registeredBridges.set(key, data);
    this.subscribeModuleEvents(data.moduleName);

    if (this.mqttEnabled) {
      this.connectBridge(data);
    } else {
      this.logger.debug('bridge', `Bridge enregistré mais MQTT désactivé: ${key}`);
    }
  }

  private handleBridgeUnregister(data: BridgeRegisterEvent): void {
    const key = `${data.moduleName}:${data.bridgeInstance}`;
    this.registeredBridges.delete(key);
    this.haMqttService.disconnectBridge(data.moduleName, data.bridgeInstance);
    // Déconnexion volontaire (MqttTransport.disconnect()) : ne déclenche pas onConnectionChange
    // (contrairement à une coupure réseau involontaire) — mise à jour manuelle nécessaire.
    this.updateAggregateMqttStatus(data.moduleName, data.bridgeInstance, false);
  }

  /**
   * Dérive un statut MQTT agrégé unique (au moins un bridge connecté) à partir des
   * changements par bridge, et émet `mqtt:connected`/`mqtt:disconnected` (événements
   * persistants du socle, voir AppService.registerCoreSocketEvents) uniquement sur
   * transition — pas à chaque changement individuel de bridge.
   */
  private updateAggregateMqttStatus(moduleName: string, bridgeInstance: string, connected: boolean): void {
    const key = `${moduleName}:${bridgeInstance}`;
    const wasAnyConnected = this.connectedBridgeKeys.size > 0;

    if (connected) {
      this.connectedBridgeKeys.add(key);
    } else {
      this.connectedBridgeKeys.delete(key);
    }

    const isAnyConnected = this.connectedBridgeKeys.size > 0;
    if (isAnyConnected === wasAnyConnected) return;

    if (isAnyConnected) {
      this.eventBus.emitGeneric('mqtt:connected', undefined);
    } else {
      this.eventBus.emitGeneric('mqtt:disconnected', { reason: 'Aucun bridge MQTT connecté' });
    }
  }

  /**
   * S'abonne, pour un module donné, à ses événements de découverte/état/passthrough.
   */
  private subscribeModuleEvents(moduleName: string): void {
    this.eventBus.onGeneric<DiscoveryRequestEvent>(`integration:${moduleName}:discovery`, (data) => {
      if (!this.mqttEnabled) return;
      void this.publishDiscoveryWithArea(moduleName, data);
    });

    this.eventBus.onGeneric<DiscoveryRemoveRequestEvent>(`integration:${moduleName}:discovery:remove`, (data) => {
      if (!this.mqttEnabled) return;
      this.haMqttService.removeDiscoveryFor(moduleName, data.bridgeInstance, data.component, data.objectId);
    });

    this.eventBus.onGeneric<StateRequestEvent>(`integration:${moduleName}:state`, (data) => {
      if (!this.mqttEnabled) return;
      this.haMqttService.publishState(moduleName, data.bridgeInstance, data.deviceId, data.state, data.retain);
    });

    this.eventBus.onGeneric<PassthroughDiscoveryRequestEvent>(`integration:${moduleName}:passthrough:discovery`, (data) => {
      if (!this.mqttEnabled) return;
      void this.publishDiscoveryPassthroughWithArea(moduleName, data);
    });

    this.eventBus.onGeneric<PassthroughPublishRequestEvent>(`integration:${moduleName}:passthrough:publish`, (data) => {
      if (!this.mqttEnabled) return;
      this.haMqttService.publishPassthrough(moduleName, data.bridgeInstance, data.topic, data.payload, data.qos, data.retain);
    });

    this.eventBus.onGeneric<PassthroughSubscribeRequestEvent>(`integration:${moduleName}:passthrough:subscribe`, (data) => {
      if (!this.mqttEnabled) return;
      this.haMqttService.subscribePassthrough(moduleName, data.bridgeInstance, data.topic, data.qos);
    });
  }

  /**
   * Garantit l'area suggérée avant de publier la découverte. Best-effort par défaut (timeout,
   * n'empêche jamais la publication) — sauf si l'app appelante a activé
   * `waitForHaWsBeforeDiscovery` (RFXCOM/AREXX par défaut), auquel cas la publication attend
   * indéfiniment que l'area soit garantie (voir AreaEnsureService.ensureArea).
   */
  private async publishDiscoveryWithArea(moduleName: string, data: DiscoveryRequestEvent): Promise<void> {
    const suggestedArea = data.essential.device?.suggested_area;
    if (suggestedArea) {
      const capitalized = this.capitalizeAreaName(suggestedArea);
      if (data.essential.device) data.essential.device.suggested_area = capitalized;
      if (this.areaEnsureService) {
        await this.areaEnsureService.ensureArea(capitalized, this.shouldWaitIndefinitelyForArea(moduleName));
      }
    }
    this.haMqttService.publishDiscoveryFor(moduleName, data.bridgeInstance, data.component, data.objectId, data.deviceId, data.essential);

    // Taxonomie sur son topic dédié — seulement à la (re)découverte, jamais à chaque état (voir
    // discovery.ts::EssentialEntityData.attributsTaxonomie).
    if (data.essential.attributsTaxonomie) {
      this.haMqttService.publishAttributesFor(moduleName, data.bridgeInstance, data.component, data.objectId, data.essential.attributsTaxonomie);
    }
  }

  /** Même garantie d'area que publishDiscoveryWithArea, pour le chemin passthrough (NOMMAGE). */
  private async publishDiscoveryPassthroughWithArea(moduleName: string, data: PassthroughDiscoveryRequestEvent): Promise<void> {
    const payload = data.payload as { device?: { suggested_area?: string; name?: string } } | undefined;
    const suggestedArea = payload?.device?.suggested_area;
    if (suggestedArea) {
      const capitalized = this.capitalizeAreaName(suggestedArea);
      if (payload?.device) payload.device.suggested_area = capitalized;
      if (this.areaEnsureService) {
        await this.areaEnsureService.ensureArea(capitalized, this.shouldWaitIndefinitelyForArea(moduleName));
      }
    }

    // Même règle que RFXCOM (taxonomy.ts::buildDisplayName) : device.name raccourci (lieu précis,
    // repli sur le quoi) plutôt que la chaîne QUOI---OÙ complète — sinon redondant avec l'area HA
    // déjà donnée par suggested_area ci-dessus. Les sources passthrough (zigbee2mqtt) publient leurs
    // devices déjà nommés selon la convention QUOI---OÙ mais ne le raccourcissent jamais elles-mêmes
    // (demande utilisateur, 07/08/2026, pour aligner ce chemin sur RFXCOM).
    if (payload?.device?.name) {
      payload.device.name = this.buildShortDeviceName(payload.device.name);
    }

    this.haMqttService.publishDiscoveryPassthrough(moduleName, data.bridgeInstance, data.sourceTopic, data.payload);
  }

  /**
   * Modules pour lesquels `waitForHaWsBeforeDiscovery` vaut `true` par défaut (même liste que les
   * schémas Zod concernés — rfxcom/config-schema.ts, arexx/config-schema.ts, nommage/config-schema.ts).
   * EVOO7 n'y figure pas (conséquences jugées faibles, décision utilisateur du 08/08/2026).
   */
  private static readonly APPS_WAITING_FOR_AREA_BY_DEFAULT = new Set(['rfxcom', 'arexx', 'nommage']);

  /**
   * Lit `waitForHaWsBeforeDiscovery` dans la config du module appelant (RFXCOM/AREXX : champ
   * racine ; NOMMAGE : `ha.waitForHaWsBeforeDiscovery` — même structure que les schémas Zod
   * respectifs).
   *
   * ⚠️ `getModuleConfig()` renvoie la config TELLE QUE LUE SUR DISQUE, jamais repassée par le
   * schéma Zod (qui n'est appliqué qu'à l'écriture, voir saveModuleConfig) — un config.yaml
   * existant écrit avant l'ajout de ce champ ne le contient simplement pas. Se fier au défaut Zod
   * (`true`) aurait donc échoué silencieusement pour toute installation existante : bug réel
   * constaté en conditions réelles sur l'OrangePi (08/08/2026), champ absent du fichier, repli sur
   * `false` alors que le défaut voulu est `true`. D'où APPS_WAITING_FOR_AREA_BY_DEFAULT ci-dessus,
   * qui rejoue ce même défaut ici plutôt que de compter sur Zod pour le faire.
   */
  private shouldWaitIndefinitelyForArea(moduleName: string): boolean {
    const defaultValue = IntegrationBridge.APPS_WAITING_FOR_AREA_BY_DEFAULT.has(moduleName);
    const config = this.configService.getModuleConfig<Record<string, unknown>>(moduleName);
    if (!config) return defaultValue;

    const direct = config['waitForHaWsBeforeDiscovery'];
    if (typeof direct === 'boolean') return direct;

    const ha = config['ha'] as Record<string, unknown> | undefined;
    const nested = ha?.['waitForHaWsBeforeDiscovery'];
    return typeof nested === 'boolean' ? nested : defaultValue;
  }

  /** Première lettre en capitale — même règle que AreaEnsureService.capitalize, dupliquée ici
   * pour que le nom envoyé dans device.suggested_area corresponde à celui de l'area réellement
   * créée (jusqu'ici seule l'area créée était capitalisée, pas le champ du payload de découverte
   * lui-même — incohérence visible côté HA, constatée le 07/08/2026). */
  private capitalizeAreaName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return trimmed;
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  /**
   * Extrait quoi/lieu précis/lieu d'un nom "QUOI---lieu_precis--lieu--pere--grand_pere" (protocole
   * nommage_specs v1.0). Duplication volontaire et minimale de RfxComService/taxonomy.ts::
   * extractTaxonomy — pas de dépendance inter-app, seuls les deux champs utiles ici sont extraits.
   */
  private parseQuoiLieu(fullName: string): { rawQuoi: string; nomPrecis: string | null; nomLieu: string | null } {
    const parts = fullName.split('---');
    const rawQuoi = (parts[0] || '').trim();
    const lieux = parts[1] ? parts[1].split('--').map((s) => s.trim()) : [];
    const nomPrecis = lieux[0] || null;
    const nomLieu = lieux.length > 1 ? (lieux[1] || null) : (lieux[0] || null);
    return { rawQuoi, nomPrecis, nomLieu };
  }

  /**
   * Nom de device court et lisible, à la place de la chaîne de taxonomie brute complète — même
   * règle que RfxComService/taxonomy.ts::buildDisplayName : priorité au lieu précis (ex:
   * "Plafonnier") ; repli sur le quoi (ex: "Lumière") si pas de lieu précis distinct du lieu.
   */
  private buildShortDeviceName(fullName: string): string {
    const { rawQuoi, nomPrecis, nomLieu } = this.parseQuoiLieu(fullName);
    const label = nomPrecis && nomPrecis !== nomLieu ? nomPrecis : rawQuoi;
    return this.capitalizeAreaName(label);
  }

  /**
   * Gère un changement de configuration : détecte un changement de `ha.mqtt_enable`.
   */
  private handleConfigSaveResult(result: ConfigSaveResult): void {
    if (!result.success) {
      this.logger.warn('bridge', `Sauvegarde config échouée: ${result.error}`);
      return;
    }

    const newMqttEnable = this.configService.getConfig().ha?.mqtt_enable === true;
    if (newMqttEnable !== this.mqttEnabled) {
      this.logger.info('bridge', `ha.mqtt_enable a changé: ${this.mqttEnabled} -> ${newMqttEnable}`);
      this.toggleMqtt(newMqttEnable);
    }
  }

  /**
   * Active ou désactive MQTT dynamiquement pour tous les bridges enregistrés.
   */
  private toggleMqtt(enable: boolean): void {
    this.mqttEnabled = enable;

    if (enable) {
      this.logger.info('bridge', `Activation de MQTT — connexion de ${this.registeredBridges.size} bridge(s) enregistré(s)`);
      for (const registration of this.registeredBridges.values()) {
        this.connectBridge(registration);
      }
    } else {
      this.logger.info('bridge', 'Désactivation de MQTT — déconnexion de tous les bridges');
      for (const registration of this.registeredBridges.values()) {
        this.haMqttService.disconnectBridge(registration.moduleName, registration.bridgeInstance);
        // Déconnexion volontaire : voir le commentaire dans handleBridgeUnregister.
        this.updateAggregateMqttStatus(registration.moduleName, registration.bridgeInstance, false);
      }
    }
  }

  private connectBridge(registration: BridgeRegisterEvent): void {
    const broker = this.getBrokerConfig(registration.moduleName);
    if (!broker) {
      this.logger.warn('bridge', 'Impossible de connecter le bridge : configuration ha.mqtt absente');
      return;
    }

    this.haMqttService
      .connectBridge(registration.moduleName, registration.bridgeInstance, broker)
      .catch((error) => {
        this.logger.error('bridge', `Échec de connexion du bridge ${registration.moduleName}:${registration.bridgeInstance}: ${error}`);
      });
  }

  /**
   * MQTT 5 partout, SAUF le pont RFXCOM (⭐ 24/08/2026, décision explicite) : il doit rester
   * joignable en 3.1.1, seule version parlée par l'ancienne domotique côté RFXCOM. rpigpio (l'autre
   * pont de compatibilité) ne passe pas par ce service — voir RpigpioService.ts, connexion MQTT
   * séparée, laissée au défaut mqtt.js pour la même raison.
   */
  private getBrokerConfig(moduleName: string): HaMqttBrokerConfig | undefined {
    const mqttConfig = this.configService.getMqttConfig();
    if (!mqttConfig) return undefined;

    return {
      host: mqttConfig.host,
      port: mqttConfig.port,
      username: mqttConfig.username || undefined,
      password: mqttConfig.password || undefined,
      keepalive: mqttConfig.keepalive,
      reconnectDelay: mqttConfig.reconnect_delay,
      protocolVersion: moduleName === 'rfxcom' ? undefined : 5,
    };
  }

  // ===========================================================================
  // Getters publics
  // ===========================================================================

  isMqttEnabled(): boolean {
    return this.mqttEnabled;
  }

  isBridgeConnected(moduleName: string, bridgeInstance: string): boolean {
    return this.haMqttService.isBridgeConnected(moduleName, bridgeInstance);
  }

  getHaMqttService(): HaMqttIntegrationService {
    return this.haMqttService;
  }
}
