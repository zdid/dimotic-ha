/**
 * RfxComService
 *
 * Orchestrateur principal de l'application RFXCOM : cycle de vie du transceiver, détection et
 * classification des devices, routage émetteur↔récepteur, intégration MQTT via les événements
 * EventBus du socle (découverte normale, pas Passthrough — voir le plan d'implémentation).
 *
 * Couche : Domaine (Métier) — orchestration uniquement, délègue à DeviceManager/ReceiverManager/
 * RfxComTransceiver/ConfigFileManager.
 */

import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider, EssentialEntityData } from '../../../core/src/exports';
import { createRfxComError, getCommandTopic } from '../../../core/src/exports';
import { rfxcomConfigSchema, type RfxComConfig } from './config-schema';
import type { RfxComDevicesConfigFile, ReceiverConfigEntry } from './devices-config-schema';
import type { RfxComRawMessage, RfxComStatus, RfxComDeviceInfo, ReceiverConfig, ReceiverSceneConfig, SceneExecutionResult } from './types';
import { DeviceManager } from './devices/DeviceManager';
import { ReceiverManager } from './receivers/ReceiverManager';
import { SceneManager } from './scenes/SceneManager';
import { SceneExecutor } from './scenes/SceneExecutor';
import { RfxComTransceiver } from './transceiver/RfxComTransceiver';
import { detectRfxComPort } from './transceiver/PortDetector';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { getDefaultComponent, getDefaultUnit, buildStateDeviceId } from './classification';
import { extractTaxonomy, buildAttributsTaxonomie, buildDisplayName, buildBoutonDisplayName } from './taxonomy';

const MODULE_NAME = 'rfxcom';

/** Préfixe du deviceId d'une scène dans les topics MQTT (fonctionnelles-rfxcom_specs §14.3.4). */
const SCENE_DEVICE_ID_PREFIX = 'scene_';

export interface IRfxComService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): RfxComStatus;
}

export class RfxComService implements IRfxComService {
  /** Au-delà de cet âge, une dernière valeur persistée n'est plus republiée au démarrage (§ voir publishDeviceStateAtStartup). */
  private static readonly LAST_VALUE_MAX_AGE_MS = 30 * 60 * 1000;

  private config: RfxComConfig;
  private devicesConfig: RfxComDevicesConfigFile;
  private configFileManager: ConfigFileManager;
  private deviceManager: DeviceManager;
  private receiverManager: ReceiverManager;
  private sceneManager: SceneManager;
  private sceneExecutor: SceneExecutor;
  private transceiver: RfxComTransceiver;

  private lastDiscovery: string | null = null;
  /** Scènes dont l'exécution séquentielle en cours doit s'arrêter à la prochaine étape. */
  private cancelledScenes: Set<string> = new Set();
  // ⚠️ configureRFX (RfxComTransceiver.pushEnabledProtocols) déclenche lui-même un nouvel
  // événement 'status' en retour (accusé de réception, même mécanisme que la requête initiale) —
  // sans ce verrou, onHardwareStatus rappellerait pushEnabledHardwareProtocols() indéfiniment
  // (boucle infinie constatée en conditions réelles : 500+ allers-retours en quelques secondes).
  // Une seule poussée par connexion, réarmé à chaque (re)connect() dans start()/handleUsbReconnect.
  private hasPushedHardwareProtocolsThisSession = false;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<RfxComConfig>
  ) {
    this.config = this.loadConfig();
    this.configFileManager = new ConfigFileManager(this.resolveDevicesConfigPath(), this.logger);
    this.devicesConfig = { rfxcom_devices: {}, rfxcom_receivers: {} };
    this.deviceManager = new DeviceManager(this.logger);
    this.receiverManager = new ReceiverManager(this.deviceManager, this.logger);
    this.sceneManager = new SceneManager(this.logger);
    this.sceneExecutor = new SceneExecutor(this.logger);
    this.transceiver = new RfxComTransceiver(this.logger);
  }

  private resolveDevicesConfigPath(): string {
    const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'rfxcom');
    return path.join(dataDir, this.config.devicesConfigFile);
  }

  /**
   * Charge la config depuis le provider et applique les valeurs par défaut du schéma (le
   * provider retourne {} si la section 'rfxcom' n'existe pas encore dans config.yaml — première
   * installation, jamais configuré via l'UI).
   */
  private loadConfig(): RfxComConfig {
    return rfxcomConfigSchema.parse(this.configProvider.getAppConfig());
  }

  // ==========================================================================
  // Cycle de vie
  // ==========================================================================

  async start(): Promise<void> {
    this.logger.info('RfxComService', 'Démarrage du service RFXCOM...');

    this.devicesConfig = this.configFileManager.load();
    this.deviceManager.loadConfigured(this.devicesConfig.rfxcom_devices);
    this.receiverManager.loadReceivers(this.devicesConfig.rfxcom_receivers);
    this.sceneManager.loadScenes(this.devicesConfig.rfxcom_receivers);

    this.setupSocleEventListeners();
    this.setupSocketEventListeners();

    this.eventBus.emitGeneric('integration:bridge:register', {
      moduleName: MODULE_NAME,
      bridgeInstance: this.config.bridgeInstance
    });

    // ⚠️ Limitation connue : si le transceiver perd le matériel (ex: USB débranché) sans que la
    // connexion MQTT elle-même ne tombe, le LWT ne se déclenche pas automatiquement — IntegrationBridge
    // n'expose pas encore d'événement EventBus pour un flip manuel (MqttTransport.publishStatus()
    // existe côté socle mais n'est atteignable que via une référence directe au service, pas via
    // l'EventBus). Hors périmètre de cette passe, voir le rapport final.
    this.transceiver.onMessage((message) => this.handleRfxMessage(message));
    this.transceiver.onConnectionChange(() => this.emitStatus());
    // Pas de garantie d'ordre entre 'status' et la résolution de connect() (voir
    // RfxComTransceiver.onHardwareStatus) — callback plutôt qu'un appel juste après l'await.
    // Verrou hasPushedHardwareProtocolsThisSession : notre propre push déclenche EN RETOUR un
    // nouveau 'status' (accusé de réception, même mécanisme que la requête initiale) — sans lui,
    // ce callback se rappellerait indéfiniment. Une seule poussée AUTOMATIQUE par connexion ; les
    // poussées manuelles (updateEnabledHardwareProtocols, déclenchées par une coche utilisateur)
    // ne passent pas par ce callback et restent donc toujours possibles.
    this.transceiver.onHardwareStatus(() => {
      if (!this.hasPushedHardwareProtocolsThisSession) {
        this.hasPushedHardwareProtocolsThisSession = true;
        this.pushEnabledHardwareProtocols();
      }
      this.emitProtocolsList();
    });

    const port = this.resolvePort();
    try {
      await this.transceiver.connect({ port, baudRate: this.config.baudRate });
    } catch (error) {
      // Conforme implementation-rfxcom_specs §11.1 : échec de connexion = WARNING, pas de crash.
      // La découverte HA n'en dépend plus (voir setupSocleEventListeners) — un transceiver RF433
      // indisponible n'empêche donc plus les devices déjà paramétrés d'apparaître dans HA.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('RfxComService', `Transceiver RFXCOM indisponible au démarrage: ${message}`);
      this.eventBus.emitGeneric('rfxcom:error',
        createRfxComError('RFXCOM_CONNECTION_ERROR', message, 'rfxcom:transceiver', { port }));
    }

    this.emitStatus();
    this.emitDevicesList();
    this.emitReceiversList();
    this.emitScenesList();
    this.emitProtocolsList();

    this.logger.info('RfxComService', 'Service RFXCOM démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('RfxComService', 'Arrêt du service RFXCOM...');
    this.transceiver.disconnect();
    this.eventBus.emitGeneric('integration:bridge:unregister', {
      moduleName: MODULE_NAME,
      bridgeInstance: this.config.bridgeInstance
    });
    this.emitStatus();
    this.logger.info('RfxComService', 'Service RFXCOM arrêté');
  }

  // ==========================================================================
  // Écoute des événements du socle (MQTT via IntegrationBridge)
  // ==========================================================================

  private setupSocleEventListeners(): void {
    this.eventBus.onGeneric<{ bridgeInstance: string; deviceId: string; command: Record<string, unknown> }>(
      `integration:${MODULE_NAME}:command`,
      (event) => this.handleHaCommand(event.deviceId, event.command)
    );

    this.eventBus.onGeneric<{ bridgeInstance: string; connected: boolean }>(
      `integration:${MODULE_NAME}:bridge:connection`,
      (event) => {
        // Publie (ou republie, ex: après une reconnexion) la découverte dès que le bridge socle
        // est effectivement connecté au broker HA — jamais avant (même pattern qu'EVOO7,
        // Evoo7Service.setupSocleEventListeners). Corrigé (2026-07-24) : c'était auparavant
        // déclenché directement après la connexion RF433 (transceiver.connect(), dans start()),
        // qui ne garantit ABSOLUMENT PAS que le bridge MQTT→HA soit déjà prêt à ce moment-là
        // (enregistrement du bridge non bloquant, connexion MQTT établie de façon asynchrone en
        // arrière-plan) — la publication échouait donc silencieusement dans ce cas
        // (HaMqttIntegrationService.getBridgeOrWarn), expliquant pourquoi "envoi des devices vers
        // HA au démarrage" n'était pas fiable malgré un code qui semblait pourtant le faire.
        if (event.connected) {
          this.publishInitialDiscoveries();
        }
        this.emitStatus();
      }
    );

    // Reconnecte le transceiver (port série) à chaud si sa config a réellement changé — même
    // pattern qu'EVOO7 pour son broker MQTT (Evoo7Service.reconnectMqttIfConfigChanged). Le
    // redémarrage automatique du service entier sur sauvegarde de config reste désactivé
    // globalement (AppService.setupEventListeners).
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>(
      'app:module:config:saved',
      (event) => {
        if (event.moduleId !== MODULE_NAME || !event.success) return;
        void this.reconnectTransceiverIfConfigChanged();
      }
    );
  }

  /** Recharge la config et reconnecte le transceiver si le port réellement utilisé ou le baudRate ont changé. */
  private async reconnectTransceiverIfConfigChanged(): Promise<void> {
    const previousPort = this.resolvePort();
    const previousBaudRate = this.config.baudRate;
    this.config = this.loadConfig();
    const newPort = this.resolvePort();

    if (previousPort === newPort && previousBaudRate === this.config.baudRate) {
      return;
    }

    this.logger.info('RfxComService', 'Configuration du port série modifiée — reconnexion à chaud...');
    this.transceiver.disconnect();
    this.hasPushedHardwareProtocolsThisSession = false;
    try {
      await this.transceiver.connect({ port: newPort, baudRate: this.config.baudRate });
      this.logger.info('RfxComService', 'Reconnexion au transceiver RFXCOM réussie après changement de configuration');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('RfxComService', `Échec de reconnexion au transceiver RFXCOM après changement de configuration: ${message}`);
      this.eventBus.emitGeneric('rfxcom:error',
        createRfxComError('RFXCOM_CONNECTION_ERROR', message, 'rfxcom:transceiver', { port: newPort }));
    }
    this.emitStatus();
  }

  /**
   * Port réellement utilisé pour la connexion : détection automatique via /dev/serial/by-id en
   * priorité (voir PortDetector — stable d'un redémarrage à l'autre, contrairement à /dev/ttyUSBx
   * qui dépend de l'ordre d'énumération USB au démarrage), repli sur le port configuré
   * manuellement si la détection échoue (dossier absent, aucune entrée correspondante — ex:
   * certains environnements Docker sans /dev/serial monté).
   */
  private resolvePort(): string {
    const detected = detectRfxComPort(this.logger);
    if (detected) return detected;
    this.logger.info('RfxComService',
      `Port RFXCOM non détecté automatiquement (/dev/serial/by-id) — utilisation du port configuré: ${this.config.port}`);
    return this.config.port;
  }

  // ==========================================================================
  // Réception RF433
  // ==========================================================================

  private handleRfxMessage(message: RfxComRawMessage): void {
    const { uniqueId, isNew } = this.deviceManager.handleRawMessage(message);

    if (isNew) {
      this.eventBus.emitGeneric('rfxcom:device:detected', { device: this.deviceManager.getDiscoveredDevices().find((d) => d.uniqueId === uniqueId) });
    }

    const isEmitter = message.type.startsWith('Lighting');
    if (isEmitter) {
      const affectedReceivers = this.receiverManager.handleEmitterMessage(uniqueId);
      if (affectedReceivers.length > 0) {
        // applyEmitterCommand (appelé par handleEmitterMessage) a déjà mis à jour lastOn/lastLevel
        // dans la config de chaque récepteur affecté — une seule sauvegarde pour tous.
        this.persistDevicesConfig();
      }
      for (const receiver of affectedReceivers) {
        this.publishReceiverState(receiver);
      }

      // L'émetteur lui-même (binary_sensor) peut aussi être exposé à HA si transmitToHa
      const emitterDevice = this.deviceManager.getDevice(uniqueId);
      if (emitterDevice?.transmitToHa) {
        this.publishDeviceState(emitterDevice, message);
      }
      return;
    }

    // Capteur / compteur : publie son propre état si paramétré + transmitToHa
    const device = this.deviceManager.getDevice(uniqueId);
    if (device?.transmitToHa) {
      this.publishDeviceState(device, message);
    }
  }

  // ==========================================================================
  // Discovery / State — devices physiques
  // ==========================================================================

  private publishInitialDiscoveries(): void {
    for (const device of this.deviceManager.getConfiguredDevices()) {
      if (device.transmitToHa) {
        this.publishDeviceDiscovery(device);
        this.publishDeviceStateAtStartup(device);
      }
    }
    for (const receiver of this.receiverManager.getAllReceivers()) {
      if (receiver.config.transmitToHa) {
        this.publishReceiverDiscovery(receiver.config.receiverId);
        this.publishReceiverStateAtStartup(receiver);
      }
    }
    for (const scene of this.sceneManager.getAllScenes()) {
      if (scene.transmitToHa) {
        this.publishSceneDiscovery(scene);
      }
    }
    this.lastDiscovery = new Date().toISOString();
  }

  private publishDeviceDiscovery(device: RfxComDeviceInfo): void {
    const taxonomy = extractTaxonomy(device.name);
    const { component, deviceClass } = getDefaultComponent(device.type, device.subType);
    const deviceId = buildStateDeviceId(device.protocole, device.subType, device.sensorId, device.unitCode);
    // "Bouton" = émetteur physique (Lighting1/2/4/5/6, Blinds1 — tout sauf RFXSensor/RFXMeter,
    // voir getDefaultComponent) : partage le même lieu précis que la lumière/récepteur qu'il
    // pilote (ex: "Plafonnier"), les deux deviendraient indistinguables par leur nom seul sans
    // le quoi en préfixe. Aussi classé "diagnostic" (extra) : utile pour un automatisme éventuel,
    // pas pour un usage quotidien — a priori non visible dans le tableau de bord par défaut.
    const isBouton = device.type !== 'RFXSensor' && device.type !== 'RFXMeter';

    const essential: EssentialEntityData = {
      name: taxonomy.rawQuoi,
      deviceClass,
      unitOfMeasurement: getDefaultUnit(device.subType),
      // Sans ça, HA compare l'état de l'entité au JSON complet du topic d'état
      // ({"state":...,"attributes":{...}}) au lieu d'en extraire juste `state` — erreur explicite
      // et bloquante pour sensor (valeur numérique attendue, non-numeric value), silencieusement
      // cassé pour binary_sensor (jamais égal à payload_on/payload_off). Constaté en direct sur
      // une instance HA réelle (logs system_log : "Value error... non-numeric value").
      valueTemplate: '{{ value_json.state }}',
      device: {
        identifiers: [device.uniqueId],
        // Nom court (lieu précis) plutôt que la chaîne de taxonomie brute complète — l'area
        // (suggested_area) donne déjà le lieu. Voir ReceiverLight.ts::buildDisplayName. Les
        // "boutons" gardent le quoi + lieu en toutes lettres (buildBoutonDisplayName) pour rester
        // distinctifs du récepteur qu'ils pilotent, qui partage souvent le même lieu précis.
        name: isBouton ? buildBoutonDisplayName(taxonomy) : buildDisplayName(taxonomy),
        manufacturer: 'RFXCOM',
        model: device.protocole.toUpperCase(),
        suggested_area: taxonomy.nomLieu ?? undefined
      },
      extra: isBouton ? { entity_category: 'diagnostic' } : undefined
      // attributs_taxonomie n'est plus ici : un message de découverte HA est validé contre un
      // schéma strict par plateforme, les clés non reconnues sont ignorées en silence — porté
      // par l'état à la place (publishDeviceState), via json_attributes_topic.
    };

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery`, {
      bridgeInstance: this.config.bridgeInstance,
      component,
      objectId: device.uniqueId,
      deviceId,
      essential
    });
  }

  private publishDeviceState(device: RfxComDeviceInfo, message: RfxComRawMessage): void {
    const deviceId = buildStateDeviceId(device.protocole, device.subType, device.sensorId, device.unitCode);
    const stateValue = this.extractStateValue(device.subType, message);
    const taxonomy = extractTaxonomy(device.name);

    // Persisté pour être rejoué au démarrage/reconnexion (publishDeviceStateAtStartup), sans
    // attendre une nouvelle réception RF433 — voir aussi lastSeen ci-dessous (fraîcheur).
    device.lastValue = stateValue;
    this.persistDevicesConfig();

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId,
      state: {
        state: stateValue,
        attributes: {
          signal_level: message.signalLevel,
          battery_level: message.batteryLevel,
          sensor_id: device.uniqueId,
          device_id: device.uniqueId,
          attributs_taxonomie: buildAttributsTaxonomie(taxonomy)
        }
      }
    });
  }

  /**
   * Republie la dernière valeur connue (persistée) d'un device brut (sensor ET binary_sensor) au
   * démarrage/reconnexion, pour que la taxonomie soit disponible côté HA sans attendre une
   * nouvelle réception RF433. Si cette valeur date de plus de 30 minutes (ou est absente),
   * publie `"unknown"` plutôt qu'une valeur potentiellement obsolète/trompeuse.
   */
  private publishDeviceStateAtStartup(device: RfxComDeviceInfo): void {
    const deviceId = buildStateDeviceId(device.protocole, device.subType, device.sensorId, device.unitCode);
    const taxonomy = extractTaxonomy(device.name);
    const ageMs = device.lastSeen ? Date.now() - new Date(device.lastSeen).getTime() : Infinity;
    const isFresh = device.lastValue !== undefined && ageMs <= RfxComService.LAST_VALUE_MAX_AGE_MS;

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId,
      state: {
        state: isFresh ? (device.lastValue as string | number) : 'unknown',
        attributes: {
          sensor_id: device.uniqueId,
          device_id: device.uniqueId,
          attributs_taxonomie: buildAttributsTaxonomie(taxonomy)
        }
      }
    });
  }

  private extractStateValue(subType: string, message: RfxComRawMessage): string | number {
    switch (subType) {
      case 'Temperature': return message.data.temperature as number;
      case 'Humidity': return message.data.humidity as number;
      case 'Current': return message.data.current as number;
      case 'Power': return message.data.power as number;
      case 'Motion':
      case 'Contact':
        return message.data.deviceStatus === 0 ? 'ON' : 'OFF';
      default:
        return typeof message.data.command === 'string' && message.data.command.toLowerCase() === 'on' ? 'ON' : 'OFF';
    }
  }

  /**
   * Retire une découverte de device déjà publiée côté HA — désélection (rfxcom:device:set_transmit
   * passant de true à false). Même mécanisme socle qu'EVOO7 (discovery.ts::unpublishDiscovery).
   */
  private removeDeviceDiscovery(device: RfxComDeviceInfo): void {
    const { component } = getDefaultComponent(device.type, device.subType);
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery:remove`, {
      bridgeInstance: this.config.bridgeInstance,
      component,
      objectId: device.uniqueId
    });
  }

  // ==========================================================================
  // Discovery / State — récepteurs logiques
  // ==========================================================================

  private publishReceiverDiscovery(receiverId: string): void {
    const receiver = this.receiverManager.getReceiver(receiverId);
    if (!receiver) return;

    const { component, essential } = receiver.getDiscoveryEssential();
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery`, {
      bridgeInstance: this.config.bridgeInstance,
      component,
      objectId: receiver.config.receiverId,
      deviceId: receiver.config.receiverId,
      essential
    });
  }

  private publishReceiverState(receiver: ReturnType<ReceiverManager['getReceiver']>): void {
    if (!receiver) return;
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId: receiver.config.receiverId,
      state: receiver.getState()
    });
  }

  /**
   * Au démarrage/reconnexion : republie l'état persisté d'un récepteur commandable (light/switch)
   * s'il en existe un, sinon envoie une commande OFF réelle — qui aura pour effet, via le
   * mécanisme d'écho RF433 déjà utilisé pour toute commande HA (voir applyReceiverCommand), de
   * publier l'état ET de le persister pour la prochaine fois. Scènes et volets non concernés :
   * pas de notion d'état "off" déterministe pour un volet, et une scène n'a pas d'état propre.
   */
  private publishReceiverStateAtStartup(receiver: ReturnType<ReceiverManager['getReceiver']>): void {
    if (!receiver) return;
    if (receiver.config.type !== 'light' && receiver.config.type !== 'switch') return;

    if (receiver.config.lastOn !== undefined) {
      this.publishReceiverState(receiver);
      return;
    }

    const result = this.applyReceiverCommand(receiver.config.receiverId, 'turn_off');
    if (!result.success) {
      this.logger.warn('RfxComService',
        `Échec de l'envoi OFF initial pour ${receiver.config.receiverId} (aucun état connu): ${result.error}`);
    }
  }

  /**
   * Retire une découverte de récepteur déjà publiée côté HA — désélection ou suppression.
   * `component` doit venir de `getDiscoveryEssential()` capturé AVANT la mutation/suppression du
   * récepteur (le composant dépend de son type, indisponible une fois retiré de ReceiverManager).
   */
  private removeReceiverDiscovery(receiverId: string, component: string): void {
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery:remove`, {
      bridgeInstance: this.config.bridgeInstance,
      component,
      objectId: receiverId
    });
  }

  // ==========================================================================
  // Discovery / State — scènes
  // ==========================================================================

  /**
   * Publiée comme automatisation HA (déclenchement, pas d'état commandable classique) —
   * fonctionnelles-rfxcom_specs §14.3.4. ⚠️ Simplification connue : le schéma HA canonique du
   * component `device_automation` utilise deux segments d'identifiant dans le topic de découverte
   * (device_id/trigger_id) ; le socle ne construit qu'un objectId unique, comme pour tous les
   * autres components — non vérifié contre une instance HA réelle (seul le broker MQTT l'a été).
   */
  private publishSceneDiscovery(scene: ReceiverSceneConfig): void {
    const taxonomy = extractTaxonomy(scene.name);
    const deviceId = `${SCENE_DEVICE_ID_PREFIX}${scene.receiverId}`;
    const commandTopic = getCommandTopic(MODULE_NAME, this.config.bridgeInstance, deviceId);

    const essential: EssentialEntityData = {
      name: taxonomy.rawQuoi,
      icon: scene.icon ?? 'mdi:script-text-play',
      commandEnabled: true,
      device: {
        identifiers: [`rfxcom_scene_${scene.receiverId}`],
        // Nom court — voir ReceiverLight.ts::buildDisplayName. Les scènes n'ont généralement pas
        // de lieu précis distinct du lieu (juste "scène---étage" par ex.) : repli sur "Scène",
        // distinguées par leur area (suggested_area) plutôt que par leur nom.
        name: buildDisplayName(taxonomy),
        manufacturer: 'RFXCOM',
        model: 'Scene',
        suggested_area: taxonomy.nomLieu ?? undefined
      },
      // Pas d'attributs_taxonomie ici : device_automation (déclencheur, pas d'état/entité au
      // sens HA classique) n'a pas d'équivalent à json_attributes_topic — et de toute façon le
      // mécanisme précédent (clé glissée dans la découverte) n'atteignait jamais HA, voir
      // publishDeviceDiscovery ci-dessus.
      // type/subtype : requis par le schéma HA de device_automation (constaté en direct sur une
      // instance HA réelle — "required key not provided @ data['type']", absent jusqu'ici malgré
      // la mise en garde ci-dessus). Utilisés par HA pour labelliser le déclencheur dans son UI
      // d'automatisations, pas de valeur "officielle" attendue ici (pas un vrai trigger matériel).
      extra: {
        automation_type: 'trigger',
        type: 'scene_executed',
        subtype: scene.receiverId,
        topic: commandTopic,
        payload: '{}'
      }
    };

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery`, {
      bridgeInstance: this.config.bridgeInstance,
      component: 'device_automation',
      objectId: `rfxcom_scene_${scene.receiverId}`,
      deviceId,
      essential
    });
  }

  private publishSceneResult(sceneId: string, result: SceneExecutionResult): void {
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId: `${SCENE_DEVICE_ID_PREFIX}${sceneId}`,
      state: {
        state: result.success ? 'completed' : 'failed',
        attributes: {
          executed_commands: result.executedCommands,
          failed_commands: result.failedCommands,
          duration_ms: result.duration
        }
      }
    });
  }

  /**
   * Retire une découverte de scène déjà publiée côté HA — désélection ou suppression. objectId
   * doit matcher exactement celui utilisé par publishSceneDiscovery (`rfxcom_scene_...`, distinct
   * du deviceId `scene_...` utilisé pour les topics d'état).
   */
  private removeSceneDiscovery(sceneId: string): void {
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery:remove`, {
      bridgeInstance: this.config.bridgeInstance,
      component: 'device_automation',
      objectId: `rfxcom_scene_${sceneId}`
    });
  }

  // ==========================================================================
  // Commandes HA → récepteur → device RFXCOM
  // ==========================================================================

  private handleHaCommand(deviceId: string, payload: Record<string, unknown>): void {
    if (deviceId.startsWith(SCENE_DEVICE_ID_PREFIX)) {
      void this.executeScene(deviceId.slice(SCENE_DEVICE_ID_PREFIX.length));
      return;
    }

    if (!this.receiverManager.getReceiver(deviceId)) {
      this.logger.warn('RfxComService', `Commande reçue pour un récepteur inconnu: ${deviceId}`);
      return;
    }

    const parsed = this.parseHaCommandPayload(payload);
    if (!parsed) {
      this.logger.warn('RfxComService', `Commande non reconnue pour ${deviceId}: ${JSON.stringify(payload)}`);
      return;
    }

    const result = this.applyReceiverCommand(deviceId, parsed.command, parsed.value);
    if (!result.success) {
      this.logger.error('RfxComService', `Échec de la commande ${parsed.command} pour ${deviceId}: ${result.error}`);
      this.eventBus.emitGeneric('rfxcom:error',
        createRfxComError('RFXCOM_COMMAND_FAILED', result.error ?? 'Erreur inconnue', 'rfxcom:command', { deviceId }));
    }
  }

  /**
   * Traduit puis envoie une commande RF433 pour un récepteur donné (switch/light/cover — pas les
   * scènes). Factorisé pour être réutilisé à la fois par handleHaCommand (payload JSON `/set` du
   * socle) et par SceneExecutor (commande/valeur déjà discrètes, une par action de scène).
   */
  private applyReceiverCommand(receiverId: string, command: string, value?: number): { success: boolean; error?: string } {
    const receiver = this.receiverManager.getReceiver(receiverId);
    if (!receiver) {
      return { success: false, error: `Récepteur inconnu: ${receiverId}` };
    }

    const result = receiver.translateHaCommand(command, value);
    if (!result) {
      return { success: false, error: `Commande ${command} non applicable à ${receiverId} (état inchangé ou non supportée)` };
    }

    const primaryDevice = this.deviceManager.getDevice(receiver.config.primaryEmitter);
    if (!primaryDevice) {
      return { success: false, error: `primaryEmitter ${receiver.config.primaryEmitter} introuvable` };
    }
    const commandDeviceId = primaryDevice.commandDeviceId ?? this.resolveCommandDeviceId(primaryDevice);
    if (!commandDeviceId) {
      return { success: false, error: `Impossible de déterminer l'identifiant de commande pour ${receiver.config.primaryEmitter} (jamais vu en émission, et sensorId/unitCode insuffisants pour le reconstruire)` };
    }

    try {
      this.transceiver.sendCommand(
        primaryDevice.protocole,
        primaryDevice.subType,
        commandDeviceId,
        result.action as 'on' | 'off' | 'set_level' | 'open' | 'close' | 'stop',
        result.value
      );
      // Mise à jour optimiste de l'état interne : contrairement à ce qu'on pouvait supposer, le
      // primaryEmitter n'est PAS réécouté en écho après l'envoi — findReceiversForEmitter ne
      // matche que receiver.config.emitters[] (télécommandes secondaires appairées), jamais
      // primaryEmitter lui-même. Sans cet appel explicite, l'état interne (et lastOn/lastLevel
      // persisté) ne bougeait jamais suite à une commande envoyée via ce chemin — vérifié en
      // conditions réelles (2026-07-30) : lastOn absent du YAML après un OFF réellement envoyé.
      receiver.applyEmitterCommand(result.action, result.value);
      this.persistDevicesConfig();
      this.publishReceiverState(receiver);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  /**
   * Reconstruit un `commandDeviceId` sans attendre une réception RF433, à partir des données déjà
   * connues (persistées) — évite de dépendre d'avoir "vu" l'émetteur transmettre au moins une fois
   * (voir RfxComTransceiver.buildCommandDeviceId pour le format cible exact, produit à la réception
   * d'un message réel). Repose sur le fait que sensorId/unitCode dérivent des mêmes champs bruts
   * (evt.id, evt.houseCode, evt.unitCode) que commandDeviceId — reconstructible à l'identique :
   * - Lighting1 : sensorId = houseCode+unitCode déjà fusionnés (resolveSensorIdentity), la casse
   *   n'a pas d'importance (Lighting1._splitDeviceId de la lib `rfxcom` uppercase le houseCode).
   * - Lighting2 : format cible "id/unitCode". Si unitCode est un champ séparé (device détecté en
   *   direct), on le recompose. Sinon (inventaire reconstitué depuis equipements.json après perte
   *   de la machine d'origine — voir historique), sensorId porte parfois le unitCode fusionné
   *   avec un underscore (ex: "0x02be2c02_13" = id "0x02be2c02" + unitCode 13) — on le déduit par
   *   découpage plutôt que d'exiger une nouvelle réception RF433 pour chaque device concerné.
   */
  private resolveCommandDeviceId(device: RfxComDeviceInfo): string | undefined {
    if (device.type === 'Lighting1') {
      return device.sensorId;
    }

    if (device.type === 'Lighting2') {
      if (device.unitCode !== undefined) {
        return `${device.sensorId}/${device.unitCode}`;
      }
      const match = /^(.+)_(\d+)$/.exec(device.sensorId);
      if (match) {
        return `${match[1]}/${match[2]}`;
      }
    }

    return undefined;
  }

  // ==========================================================================
  // Scènes — exécution
  // ==========================================================================

  private async executeScene(sceneId: string): Promise<void> {
    const scene = this.sceneManager.getScene(sceneId);
    if (!scene) {
      this.logger.warn('RfxComService', `Scène inconnue: ${sceneId}`);
      return;
    }

    this.cancelledScenes.delete(sceneId);
    this.eventBus.emitGeneric('rfxcom:scene:status', { sceneId, status: 'scene_executing' });

    const result = await this.sceneExecutor.execute(
      scene,
      (target, command, value) => this.applyReceiverCommand(target, command, value),
      () => this.cancelledScenes.has(sceneId)
    );

    this.cancelledScenes.delete(sceneId);
    this.publishSceneResult(sceneId, result);
    this.eventBus.emitGeneric('rfxcom:scene:executed', result);

    if (!result.success) {
      this.logger.warn('RfxComService',
        `Scène ${sceneId} terminée avec erreurs: ${result.failedCommands} commande(s) en échec sur ${scene.actions.length}`);
    }
  }

  /** Traduit le payload JSON générique `/set` du socle (state/brightness/position) en commande interne. */
  private parseHaCommandPayload(payload: Record<string, unknown>): { command: string; value?: number } | null {
    if (typeof payload.position === 'number') {
      return { command: 'set_position', value: payload.position };
    }
    if (payload.state === 'OPEN') return { command: 'open' };
    if (payload.state === 'CLOSE') return { command: 'close' };
    if (payload.state === 'STOP') return { command: 'stop' };
    if (typeof payload.brightness === 'number' && payload.state === 'ON') {
      return { command: 'set_level', value: Math.round(((payload.brightness as number) / 255) * 100) };
    }
    if (payload.state === 'ON') return { command: 'turn_on' };
    if (payload.state === 'OFF') return { command: 'turn_off' };
    return null;
  }

  // ==========================================================================
  // Statut / événements persistants
  // ==========================================================================

  getStatus(): RfxComStatus {
    return {
      connected: this.transceiver.isConnected(),
      devicesCount: this.deviceManager.getConfiguredDevices().length,
      receiversCount: this.receiverManager.getAllReceivers().length,
      lastDiscovery: this.lastDiscovery,
      scanInProgress: false
    };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('rfxcom:status', this.getStatus());
  }

  private emitDevicesList(): void {
    this.eventBus.emitGeneric('rfxcom:devices:list', {
      configured: this.deviceManager.getConfiguredDevices(),
      discovered: this.deviceManager.getDiscoveredDevices()
    });
  }

  private emitReceiversList(): void {
    this.eventBus.emitGeneric('rfxcom:receivers:list', { receivers: this.receiverManager.getAllReceivers().map((r) => r.config) });
  }

  private emitScenesList(): void {
    this.eventBus.emitGeneric('rfxcom:scenes:list', { scenes: this.sceneManager.getAllScenes() });
  }

  /**
   * Seul filtre de protocoles restant (fonctionnelles-rfxcom_specs §8.2) — matériel uniquement,
   * voir RfxComTransceiver. L'ancien filtre logiciel après décodage (enabledProtocols, granularité
   * Lighting1/2/4/5/6/Blinds1/RFXSensor/RFXMeter) a été retiré le 2026-07-26 (voir le commentaire
   * sur RfxComTransceiver.hardwareStatus pour la limitation RFXMeter que ça laisse).
   */
  private emitProtocolsList(): void {
    const hardware = this.transceiver.getHardwareStatus();
    this.eventBus.emitGeneric('rfxcom:protocols:list', {
      // Statut matériel brut (receiverType/firmware/ce qui est actuellement actif côté matériel) —
      // informatif. Catalogue+sélection éditable pour le push RAM : hardwareAvailable/hardwareEnabled.
      hardware,
      hardwareAvailable: hardware?.availableProtocols ?? [],
      hardwareEnabled: this.config.enabledHardwareProtocols.length > 0
        ? this.config.enabledHardwareProtocols
        : (hardware?.availableProtocols ?? [])
    });
  }

  /**
   * Pousse notre liste persistée de protocoles matériel (enabledHardwareProtocols, granularité
   * X10/ARC/AC/...) AU RFXtrx433 — pour la session en cours uniquement (RAM, voir
   * RfxComTransceiver.pushEnabledProtocols), à chaque connexion. Notre config reste la seule
   * source de vérité : ce que le matériel rapportait AVANT ce push (hardware.enabledProtocols) est
   * ignoré ici, jamais utilisé pour modifier notre liste — seule updateEnabledHardwareProtocols()
   * (déclenchée par l'utilisateur) modifie enabledHardwareProtocols.
   */
  private pushEnabledHardwareProtocols(): void {
    const hardware = this.transceiver.getHardwareStatus();
    if (!hardware) {
      this.logger.warn('RfxComService', 'Pas de statut matériel reçu, push des protocoles matériel ignoré.');
      return;
    }

    const names = this.config.enabledHardwareProtocols.length > 0
      ? this.config.enabledHardwareProtocols
      : hardware.availableProtocols;

    this.transceiver.pushEnabledProtocols(names).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('RfxComService', `Échec du push des protocoles matériel: ${message}`);
      this.eventBus.emitGeneric('rfxcom:error',
        createRfxComError('RFXCOM_COMMAND_FAILED', message, 'rfxcom:protocols:hardware'));
    });
  }

  /**
   * Persiste la nouvelle liste de protocoles matériel à pousser au RFXtrx433 — sans la pousser
   * immédiatement : une coche individuelle ne déclenche plus de commande vers le matériel, elle
   * modifie seulement la sélection en attente. L'envoi effectif au RFXtrx433 (session en cours,
   * RAM) se fait en une seule fois via le bouton dédié (voir pushEnabledHardwareProtocolsNow).
   */
  private updateEnabledHardwareProtocols(protocols: string[]): void {
    const hardware = this.transceiver.getHardwareStatus();
    const catalog = hardware?.availableProtocols ?? protocols;
    const normalized = protocols.length >= catalog.length ? [] : protocols;

    const result = this.configProvider.savePartialConfig({ ...this.config, enabledHardwareProtocols: normalized });
    if (!result.success) {
      this.logger.error('RfxComService', `Échec de sauvegarde des protocoles matériel: ${result.error}`);
      this.eventBus.emitGeneric('rfxcom:error',
        createRfxComError('RFXCOM_COMMAND_FAILED', result.error ?? 'Erreur inconnue', 'rfxcom:protocols:hardware'));
      this.emitProtocolsList();
      return;
    }
    this.configProvider.reload();
    this.config = this.loadConfig();
    this.emitProtocolsList();
  }

  /** Pousse au RFXtrx433, en une seule fois, la sélection actuellement persistée — déclenché par
   *  le bouton dédié de l'onglet Protocoles (rfxcom:hardware-protocols:push). */
  private pushEnabledHardwareProtocolsNow(): void {
    this.pushEnabledHardwareProtocols();
  }

  /** Redemande au matériel son statut (bouton "Rafraîchir" de l'onglet Protocoles) — la réponse
   *  met à jour hardwareStatus via onHardwareStatus et re-déclenche emitProtocolsList(). */
  private refreshHardwareStatusNow(): void {
    this.transceiver.refreshHardwareStatus().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('RfxComService', `Échec du rafraîchissement du statut matériel: ${message}`);
      this.eventBus.emitGeneric('rfxcom:error',
        createRfxComError('RFXCOM_COMMAND_FAILED', message, 'rfxcom:protocols:hardware'));
    });
  }

  // ==========================================================================
  // Socket.io (via SocketBridge, EventBus générique)
  // ==========================================================================

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric('rfxcom:status:get', () => this.emitStatus());
    this.eventBus.onGeneric('rfxcom:devices:list:get', () => this.emitDevicesList());
    this.eventBus.onGeneric('rfxcom:receivers:list:get', () => this.emitReceiversList());
    this.eventBus.onGeneric('rfxcom:scenes:list:get', () => this.emitScenesList());

    this.eventBus.onGeneric('rfxcom:devices:refresh', () => this.emitDevicesList());

    this.eventBus.onGeneric('rfxcom:devices:clear-unconfigured', () => {
      const count = this.deviceManager.clearUnconfigured();
      this.logger.info('RfxComService', `${count} device(s) auto-découvert(s) effacé(s)`);
      this.emitDevicesList();
    });

    this.eventBus.onGeneric<{ uniqueId: string; name: string }>('rfxcom:device:set_name', (data) => {
      const device = this.deviceManager.setDeviceName(data.uniqueId, data.name);
      this.persistDevicesConfig();
      if (device.transmitToHa) this.publishDeviceDiscovery(device);
      this.emitDevicesList();
    });

    this.eventBus.onGeneric<{ uniqueId: string; transmitToHa: boolean }>('rfxcom:device:set_transmit', (data) => {
      const previousTransmit = this.deviceManager.getDevice(data.uniqueId)?.transmitToHa;
      const device = this.deviceManager.setTransmitToHa(data.uniqueId, data.transmitToHa);
      if (!device) {
        this.logger.warn('RfxComService', `Device inconnu pour set_transmit: ${data.uniqueId}`);
        return;
      }
      this.persistDevicesConfig();
      if (device.transmitToHa) {
        this.publishDeviceDiscovery(device);
      } else if (previousTransmit) {
        // ⚠️ Désélection : retire la découverte déjà publiée côté HA — sans ça l'entité restait
        // visible dans HA indéfiniment (même correctif que EVOO7, voir TODO.md).
        this.removeDeviceDiscovery(device);
      }
      this.emitDevicesList();
    });

    this.eventBus.onGeneric<{ uniqueId: string }>('rfxcom:device:delete', (data) => {
      const device = this.deviceManager.getDevice(data.uniqueId);
      if (!device) {
        this.logger.warn('RfxComService', `Device inconnu pour suppression: ${data.uniqueId}`);
        return;
      }
      if (device.transmitToHa) {
        this.removeDeviceDiscovery(device);
      }
      this.deviceManager.deleteDevice(data.uniqueId);
      this.persistDevicesConfig();
      this.emitDevicesList();
      this.eventBus.emitGeneric('rfxcom:device:deleted', { uniqueId: data.uniqueId });
    });

    this.eventBus.onGeneric<{ config: ReceiverConfig }>('rfxcom:receiver:create', (data) => {
      if (data.config.type === 'scene') {
        this.logger.warn('RfxComService', `Scène reçue sur rfxcom:receiver:create — utiliser rfxcom:scene:create (${data.config.receiverId})`);
        return;
      }
      this.receiverManager.addReceiver(data.config);
      this.persistDevicesConfig();
      if (data.config.transmitToHa) this.publishReceiverDiscovery(data.config.receiverId);
      this.emitReceiversList();
      this.eventBus.emitGeneric('rfxcom:receiver:created', { receiver: data.config });
    });

    this.eventBus.onGeneric<{ receiverId: string; config: Partial<ReceiverConfig> }>('rfxcom:receiver:update', (data) => {
      const existing = this.receiverManager.getReceiver(data.receiverId);
      if (!existing) {
        this.logger.warn('RfxComService', `Récepteur inconnu pour mise à jour: ${data.receiverId}`);
        return;
      }
      // Capturés AVANT la mutation : previousTransmit reflète l'état publié à ce jour côté HA,
      // previousComponent dépend du type du récepteur, indisponible une fois retiré ci-dessous.
      const previousTransmit = existing.config.transmitToHa;
      const previousComponent = existing.getDiscoveryEssential().component;
      const updated = { ...existing.config, ...data.config } as ReceiverConfig;
      this.receiverManager.removeReceiver(data.receiverId);
      this.receiverManager.addReceiver(updated);
      this.persistDevicesConfig();
      if (updated.transmitToHa) {
        this.publishReceiverDiscovery(updated.receiverId);
      } else if (previousTransmit) {
        this.removeReceiverDiscovery(data.receiverId, previousComponent);
      }
      this.emitReceiversList();
      this.eventBus.emitGeneric('rfxcom:receiver:updated', { receiver: updated });
    });

    this.eventBus.onGeneric<{ receiverId: string }>('rfxcom:receiver:delete', (data) => {
      const existing = this.receiverManager.getReceiver(data.receiverId);
      if (existing?.config.transmitToHa) {
        this.removeReceiverDiscovery(data.receiverId, existing.getDiscoveryEssential().component);
      }
      this.receiverManager.removeReceiver(data.receiverId);
      this.persistDevicesConfig();
      this.emitReceiversList();
      this.eventBus.emitGeneric('rfxcom:receiver:deleted', { receiverId: data.receiverId });
    });

    this.eventBus.onGeneric<{ config: ReceiverSceneConfig }>('rfxcom:scene:create', (data) => {
      this.sceneManager.addScene(data.config);
      this.persistDevicesConfig();
      if (data.config.transmitToHa) this.publishSceneDiscovery(data.config);
      this.emitScenesList();
      this.eventBus.emitGeneric('rfxcom:scene:created', { scene: data.config });
    });

    this.eventBus.onGeneric<{ sceneId: string; config: Partial<ReceiverSceneConfig> }>('rfxcom:scene:update', (data) => {
      const existing = this.sceneManager.getScene(data.sceneId);
      if (!existing) {
        this.logger.warn('RfxComService', `Scène inconnue pour mise à jour: ${data.sceneId}`);
        return;
      }
      const wasPublished = existing.transmitToHa;
      const updated = { ...existing, ...data.config } as ReceiverSceneConfig;
      this.sceneManager.addScene(updated);
      this.persistDevicesConfig();
      if (updated.transmitToHa) {
        this.publishSceneDiscovery(updated);
      } else if (wasPublished) {
        this.removeSceneDiscovery(data.sceneId);
      }
      this.emitScenesList();
      this.eventBus.emitGeneric('rfxcom:scene:updated', { scene: updated });
    });

    this.eventBus.onGeneric<{ sceneId: string }>('rfxcom:scene:delete', (data) => {
      const existing = this.sceneManager.getScene(data.sceneId);
      if (existing?.transmitToHa) {
        this.removeSceneDiscovery(data.sceneId);
      }
      this.sceneManager.removeScene(data.sceneId);
      this.persistDevicesConfig();
      this.emitScenesList();
      this.eventBus.emitGeneric('rfxcom:scene:deleted', { sceneId: data.sceneId });
    });

    this.eventBus.onGeneric<{ sceneId: string }>('rfxcom:scene:execute', (data) => {
      void this.executeScene(data.sceneId);
    });

    this.eventBus.onGeneric<{ sceneId: string }>('rfxcom:scene:cancel', (data) => {
      this.cancelledScenes.add(data.sceneId);
    });

    this.eventBus.onGeneric('rfxcom:protocols:list:get', () => this.emitProtocolsList());

    this.eventBus.onGeneric<{ protocol: string; enabled: boolean }>('rfxcom:hardware-protocol:toggle', (data) => {
      const hardware = this.transceiver.getHardwareStatus();
      const catalog = hardware?.availableProtocols ?? [];
      const current = new Set(this.config.enabledHardwareProtocols.length > 0 ? this.config.enabledHardwareProtocols : catalog);
      if (data.enabled) current.add(data.protocol);
      else current.delete(data.protocol);
      this.updateEnabledHardwareProtocols(Array.from(current));
    });

    this.eventBus.onGeneric('rfxcom:hardware-protocols:push', () => this.pushEnabledHardwareProtocolsNow());

    this.eventBus.onGeneric('rfxcom:hardware-status:refresh', () => this.refreshHardwareStatusNow());
  }

  /** Sauvegarde l'état courant des devices/récepteurs/scènes dans config-rfxcom-devices-v1.0.yaml. */
  private persistDevicesConfig(): void {
    const receivers: Record<string, ReceiverConfigEntry> = {};
    for (const receiver of this.receiverManager.getAllReceivers()) {
      receivers[receiver.config.receiverId] = receiver.config as ReceiverConfigEntry;
    }
    for (const scene of this.sceneManager.getAllScenes()) {
      receivers[scene.receiverId] = scene as ReceiverConfigEntry;
    }
    const result = this.configFileManager.save({
      rfxcom_devices: this.deviceManager.getConfiguredDevicesRecord(),
      rfxcom_receivers: receivers
    });
    if (!result.success) {
      this.logger.error('RfxComService', `Échec de sauvegarde de la configuration RFXCOM: ${result.error}`);
    }
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<RfxComConfig>
  ): RfxComService {
    return new RfxComService(eventBus, logger, configProvider);
  }
}
