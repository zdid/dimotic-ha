/**
 * Evoo7Service
 *
 * Orchestrateur principal de l'application EVOO7 : deux connexions MQTT distinctes (broker EVOO7
 * propre à l'app via Evoo7MqttClient, broker HA via les événements EventBus du socle
 * `integration:evoo7:*`, comme RFXCOM), traduction bidirectionnelle des valeurs, gestion des 43
 * données connues (config-evoo7-donnees-v1.0.yaml).
 *
 * Couche : Domaine (Métier) — orchestration uniquement, délègue à ConfigFileManager/Evoo7MqttClient.
 */

import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider, EssentialEntityData } from '../../../core/src/exports';
import { createEvoo7Error } from '../../../core/src/exports';
import { evoo7ConfigSchema, type Evoo7Config } from './config-schema';
import type { Evoo7DonneesConfigFile } from './donnees-config-schema';
import type { Evoo7DataDefinition, Evoo7Status } from './types';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { Evoo7MqttClient } from './mqtt/Evoo7MqttClient';
import { determineComponent, determineNumberStep, buildValueTemplate, buildCommandTemplate } from './classification';
import { resolveTaxonomy, buildAttributsTaxonomie } from './taxonomy';
import { resolveTopic, resolveCommandMessage, extractSensorValue } from './evoo7-templates';

const MODULE_NAME = 'evoo7';

/** Un seul système logique EVOO7 Control — pas de sous-devices comme RFXCOM. */
const EVOO7_DEVICE = {
  identifiers: ['evoo7_control'],
  name: 'EVOO7 Control',
  manufacturer: 'VR Electronique',
  model: 'EVOO7 Control'
};

export interface IEvoo7Service {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Evoo7Status;
}

export class Evoo7Service implements IEvoo7Service {
  private config: Evoo7Config;
  private donneesConfig: Evoo7DonneesConfigFile;
  private donnees: Map<string, Evoo7DataDefinition> = new Map();
  /** topic MQTT résolu (avec $name$ substitué) → id de la donnée, pour router les messages entrants. */
  private topicToId: Map<string, string> = new Map();

  private configFileManager: ConfigFileManager;
  private evoo7Client: Evoo7MqttClient;

  private bridgeConnected = false;
  private lastMessageAt: string | null = null;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<Evoo7Config>
  ) {
    this.config = this.loadConfig();
    this.configFileManager = new ConfigFileManager(
      this.resolveDonneesConfigPath(),
      this.resolveSeedJsonPath(),
      this.logger
    );
    this.donneesConfig = { evoo7_donnees: {} };
    this.evoo7Client = new Evoo7MqttClient(this.logger);
  }

  private resolveDonneesConfigPath(): string {
    const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'evoo7');
    return path.join(dataDir, this.config.donneesConfigFile);
  }

  /**
   * Fichier seedé, packagé avec l'application (dans seed/, pas data/ — data/ est gitignoré
   * projet-wide pour les données runtime, alors que ce fichier est un asset source versionné).
   */
  private resolveSeedJsonPath(): string {
    return path.join(__dirname, '../../seed/evoo7_donnees.json');
  }

  /**
   * Charge la config depuis le provider et applique les valeurs par défaut du schéma (le
   * provider retourne {} si la section 'evoo7' n'existe pas encore dans config.yaml).
   */
  private loadConfig(): Evoo7Config {
    return evoo7ConfigSchema.parse(this.configProvider.getAppConfig());
  }

  // ==========================================================================
  // Cycle de vie
  // ==========================================================================

  async start(): Promise<void> {
    this.logger.info('Evoo7Service', 'Démarrage du service EVOO7...');

    this.donneesConfig = this.configFileManager.load();
    this.donnees = new Map(Object.entries(this.donneesConfig.evoo7_donnees));

    this.setupSocleEventListeners();
    this.setupSocketEventListeners();

    this.eventBus.emitGeneric('integration:bridge:register', {
      moduleName: MODULE_NAME,
      bridgeInstance: this.config.bridgeInstance
    });

    this.evoo7Client.onMessage((topic, payload) => this.handleEvoo7Message(topic, payload));
    this.evoo7Client.onConnectionChange(() => this.emitStatus());

    // La publication de la découverte HA est déclenchée par le premier événement
    // integration:evoo7:bridge:connection (voir setupSocleEventListeners) — PAS synchronement
    // ici : registerBridge() ne garantit aucunement que le bridge socle est déjà connecté au
    // broker HA au moment où le handler retourne (connexion établie de façon asynchrone en
    // arrière-plan), et publier avant serait un throw synchrone ("MQTT client is not connected")
    // qui ferait échouer tout le démarrage du service.
    try {
      await this.evoo7Client.connect(this.config.mqtt);
      this.subscribeSelectedTopics();
    } catch (error) {
      // Échec de connexion = WARNING, pas de crash (même contrat que RFXCOM).
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Evoo7Service', `Broker EVOO7 indisponible au démarrage: ${message}`);
      this.eventBus.emitGeneric('evoo7:error',
        createEvoo7Error('EVOO7_CONNECTION_ERROR', message, 'evoo7:mqtt', { host: this.config.mqtt.host }));
    }

    this.emitStatus();
    this.emitDonneesList();

    this.logger.info('Evoo7Service', 'Service EVOO7 démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('Evoo7Service', 'Arrêt du service EVOO7...');
    await this.evoo7Client.disconnect();
    this.eventBus.emitGeneric('integration:bridge:unregister', {
      moduleName: MODULE_NAME,
      bridgeInstance: this.config.bridgeInstance
    });
    this.emitStatus();
    this.logger.info('Evoo7Service', 'Service EVOO7 arrêté');
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
        this.bridgeConnected = event.connected;
        // Publie (ou republie, ex: après une reconnexion) la découverte dès que le bridge socle
        // est effectivement connecté au broker HA — jamais avant (voir start()).
        if (event.connected) {
          this.publishInitialDiscoveries();
        }
        this.emitStatus();
      }
    );

    // Le redémarrage automatique du service entier sur sauvegarde de config a été désactivé
    // globalement (AppService.setupEventListeners) — mais sans lui, un changement d'hôte/port/
    // identifiants MQTT via "Paramètres Techniques → EVOO7" restait sans effet tant que le
    // serveur n'était pas redémarré manuellement. Correctif ciblé, propre à ce module : ne
    // reconnecte QUE le client MQTT EVOO7 (pas tout le service) quand `mqtt` a réellement changé.
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>(
      'app:module:config:saved',
      (event) => {
        if (event.moduleId !== MODULE_NAME || !event.success) return;
        this.reconnectMqttIfConfigChanged();
      }
    );
  }

  /**
   * Recharge la config et reconnecte le client MQTT EVOO7 si `mqtt` a changé — comparaison
   * structurelle simple (objet de valeurs primitives uniquement, `evoo7MqttConfigSchema`).
   */
  private async reconnectMqttIfConfigChanged(): Promise<void> {
    const previousMqtt = this.config.mqtt;
    this.config = this.loadConfig();

    if (JSON.stringify(previousMqtt) === JSON.stringify(this.config.mqtt)) {
      return;
    }

    this.logger.info('Evoo7Service', 'Configuration MQTT EVOO7 modifiée — reconnexion à chaud...');
    try {
      await this.evoo7Client.disconnect();
      await this.evoo7Client.connect(this.config.mqtt);
      this.subscribeSelectedTopics();
      this.logger.info('Evoo7Service', 'Reconnexion au broker EVOO7 réussie après changement de configuration');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Evoo7Service', `Échec de reconnexion au broker EVOO7 après changement de configuration: ${message}`);
      this.eventBus.emitGeneric('evoo7:error',
        createEvoo7Error('EVOO7_CONNECTION_ERROR', message, 'evoo7:mqtt', { host: this.config.mqtt.host }));
    }
    this.emitStatus();
  }

  // ==========================================================================
  // Réception EVOO7 (broker propre à l'app)
  // ==========================================================================

  private subscribeSelectedTopics(): void {
    this.topicToId.clear();
    for (const donnee of this.donnees.values()) {
      if (!donnee.consultation) continue;
      const topic = resolveTopic(donnee.topicSensor, donnee.id);
      this.topicToId.set(topic, donnee.id);
      this.evoo7Client.subscribeTopic(topic, this.config.mqtt.qos as 0 | 1 | 2);
    }
  }

  private handleEvoo7Message(topic: string, payload: string): void {
    const id = this.topicToId.get(topic);
    if (!id) return;

    const donnee = this.donnees.get(id);
    if (!donnee) return;

    const value = extractSensorValue(payload);
    if (value === undefined) {
      this.logger.warn('Evoo7Service', `Message EVOO7 sans valeur exploitable pour ${id} sur ${topic}`);
      return;
    }

    // Pas de traduction serveur pour les énumérations : le code brut est relayé tel quel, HA
    // traduit code→libellé côté affichage via value_template (voir classification.ts).
    // attributs_taxonomie porté ici (pas dans le message de découverte, ignoré par HA — voir
    // discovery.ts) : json_attributes_topic pointe vers ce même topic d'état.
    const taxonomy = resolveTaxonomy(donnee);
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId: id,
      state: {
        state: value,
        attributes: { evoo7_id: id, attributs_taxonomie: buildAttributsTaxonomie(taxonomy) }
      }
    });

    this.lastMessageAt = new Date().toISOString();
  }

  // ==========================================================================
  // Discovery — données
  // ==========================================================================

  private publishInitialDiscoveries(): void {
    for (const donnee of this.donnees.values()) {
      if (donnee.consultation || donnee.miseAJour) {
        this.publishDonneeDiscovery(donnee);
      }
    }
  }

  private publishDonneeDiscovery(donnee: Evoo7DataDefinition): void {
    const component = determineComponent(donnee);
    const taxonomy = resolveTaxonomy(donnee);
    // 'sensor'/'binary_sensor' (y compris toutes les énumérations, jamais commandables — voir
    // classification.ts) ne sont jamais commandables, quelle que soit la sélection utilisateur —
    // binary_sensor n'a pas de command_topic en découverte MQTT HA.
    const commandEnabled = component !== 'sensor' && component !== 'binary_sensor' && donnee.updatable && donnee.miseAJour;

    // attributs_taxonomie n'est plus ici : un message de découverte HA est validé contre un
    // schéma strict par plateforme, les clés non reconnues (dont celle-ci) sont ignorées en
    // silence — porté par l'état à la place (handleEvoo7Message), via json_attributes_topic.
    const extra: Record<string, unknown> = {};
    if (donnee.isConfigData) {
      extra.entity_category = 'config';
    }
    if (component === 'number') {
      extra.min = donnee.min;
      extra.max = donnee.max;
      extra.step = determineNumberStep(donnee);
    }
    if (commandEnabled) {
      extra.command_template = buildCommandTemplate(component);
    }
    if (donnee.deviceClass) {
      extra.device_class = donnee.deviceClass;
      if (donnee.unitOfMeasurement) {
        extra.unit_of_measurement = donnee.unitOfMeasurement;
      }
    }
    if (component === 'binary_sensor') {
      if (donnee.payloadOn) extra.payload_on = donnee.payloadOn;
      if (donnee.payloadOff) extra.payload_off = donnee.payloadOff;
    }

    const essential: EssentialEntityData = {
      name: taxonomy.rawQuoi,
      valueTemplate: buildValueTemplate(),
      commandEnabled,
      device: EVOO7_DEVICE,
      extra
    };

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery`, {
      bridgeInstance: this.config.bridgeInstance,
      component,
      objectId: donnee.id,
      deviceId: donnee.id,
      essential
    });
  }

  /**
   * Retire la découverte HA d'une donnée qui vient de passer de sélectionnée (consultation ou
   * miseAJour) à totalement désélectionnée — sans ça l'entité restait visible dans HA
   * indéfiniment (voir TODO.md, correctif socle discovery.ts::unpublishDiscovery).
   */
  private removeDonneeDiscovery(donnee: Evoo7DataDefinition): void {
    const component = determineComponent(donnee);
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery:remove`, {
      bridgeInstance: this.config.bridgeInstance,
      component,
      objectId: donnee.id
    });
  }

  // ==========================================================================
  // Commandes HA → EVOO7
  // ==========================================================================

  private handleHaCommand(deviceId: string, payload: Record<string, unknown>): void {
    const donnee = this.donnees.get(deviceId);
    if (!donnee) {
      this.logger.warn('Evoo7Service', `Commande reçue pour une donnée inconnue: ${deviceId}`);
      return;
    }

    if (!donnee.updatable || !donnee.miseAJour) {
      this.logger.warn('Evoo7Service', `Commande reçue pour ${deviceId} mais mise à jour désactivée`);
      this.eventBus.emitGeneric('evoo7:error',
        createEvoo7Error('EVOO7_NOT_UPDATABLE', `Donnée ${deviceId} non modifiable`, 'evoo7:command', { deviceId }));
      return;
    }

    // Défense en profondeur : la découverte ne publie jamais de command_topic pour les
    // énumérations (component 'sensor', voir publishDonneeDiscovery) — si cet événement arrive
    // quand même, on refuse plutôt que d'envoyer une valeur potentiellement mal traduite
    // (voir la note sur les codes réels vs documentés dans classification.ts).
    if (determineComponent(donnee) === 'sensor') {
      this.logger.warn('Evoo7Service', `Commande reçue pour ${deviceId} qui est en lecture seule (sensor)`);
      this.eventBus.emitGeneric('evoo7:error',
        createEvoo7Error('EVOO7_NOT_UPDATABLE', `Donnée ${deviceId} en lecture seule`, 'evoo7:command', { deviceId }));
      return;
    }

    // payload.value est déjà la valeur brute prête à transmettre (encapsulée en JSON par HA via
    // command_template — voir classification.ts).
    const value = payload.value;
    if (value === undefined || value === null) {
      this.logger.warn('Evoo7Service', `Commande sans "value" pour ${deviceId}: ${JSON.stringify(payload)}`);
      return;
    }

    const message = resolveCommandMessage(this.config.formatMessageCommand, donnee.id, String(value));

    try {
      this.evoo7Client.publish(this.config.topicCommand, message, this.config.mqtt.qos as 0 | 1 | 2);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Evoo7Service', `Échec d'envoi de la commande EVOO7 pour ${deviceId}: ${errMessage}`);
      this.eventBus.emitGeneric('evoo7:error',
        createEvoo7Error('EVOO7_COMMAND_FAILED', errMessage, 'evoo7:command', { deviceId }));
    }
  }

  // ==========================================================================
  // Statut / événements persistants
  // ==========================================================================

  getStatus(): Evoo7Status {
    let consultationCount = 0;
    let miseAJourCount = 0;
    for (const donnee of this.donnees.values()) {
      if (donnee.consultation) consultationCount++;
      if (donnee.miseAJour) miseAJourCount++;
    }
    return {
      evoo7Connected: this.evoo7Client.isConnected(),
      bridgeConnected: this.bridgeConnected,
      donneesCount: this.donnees.size,
      consultationCount,
      miseAJourCount,
      lastMessageAt: this.lastMessageAt
    };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('evoo7:status', this.getStatus());
  }

  private emitDonneesList(): void {
    this.eventBus.emitGeneric('evoo7:donnees:list', { donnees: Array.from(this.donnees.values()) });
  }

  // ==========================================================================
  // Socket.io (via SocketBridge, EventBus générique)
  // ==========================================================================

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric('evoo7:status:get', () => this.emitStatus());
    this.eventBus.onGeneric('evoo7:donnees:list:get', () => this.emitDonneesList());

    this.eventBus.onGeneric<{
      id: string;
      consultation: boolean;
      miseAJour: boolean;
      topicSensor: string;
      formatMessageSensor: string;
      taxonomieQuoi: string;
      taxonomieLieuPrecis: string;
      taxonomieLieu: string;
      taxonomiePere: string;
      taxonomieGrandPere: string;
      deviceClass: string;
      unitOfMeasurement: string;
      forcedComponent: string;
      payloadOn: string;
      payloadOff: string;
    }>('evoo7:donnee:save', (data) => {
      const donnee = this.donnees.get(data.id);
      if (!donnee) {
        this.emitDonneeError(data.id, `Donnée inconnue: ${data.id}`, 'EVOO7_UNKNOWN_DATA');
        return;
      }

      // État précédent conservé en bloc pour rollback si l'écriture disque échoue — jamais
      // laisser le client croire qu'un changement est appliqué s'il n'a pas été réellement
      // persisté (voir TODO.md, même défaut déjà corrigé pour le formulaire générique de config).
      const previous = { ...donnee };

      // Un seul bouton "sauvegarder la ligne" (taxonomie, classe HA, topic/format et sélection
      // ensemble) — se désabonner de l'ancien topic si consultation était active, avant toute
      // mutation, comme le faisaient séparément set_selection/set_topic.
      if (donnee.consultation) {
        this.evoo7Client.unsubscribeTopic(resolveTopic(donnee.topicSensor, donnee.id));
        this.topicToId.delete(resolveTopic(donnee.topicSensor, donnee.id));
      }

      donnee.consultation = data.consultation;
      // miseAJour n'a de sens que si la donnée est updatable — ignoré silencieusement sinon.
      donnee.miseAJour = donnee.updatable ? data.miseAJour : false;
      donnee.topicSensor = data.topicSensor;
      donnee.formatMessageSensor = data.formatMessageSensor;
      donnee.taxonomieQuoi = data.taxonomieQuoi || undefined;
      donnee.taxonomieLieuPrecis = data.taxonomieLieuPrecis || undefined;
      donnee.taxonomieLieu = data.taxonomieLieu || undefined;
      donnee.taxonomiePere = data.taxonomiePere || undefined;
      donnee.taxonomieGrandPere = data.taxonomieGrandPere || undefined;
      donnee.deviceClass = data.deviceClass || undefined;
      donnee.unitOfMeasurement = data.unitOfMeasurement || undefined;
      donnee.forcedComponent = data.forcedComponent || undefined;
      donnee.payloadOn = data.payloadOn || undefined;
      donnee.payloadOff = data.payloadOff || undefined;

      if (donnee.consultation) {
        const topic = resolveTopic(donnee.topicSensor, donnee.id);
        this.topicToId.set(topic, donnee.id);
        this.evoo7Client.subscribeTopic(topic, this.config.mqtt.qos as 0 | 1 | 2);
      }

      const result = this.persistDonneesConfig();
      if (!result.success) {
        Object.assign(donnee, previous);
        // Restaure l'abonnement d'origine si la sauvegarde échoue après le ré-abonnement ci-dessus.
        if (previous.consultation) {
          const topic = resolveTopic(previous.topicSensor, donnee.id);
          this.topicToId.set(topic, donnee.id);
          this.evoo7Client.subscribeTopic(topic, this.config.mqtt.qos as 0 | 1 | 2);
        }
        this.emitDonneeError(data.id, `Échec de sauvegarde: ${result.error}`);
        this.emitDonneesList(); // republie l'état réel (annulé) pour resynchroniser le client
        return;
      }

      const wasPublished = previous.consultation || previous.miseAJour;
      const isPublished = donnee.consultation || donnee.miseAJour;
      if (isPublished) {
        this.publishDonneeDiscovery(donnee);
      } else if (wasPublished) {
        this.removeDonneeDiscovery(donnee);
      }

      this.eventBus.emitGeneric('evoo7:donnee:save:response', { id: data.id, success: true });
      this.emitDonneesList();
    });
  }

  private emitDonneeError(deviceId: string, message: string, code: 'EVOO7_UNKNOWN_DATA' | 'EVOO7_SAVE_FAILED' = 'EVOO7_SAVE_FAILED'): void {
    this.eventBus.emitGeneric('evoo7:error', createEvoo7Error(code, message, 'evoo7:donnee', { deviceId }));
    this.eventBus.emitGeneric('evoo7:donnee:save:response', { id: deviceId, success: false, error: message });
  }

  /**
   * Sauvegarde l'état courant des 43 données dans config-evoo7-donnees-v1.0.yaml.
   * Retourne le résultat réel — les appelants (handlers set_selection/set_topic) doivent l'utiliser
   * pour confirmer honnêtement au client, jamais supposer un succès (voir TODO.md, même défaut que
   * le formulaire générique de config module avant correctif).
   */
  private persistDonneesConfig(): { success: boolean; error?: string } {
    const result = this.configFileManager.save({
      evoo7_donnees: Object.fromEntries(this.donnees)
    });
    if (!result.success) {
      this.logger.error('Evoo7Service', `Échec de sauvegarde de la configuration EVOO7: ${result.error}`);
    }
    return result;
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<Evoo7Config>
  ): Evoo7Service {
    return new Evoo7Service(eventBus, logger, configProvider);
  }
}
