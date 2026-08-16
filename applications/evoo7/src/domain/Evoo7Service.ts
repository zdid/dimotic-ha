/**
 * Evoo7Service
 *
 * Orchestrateur principal de l'application EVOO7 : connexion Socket.IO DIRECTE au boîtier EVOO7
 * (son protocole natif, via Evoo7SocketIoClient — 16/08/2026, remplace l'ancien passage par un
 * broker MQTT dédié + traducteur externe, voir Evoo7SocketIoClient.ts pour le détail), broker HA
 * via les événements EventBus du socle `integration:evoo7:*` (comme RFXCOM), traduction
 * bidirectionnelle des valeurs, gestion des 43 données connues (config-evoo7-donnees-v1.0.yaml).
 *
 * Couche : Domaine (Métier) — orchestration uniquement, délègue à ConfigFileManager/Evoo7SocketIoClient.
 */

import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider, EssentialEntityData } from '../../../core/dist/exports';
import { createEvoo7Error, getStateTopic, getCommandTopic, generateRandomBridgeInstance } from '../../../core/dist/exports';
import { evoo7ConfigSchema, type Evoo7Config } from './config-schema';
import type { Evoo7DonneesConfigFile } from './donnees-config-schema';
import type { Evoo7DataDefinition, Evoo7Status, Evoo7ThermostatConfig } from './types';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { Evoo7SocketIoClient } from './socketio/Evoo7SocketIoClient';
import {
  determineComponent, determineNumberStep, buildValueTemplate, buildCommandTemplate,
  buildModeStateTemplate, buildPresetModeStateTemplate
} from './classification';
import { resolveTaxonomy, buildAttributsTaxonomie } from './taxonomy';

const MODULE_NAME = 'evoo7';

/** Un seul système logique EVOO7 Control — pas de sous-devices comme RFXCOM. */
const EVOO7_DEVICE = {
  identifiers: ['evoo7_control'],
  name: 'EVOO7 Control',
  manufacturer: 'VR Electronique',
  model: 'EVOO7 Control'
};

/**
 * Entité `climate` composite (thermostat) — regroupe plusieurs données EVOO7 existantes sous une
 * seule entité HA standard. deviceId fixe : un seul système EVOO7 dans ce déploiement.
 */
const THERMOSTAT_DEVICE_ID = 'thermostat';
/** Les 7 données dont dépend le thermostat — forcées en consultation dès l'activation (voir handler evoo7:thermostat:save). */
const THERMOSTAT_DEPENDENT_IDS = [
  'temp_amb', 'consigne_normal', 'etat_fonctionnement',
  'etat_circulateur_pc', 'etat_circulateur_radiateur', 'etat_eco', 'temp_ext'
] as const;
/** Parmi les données ci-dessus, celles dont un nouveau message doit redéclencher le calcul de `action`. */
const THERMOSTAT_ACTION_TRIGGER_IDS = ['etat_circulateur_pc', 'etat_circulateur_radiateur', 'etat_fonctionnement', 'temp_ext'] as const;
/** Taxonomie fixe de l'entité climate elle-même (pas une des 43 données individuelles). */
const THERMOSTAT_TAXONOMY_SOURCE = { description: '', taxonomieQuoi: 'Thermostat', taxonomieLieu: 'Pompe à chaleur' };

export interface IEvoo7Service {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Evoo7Status;
}

export class Evoo7Service implements IEvoo7Service {
  private config: Evoo7Config;
  private donneesConfig: Evoo7DonneesConfigFile;
  private donnees: Map<string, Evoo7DataDefinition> = new Map();
  private thermostat: Evoo7ThermostatConfig = { enabled: false, allowCooling: false };
  /** Dernière valeur brute connue par donnée — nécessaire pour recalculer `action` du thermostat
   *  quand une seule des données sources reçoit un nouveau message (les autres restent à relire). */
  private lastRawValues: Map<string, string> = new Map();

  private configFileManager: ConfigFileManager;
  private evoo7Client: Evoo7SocketIoClient;

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
    this.donneesConfig = { evoo7_donnees: {}, thermostat: { enabled: false, allowCooling: false } };
    this.evoo7Client = new Evoo7SocketIoClient(this.logger);
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
   *
   * ⭐ fonctionnelles-supervisor_specs v2.3 §9.2 : `bridgeInstance` absent de la config sur disque
   * → tirage aléatoire généré et persisté immédiatement (pas juste un défaut Zod en mémoire).
   * N'affecte pas une instance déjà en production (valeur déjà écrite en dur, jamais régénérée).
   */
  private loadConfig(): Evoo7Config {
    const raw = this.configProvider.getAppConfig() as Partial<Evoo7Config>;
    if (!raw.bridgeInstance) {
      const parsed = evoo7ConfigSchema.parse({ ...raw, bridgeInstance: generateRandomBridgeInstance('evoo7') });
      this.configProvider.savePartialConfig(parsed);
      this.logger.info('Evoo7Service', `bridgeInstance généré et persisté au premier démarrage: ${parsed.bridgeInstance}`);
      return parsed;
    }
    return evoo7ConfigSchema.parse(raw);
  }

  // ==========================================================================
  // Cycle de vie
  // ==========================================================================

  async start(): Promise<void> {
    this.logger.info('Evoo7Service', 'Démarrage du service EVOO7...');

    this.donneesConfig = this.configFileManager.load();
    this.donnees = new Map(Object.entries(this.donneesConfig.evoo7_donnees));
    this.thermostat = this.donneesConfig.thermostat;

    this.setupSocleEventListeners();
    this.setupSocketEventListeners();

    this.eventBus.emitGeneric('integration:bridge:register', {
      moduleName: MODULE_NAME,
      bridgeInstance: this.config.bridgeInstance
    });

    this.evoo7Client.onData((name, value) => this.handleEvoo7Data(name, value));
    this.evoo7Client.onConnectionChange(() => this.emitStatus());

    // La publication de la découverte HA est déclenchée par le premier événement
    // integration:evoo7:bridge:connection (voir setupSocleEventListeners) — PAS synchronement
    // ici : registerBridge() ne garantit aucunement que le bridge socle est déjà connecté au
    // broker HA au moment où le handler retourne (connexion établie de façon asynchrone en
    // arrière-plan), et publier avant serait un throw synchrone ("MQTT client is not connected")
    // qui ferait échouer tout le démarrage du service.
    try {
      await this.evoo7Client.connect(this.config.box);
    } catch (error) {
      // Échec de connexion = WARNING, pas de crash (même contrat que RFXCOM).
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Evoo7Service', `Boîtier EVOO7 indisponible au démarrage: ${message}`);
      this.eventBus.emitGeneric('evoo7:error',
        createEvoo7Error('EVOO7_CONNECTION_ERROR', message, 'evoo7:box', { host: this.config.box.address }));
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
    // globalement (AppService.setupEventListeners) — mais sans lui, un changement d'adresse/port/
    // identifiants du boîtier via "Paramètres Techniques → EVOO7" restait sans effet tant que le
    // serveur n'était pas redémarré manuellement. Correctif ciblé, propre à ce module : ne
    // reconnecte QUE le client EVOO7 (pas tout le service) quand `box` a réellement changé.
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>(
      'app:module:config:saved',
      (event) => {
        if (event.moduleId !== MODULE_NAME || !event.success) return;
        this.reconnectBoxIfConfigChanged();
      }
    );
  }

  /**
   * Recharge la config et reconnecte le client EVOO7 si `box` a changé — comparaison
   * structurelle simple (objet de valeurs primitives uniquement, `evoo7BoxConfigSchema`).
   */
  private async reconnectBoxIfConfigChanged(): Promise<void> {
    const previousBox = this.config.box;
    this.config = this.loadConfig();

    if (JSON.stringify(previousBox) === JSON.stringify(this.config.box)) {
      return;
    }

    this.logger.info('Evoo7Service', 'Configuration du boîtier EVOO7 modifiée — reconnexion à chaud...');
    try {
      await this.evoo7Client.disconnect();
      await this.evoo7Client.connect(this.config.box);
      this.logger.info('Evoo7Service', 'Reconnexion au boîtier EVOO7 réussie après changement de configuration');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Evoo7Service', `Échec de reconnexion au boîtier EVOO7 après changement de configuration: ${message}`);
      this.eventBus.emitGeneric('evoo7:error',
        createEvoo7Error('EVOO7_CONNECTION_ERROR', message, 'evoo7:box', { host: this.config.box.address }));
    }
    this.emitStatus();
  }

  // ==========================================================================
  // Réception EVOO7 (Socket.IO direct au boîtier)
  // ==========================================================================

  /**
   * Reçoit CHAQUE clé du boîtier (`datas`, voir Evoo7SocketIoClient) — contrairement à l'ancien
   * abonnement MQTT par topic, rien ne filtre en amont : le boîtier envoie tout, `consultation`
   * (choix utilisateur de suivre ou non cette donnée) se vérifie donc ici, pas à la connexion.
   */
  private handleEvoo7Data(id: string, rawValue: unknown): void {
    const donnee = this.donnees.get(id);
    if (!donnee || !donnee.consultation) return;

    if (rawValue === undefined || rawValue === null) return;
    const value = String(rawValue);

    this.lastRawValues.set(id, value);

    // Pas de traduction serveur pour les énumérations : le code brut est relayé tel quel, HA
    // traduit code→libellé côté affichage via value_template (voir classification.ts).
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId: id,
      state: { state: value }
    });

    if (this.thermostat.enabled && (THERMOSTAT_ACTION_TRIGGER_IDS as readonly string[]).includes(id)) {
      this.publishThermostatState();
    }

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
    if (this.thermostat.enabled) {
      this.publishThermostatDiscovery();
      this.publishThermostatState();
    }
  }

  private publishDonneeDiscovery(donnee: Evoo7DataDefinition): void {
    const component = determineComponent(donnee);
    const taxonomy = resolveTaxonomy(donnee);
    // 'sensor'/'binary_sensor' (y compris toutes les énumérations, jamais commandables — voir
    // classification.ts) ne sont jamais commandables, quelle que soit la sélection utilisateur —
    // binary_sensor n'a pas de command_topic en découverte MQTT HA.
    const commandEnabled = component !== 'sensor' && component !== 'binary_sensor' && donnee.updatable && donnee.miseAJour;

    const extra: Record<string, unknown> = {};
    if (donnee.isConfigData) {
      // HA rejette entity_category:"config" sur sensor/binary_sensor (lecture seule, ne peut pas
      // "configurer" quoi que ce soit au sens HA) — constaté en direct ("entity category is set
      // to config", entité jamais ajoutée). "diagnostic" est la catégorie valide pour ce cas ;
      // "config" reste correct pour les composants pilotables (number/switch/select).
      extra.entity_category = component === 'sensor' || component === 'binary_sensor' ? 'diagnostic' : 'config';
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
      attributsTaxonomie: buildAttributsTaxonomie(taxonomy),
      device: { ...EVOO7_DEVICE, suggested_area: taxonomy.nomLieu ?? undefined },
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
  // Discovery — entité climate composite (thermostat)
  // ==========================================================================

  /**
   * Publie la découverte `climate` du thermostat composite. Le socle n'autorise qu'un seul
   * command_topic par entité (voir stateCommand.ts) — climate en a besoin de 3 (température,
   * mode, preset) : les 3 pointent donc vers LE MÊME topic de commande (celui de cette entité),
   * chacun avec son propre command_template qui enveloppe la valeur avec un discriminant `field`
   * (voir handleThermostatCommand). Les topics d'état température/consigne/mode/preset réutilisent
   * TELS QUELS les topics déjà publiés par les données sources (temp_amb/consigne_normal/
   * etat_fonctionnement/etat_eco) — aucune republication dupliquée.
   */
  private publishThermostatDiscovery(): void {
    const taxonomy = resolveTaxonomy(THERMOSTAT_TAXONOMY_SOURCE);
    const bridge = this.config.bridgeInstance;
    const commandTopic = getCommandTopic(MODULE_NAME, bridge, THERMOSTAT_DEVICE_ID);

    const modes = this.thermostat.allowCooling ? ['off', 'heat', 'cool'] : ['off', 'heat'];

    const extra: Record<string, unknown> = {
      current_temperature_topic: getStateTopic(MODULE_NAME, bridge, 'temp_amb'),
      current_temperature_template: '{{ value_json.state }}',

      temperature_state_topic: getStateTopic(MODULE_NAME, bridge, 'consigne_normal'),
      temperature_state_template: '{{ value_json.state }}',
      temperature_command_topic: commandTopic,
      temperature_command_template: '{"field":"temperature","value":{{ value }} }',
      min_temp: 10,
      max_temp: 30,
      temp_step: 0.5,

      modes,
      mode_state_topic: getStateTopic(MODULE_NAME, bridge, 'etat_fonctionnement'),
      mode_state_template: buildModeStateTemplate(),
      mode_command_topic: commandTopic,
      mode_command_template: '{"field":"mode","value":"{{ value }}"}',

      preset_modes: ['eco'],
      preset_mode_state_topic: getStateTopic(MODULE_NAME, bridge, 'etat_eco'),
      preset_mode_value_template: buildPresetModeStateTemplate(),
      preset_mode_command_topic: commandTopic,
      preset_mode_command_template: '{"field":"preset_mode","value":"{{ value }}"}',

      // action_topic réutilise le topic d'état par défaut de CETTE entité (calculé côté serveur,
      // voir publishThermostatState) — buildDiscoveryPayload le fixe déjà à cette valeur pour
      // state_topic, on la reproduit ici pour action_topic.
      action_topic: getStateTopic(MODULE_NAME, bridge, THERMOSTAT_DEVICE_ID),
      action_template: '{{ value_json.state }}'
    };

    const essential: EssentialEntityData = {
      name: taxonomy.rawQuoi,
      commandEnabled: true,
      attributsTaxonomie: buildAttributsTaxonomie(taxonomy),
      device: { ...EVOO7_DEVICE, suggested_area: taxonomy.nomLieu ?? undefined },
      extra
    };

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery`, {
      bridgeInstance: bridge,
      component: 'climate',
      objectId: THERMOSTAT_DEVICE_ID,
      deviceId: THERMOSTAT_DEVICE_ID,
      essential
    });
  }

  private removeThermostatDiscovery(): void {
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery:remove`, {
      bridgeInstance: this.config.bridgeInstance,
      component: 'climate',
      objectId: THERMOSTAT_DEVICE_ID
    });
  }

  /**
   * Calcule et publie `action` (état propre de l'entité climate) : `heating` si un des deux
   * circulateurs (plancher chauffant ou radiateurs) est actif et le mode n'est pas `off`, `idle`
   * si le mode est actif sans circulateur, `off` si le mode lui-même est `off`. Ignore si
   * `etat_fonctionnement` n'a encore jamais été reçu (pas assez d'info pour un calcul sûr).
   */
  private publishThermostatState(): void {
    const modeRaw = this.lastRawValues.get('etat_fonctionnement');
    if (modeRaw === undefined) return;

    const modeIsOff = !['1', 'on', 'Chauffage', '2', 'Refroidissement', 'Raffraichissement'].includes(modeRaw);
    const circulateurPc = this.lastRawValues.get('etat_circulateur_pc');
    const circulateurRadiateur = this.lastRawValues.get('etat_circulateur_radiateur');
    const circulateurActif = circulateurPc === '1' || circulateurRadiateur === '1';

    const action = modeIsOff ? 'off' : (circulateurActif ? 'heating' : 'idle');
    const tempExt = this.lastRawValues.get('temp_ext');

    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.config.bridgeInstance,
      deviceId: THERMOSTAT_DEVICE_ID,
      state: {
        state: action,
        attributes: { temp_ext: tempExt }
      }
    });
  }

  // ==========================================================================
  // Commandes HA → EVOO7
  // ==========================================================================

  private handleHaCommand(deviceId: string, payload: Record<string, unknown>): void {
    if (deviceId === THERMOSTAT_DEVICE_ID) {
      this.handleThermostatCommand(payload);
      return;
    }

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

    this.sendEvoo7Command(donnee, String(value));
  }

  /**
   * Commande reçue sur le topic partagé de l'entité climate composite (thermostat) — voir
   * publishThermostatDiscovery, les 3 command_template envoient toujours `{field, value}` sur le
   * MÊME topic. Traduit vers le code EVOO7 attendu et route vers la donnée réelle correspondante.
   * ⚠️ Contourne DÉLIBÉRÉMENT la restriction "énumération = toujours lecture seule"
   * (determineComponent) pour etat_fonctionnement/etat_eco : ce chemin est le seul point d'entrée
   * qui écrit ces deux données, avec les codes documentés (jamais vérifiés fiables en conditions
   * réelles pour la commande — voir classification.ts et le TODO). Les entités individuelles
   * etat_fonctionnement/etat_eco restent, elles, en lecture seule comme avant.
   */
  private handleThermostatCommand(payload: Record<string, unknown>): void {
    const field = payload.field;
    const value = payload.value;
    if (value === undefined || value === null) {
      this.logger.warn('Evoo7Service', `Commande thermostat sans "value": ${JSON.stringify(payload)}`);
      return;
    }

    if (field === 'temperature') {
      const donnee = this.donnees.get('consigne_normal');
      if (!donnee) return;
      this.sendEvoo7Command(donnee, String(value));
      return;
    }

    if (field === 'mode') {
      const donnee = this.donnees.get('etat_fonctionnement');
      if (!donnee) return;
      const code = value === 'off' ? '0' : value === 'heat' ? '1' : value === 'cool' ? '2' : undefined;
      if (code === undefined) {
        this.logger.warn('Evoo7Service', `Mode thermostat inconnu: ${JSON.stringify(value)}`);
        return;
      }
      this.sendEvoo7Command(donnee, code);
      return;
    }

    if (field === 'preset_mode') {
      const donnee = this.donnees.get('etat_eco');
      if (!donnee) return;
      const code = value === 'eco' ? '0' : '1';
      this.sendEvoo7Command(donnee, code);
      return;
    }

    this.logger.warn('Evoo7Service', `Champ de commande thermostat inconnu: ${JSON.stringify(field)}`);
  }

  /** Envoie la commande EVOO7 (`update`, voir Evoo7SocketIoClient) — fire-and-forget du point de
   *  vue de l'appelant (même contrat qu'avant), l'échec est journalisé/émis en asynchrone. */
  private sendEvoo7Command(donnee: Evoo7DataDefinition, rawValue: string): void {
    this.evoo7Client.sendUpdate(donnee.id, rawValue).catch((error: Error) => {
      this.logger.error('Evoo7Service', `Échec d'envoi de la commande EVOO7 pour ${donnee.id}: ${error.message}`);
      this.eventBus.emitGeneric('evoo7:error',
        createEvoo7Error('EVOO7_COMMAND_FAILED', error.message, 'evoo7:command', { deviceId: donnee.id }));
    });
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
    this.eventBus.emitGeneric('evoo7:donnees:list', {
      donnees: Array.from(this.donnees.values()),
      thermostat: this.thermostat
    });
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

      const result = this.persistDonneesConfig();
      if (!result.success) {
        Object.assign(donnee, previous);
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

    this.eventBus.onGeneric<{ enabled: boolean; allowCooling: boolean }>('evoo7:thermostat:save', (data) => {
      const previousThermostat = { ...this.thermostat };
      const previousDonnees = new Map(Array.from(this.donnees.entries()).map(([id, d]) => [id, { ...d }]));

      this.thermostat = { enabled: data.enabled, allowCooling: data.allowCooling };

      // Activation : force la sélection des données dont dépend le thermostat — jamais l'inverse
      // (désactiver le thermostat ne décoche rien automatiquement, voir plan).
      if (this.thermostat.enabled) {
        for (const id of THERMOSTAT_DEPENDENT_IDS) {
          const donnee = this.donnees.get(id);
          if (!donnee) continue;
          const wasSelected = donnee.consultation || donnee.miseAJour;
          donnee.consultation = true;
          if (donnee.updatable) donnee.miseAJour = true;
          if (!wasSelected) this.publishDonneeDiscovery(donnee);
        }
      }

      const result = this.persistDonneesConfig();

      if (!result.success) {
        this.thermostat = previousThermostat;
        this.donnees = previousDonnees;
        this.eventBus.emitGeneric('evoo7:error',
          createEvoo7Error('EVOO7_SAVE_FAILED', `Échec de sauvegarde: ${result.error}`, 'evoo7:thermostat'));
        this.eventBus.emitGeneric('evoo7:thermostat:save:response', { success: false, error: result.error });
        this.emitDonneesList();
        return;
      }

      if (this.thermostat.enabled) {
        this.publishThermostatDiscovery();
        this.publishThermostatState();
      } else {
        this.removeThermostatDiscovery();
      }

      this.eventBus.emitGeneric('evoo7:thermostat:save:response', { success: true });
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
      evoo7_donnees: Object.fromEntries(this.donnees),
      thermostat: this.thermostat
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
