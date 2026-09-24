/**
 * TestCycleService — application de TEST (⭐ 24/09/2026, demande explicite) pour éprouver ce que
 * fait le core quand une application est ajoutée, activée, désactivée, retirée ou plante.
 * Touche volontairement à tout ce que le core gère pour une application :
 * - MQTT via le core : `integration:bridge:register`/`unregister` + découverte HA de 2 capteurs
 *   (compteur, message) — permet de voir côté HA si l'application est considérée disponible ;
 * - HA WebSocket via le core : lecture d'une entité (HaBridgeClient) à chaque intervalle ;
 * - config Paramètres Techniques (3 champs, rechargée sur `app:module:config:saved`) ;
 * - données propres saisies sur sa page (3 champs, data/testcycle/donnees.yaml) ;
 * - modes de panne volontaires (voir CRASH_MODES).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { IEventBus, Logger, IAppConfigProvider, EssentialEntityData, HaBridgeClient } from '../../../core/dist/exports';
import { computeBridgeInstance } from '../../../core/dist/exports';
import {
  testcycleConfigSchema,
  testcycleDonneesSchema,
  type TestcycleConfig,
  type TestcycleDonnees
} from './config-schema';

const MODULE_NAME = 'testcycle';
const CRASH_AFTER_MS = 30000;

export interface ITestCycleService {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Lu par standalone.ts à la réception de SIGTERM (mode de panne `ignoreSigterm`). */
  ignoresSigterm(): boolean;
}

export class TestCycleService implements ITestCycleService {
  private config: TestcycleConfig;
  private donnees: TestcycleDonnees;
  private readonly bridgeInstance: string;
  private readonly donneesPath: string;
  private readonly startedAt = new Date();
  private compteur = 0;
  private timer: NodeJS.Timeout | null = null;
  private crashTimer: NodeJS.Timeout | null = null;
  private mqttConnected = false;
  private haState: string | null = null;
  private haError: string | null = null;
  private lastPublishAt: string | null = null;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<TestcycleConfig>,
    private readonly haBridgeClient?: HaBridgeClient
  ) {
    this.config = this.loadConfig();
    this.bridgeInstance = computeBridgeInstance(MODULE_NAME, process.env.DIMOTIC_MACHINE_ID);
    this.donneesPath = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', MODULE_NAME, 'donnees.yaml');
    this.donnees = this.loadDonnees();
    this.compteur = this.donnees.valeurDepart;
  }

  private loadConfig(): TestcycleConfig {
    return testcycleConfigSchema.parse(this.configProvider.getAppConfig() ?? {});
  }

  private loadDonnees(): TestcycleDonnees {
    try {
      if (fs.existsSync(this.donneesPath)) {
        return testcycleDonneesSchema.parse(yaml.load(fs.readFileSync(this.donneesPath, 'utf8')) ?? {});
      }
    } catch (error) {
      this.logger.warn('TestCycleService', `donnees.yaml illisible, valeurs par défaut: ${error}`);
    }
    return testcycleDonneesSchema.parse({});
  }

  ignoresSigterm(): boolean {
    return this.config.crashMode === 'ignoreSigterm';
  }

  async start(): Promise<void> {
    this.logger.info('TestCycleService', `Démarrage (pid ${process.pid}, mode de panne : ${this.config.crashMode})`);

    if (this.config.crashMode === 'demarrage') {
      throw new Error('Mode de panne « demarrage » : échec volontaire au démarrage');
    }

    this.setupListeners();

    this.eventBus.emitGeneric('integration:bridge:register', { moduleName: MODULE_NAME, bridgeInstance: this.bridgeInstance });
    this.publishDiscovery();

    if (this.haBridgeClient) {
      await this.haBridgeClient.start().catch((error) => {
        this.haError = String(error);
      });
    }

    this.armCrashTimer();
    this.restartTimer();
    await this.tick();
    this.emitDonnees();
    this.logger.info('TestCycleService', `Démarré — bridge ${this.bridgeInstance}, intervalle ${this.config.publishIntervalSec}s`);
  }

  async stop(): Promise<void> {
    this.logger.info('TestCycleService', 'Arrêt propre (désenregistrement du bridge MQTT)');
    if (this.timer) clearInterval(this.timer);
    if (this.crashTimer) clearTimeout(this.crashTimer);
    this.eventBus.emitGeneric('integration:bridge:unregister', { moduleName: MODULE_NAME, bridgeInstance: this.bridgeInstance });
  }

  private setupListeners(): void {
    this.eventBus.onGeneric('testcycle:status:get', () => this.emitStatus());
    this.eventBus.onGeneric('testcycle:donnees:get', () => this.emitDonnees());
    this.eventBus.onGeneric<Partial<TestcycleDonnees>>('testcycle:donnees:save', (data) => this.saveDonnees(data));

    this.eventBus.onGeneric<{ bridgeInstance: string; connected: boolean }>(`integration:${MODULE_NAME}:bridge:connection`, (data) => {
      if (data.bridgeInstance !== this.bridgeInstance) return;
      this.mqttConnected = data.connected;
      this.logger.info('TestCycleService', `Bridge MQTT ${data.connected ? 'connecté' : 'déconnecté'}`);
      this.emitStatus();
    });

    // HA redémarré : republier la découverte (sinon les entités disparaissent de HA).
    this.eventBus.onGeneric<{ bridgeInstance: string }>(`integration:${MODULE_NAME}:ha:online`, (data) => {
      if (data.bridgeInstance === this.bridgeInstance) this.publishDiscovery();
    });

    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== MODULE_NAME || !event.success) return;
      this.configProvider.reload();
      this.config = this.loadConfig();
      this.logger.info('TestCycleService', `Config rechargée : ${JSON.stringify(this.config)}`);
      this.armCrashTimer();
      this.restartTimer();
      void this.tick();
    });
  }

  private armCrashTimer(): void {
    if (this.crashTimer) clearTimeout(this.crashTimer);
    this.crashTimer = null;
    if (this.config.crashMode !== 'apres30s') return;
    this.logger.warn('TestCycleService', `Mode de panne « apres30s » : sortie brutale dans ${CRASH_AFTER_MS / 1000}s`);
    this.crashTimer = setTimeout(() => {
      this.logger.error('TestCycleService', 'Mode de panne « apres30s » : process.exit(1) volontaire, sans arrêt propre');
      process.exit(1);
    }, CRASH_AFTER_MS);
  }

  private restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), this.config.publishIntervalSec * 1000);
  }

  /** Une période : lecture de l'entité HA, publication MQTT (si active), statut. */
  private async tick(): Promise<void> {
    this.readHaEntity();
    if (this.donnees.publicationActive) {
      this.compteur++;
      this.publishState();
    }
    this.emitStatus();
  }

  private readHaEntity(): void {
    if (!this.haBridgeClient) {
      this.haError = 'HaBridgeClient absent';
      return;
    }
    if (!this.haBridgeClient.isAvailable()) {
      this.haState = null;
      this.haError = 'Référentiel HA indisponible côté core';
      return;
    }
    const entity = this.haBridgeClient.getEntity(this.config.haEntity);
    this.haState = entity ? String(entity.state) : null;
    this.haError = entity ? null : `Entité ${this.config.haEntity} introuvable`;
  }

  private device() {
    return {
      identifiers: [`testcycle_${this.bridgeInstance}`],
      name: `Test cycle (${process.env.DIMOTIC_MACHINE_ID || 'local'})`,
      manufacturer: 'dimotic-ha',
      model: 'testcycle'
    };
  }

  private publishDiscovery(): void {
    const sensors: Array<{ id: string; essential: EssentialEntityData }> = [
      {
        id: `testcycle_compteur_${this.bridgeInstance}`,
        essential: { name: 'Test cycle compteur', icon: 'mdi:counter', valueTemplate: '{{ value_json.state }}', device: this.device() }
      },
      {
        id: `testcycle_message_${this.bridgeInstance}`,
        essential: { name: 'Test cycle message', icon: 'mdi:message-text', valueTemplate: '{{ value_json.state }}', device: this.device() }
      }
    ];
    for (const s of sensors) {
      this.eventBus.emitGeneric(`integration:${MODULE_NAME}:discovery`, {
        bridgeInstance: this.bridgeInstance,
        component: 'sensor',
        objectId: s.id,
        deviceId: s.id,
        essential: s.essential
      });
    }
  }

  private publishState(): void {
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.bridgeInstance,
      deviceId: `testcycle_compteur_${this.bridgeInstance}`,
      state: { state: this.compteur, attributes: { ha_entity: this.config.haEntity, ha_state: this.haState, pid: process.pid } }
    });
    this.eventBus.emitGeneric(`integration:${MODULE_NAME}:state`, {
      bridgeInstance: this.bridgeInstance,
      deviceId: `testcycle_message_${this.bridgeInstance}`,
      state: { state: this.donnees.message }
    });
    this.lastPublishAt = new Date().toISOString();
  }

  private saveDonnees(data: Partial<TestcycleDonnees>): void {
    try {
      const donnees = testcycleDonneesSchema.parse({ ...this.donnees, ...data });
      fs.mkdirSync(path.dirname(this.donneesPath), { recursive: true });
      fs.writeFileSync(this.donneesPath, yaml.dump(donnees), 'utf8');
      this.donnees = donnees;
      this.compteur = donnees.valeurDepart;
      this.eventBus.emitGeneric('testcycle:donnees:save:result', { success: true });
      this.emitDonnees();
      void this.tick();
    } catch (error) {
      this.eventBus.emitGeneric('testcycle:donnees:save:result', { success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private emitDonnees(): void {
    this.eventBus.emitGeneric('testcycle:donnees', this.donnees);
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('testcycle:status', {
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      crashMode: this.config.crashMode,
      publishIntervalSec: this.config.publishIntervalSec,
      bridgeInstance: this.bridgeInstance,
      mqttConnected: this.mqttConnected,
      haEntity: this.config.haEntity,
      haState: this.haState,
      haError: this.haError,
      compteur: this.compteur,
      message: this.donnees.message,
      publicationActive: this.donnees.publicationActive,
      lastPublishAt: this.lastPublishAt
    });
  }
}
