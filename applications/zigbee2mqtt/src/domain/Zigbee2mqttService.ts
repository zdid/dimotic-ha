/**
 * Zigbee2mqttService — pilote zigbee2mqtt (conception-gestion-pilotes_specs v1.5 §9).
 *
 * N'installe ni ne démarre zigbee2mqtt : parle à une instance existante par MQTT, via la connexion « passthrough » du socle
 * (`integration:zigbee2mqtt:passthrough:*`). Suit `bridge/devices`, `bridge/info` et `bridge/state`, envoie les requêtes
 * `bridge/request/...` et retrouve leur réponse par le champ `transaction`. Le reste (annonce du pont, aperçu, jeton,
 * signature) est fait par `PilotePont` / le cœur. Les découvertes HA des appareils ne passent PAS par ici : zigbee2mqtt les
 * publie lui-même et `nommage` les relaie (non déplacé).
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { computeBridgeInstance, PilotePont, attendreRetraitHa } from '../../../core/dist/exports';
import { zigbee2mqttConfigSchema, type Zigbee2mqttConfig } from './config-schema';
import { Zigbee2mqttPilote } from './Zigbee2mqttPilote';
import type { Z2mDevice, Z2mReponse } from './types';

export const MODULE_NAME = 'zigbee2mqtt';

export interface IZigbee2mqttService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface PassthroughMessage {
  bridgeInstance: string;
  topic: string;
  payload: string;
}

export class Zigbee2mqttService implements IZigbee2mqttService {
  private readonly config: Zigbee2mqttConfig;
  private readonly effectiveBridgeInstance: string;
  private devices: Z2mDevice[] = [];
  private etat: 'online' | 'offline' | 'inconnu' = 'inconnu';
  private version: string | undefined;
  private compteur = 0;
  private readonly attentes = new Map<string, { resolve: (r: Z2mReponse) => void; timer: NodeJS.Timeout }>();
  private pilotePont: PilotePont | null = null;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    configProvider: IAppConfigProvider<Zigbee2mqttConfig>
  ) {
    this.config = zigbee2mqttConfigSchema.parse(configProvider.getAppConfig() ?? {});
    this.effectiveBridgeInstance = computeBridgeInstance(this.config.bridgeInstance, process.env.DIMOTIC_MACHINE_ID);
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<Zigbee2mqttConfig>): Zigbee2mqttService {
    return new Zigbee2mqttService(eventBus, logger, configProvider);
  }

  private sujet(suffixe: string): string {
    return `${this.config.baseTopic}/bridge/${suffixe}`;
  }

  async start(): Promise<void> {
    this.logger.info('Zigbee2mqttService', 'Démarrage du pilote zigbee2mqtt...');

    this.eventBus.onGeneric<PassthroughMessage>(`integration:${MODULE_NAME}:passthrough:message`, (m) => this.surMessage(m));
    this.eventBus.onGeneric<{ bridgeInstance: string; connected: boolean }>(`integration:${MODULE_NAME}:bridge:connection`, (e) => {
      if (e.bridgeInstance === this.effectiveBridgeInstance && e.connected) this.sAbonner();
    });
    this.eventBus.emitGeneric('integration:bridge:register', { moduleName: MODULE_NAME, bridgeInstance: this.effectiveBridgeInstance });
    this.sAbonner();

    this.pilotePont = new PilotePont(this.eventBus, this.logger, {
      appId: MODULE_NAME,
      pont: this.effectiveBridgeInstance,
      type: 'zigbee2mqtt',
      capacites: ['lister', 'decouverts', 'adopter', 'modifier', 'remplacer', 'supprimer', 'appairer'],
      gestionnaire: new Zigbee2mqttPilote({
        devices: () => this.devices,
        enLigne: () => this.etat === 'online' && this.devices.length > 0,
        envoyer: (suffixe, payload) => this.envoyer(suffixe, payload),
        appairageDefautSec: () => this.config.appairageDefautSec,
        attendreRetraitHa: (noms) => attendreRetraitHa(this.eventBus, MODULE_NAME, noms),
        appairageMaxSec: () => this.config.appairageMaxSec
      })
    });
    this.pilotePont.start();
    this.logger.info('Zigbee2mqttService', `Pilote zigbee2mqtt démarré (sujet de base « ${this.config.baseTopic} », pont ${this.effectiveBridgeInstance})`);
  }

  async stop(): Promise<void> {
    this.pilotePont?.stop();
    for (const a of this.attentes.values()) clearTimeout(a.timer);
    this.attentes.clear();
    this.eventBus.emitGeneric('integration:bridge:unregister', { moduleName: MODULE_NAME, bridgeInstance: this.effectiveBridgeInstance });
    this.logger.info('Zigbee2mqttService', 'Pilote zigbee2mqtt arrêté');
  }

  private sAbonner(): void {
    for (const suffixe of ['devices', 'info', 'state', 'response/#']) {
      this.eventBus.emitGeneric(`integration:${MODULE_NAME}:passthrough:subscribe`, {
        bridgeInstance: this.effectiveBridgeInstance,
        topic: this.sujet(suffixe),
        qos: 1
      });
    }
  }

  /** Messages reçus : liste des appareils, état de z2m, réponses aux requêtes. */
  surMessage(m: PassthroughMessage): void {
    if (m.bridgeInstance !== this.effectiveBridgeInstance) return;
    const prefixe = `${this.config.baseTopic}/bridge/`;
    if (!m.topic.startsWith(prefixe)) return;
    const suffixe = m.topic.slice(prefixe.length);
    try {
      if (suffixe === 'devices') {
        const liste = JSON.parse(m.payload) as Z2mDevice[];
        if (Array.isArray(liste)) this.devices = liste;
      } else if (suffixe === 'state') {
        // z2m 1.x : texte « online » ; 2.x : {"state":"online"}
        const brut = m.payload.trim();
        this.etat = (brut.startsWith('{') ? (JSON.parse(brut) as { state?: string }).state : brut) === 'online' ? 'online' : 'offline';
      } else if (suffixe === 'info') {
        this.version = (JSON.parse(m.payload) as { version?: string }).version ?? this.version;
      } else if (suffixe.startsWith('response/')) {
        this.surReponse(m.payload);
      }
    } catch (error) {
      this.logger.warn('Zigbee2mqttService', `Message illisible sur ${m.topic} : ${error}`);
    }
  }

  private surReponse(payload: string): void {
    const r = JSON.parse(payload) as { transaction?: string; status?: string; data?: unknown; error?: string };
    if (!r.transaction) return;
    const attente = this.attentes.get(r.transaction);
    if (!attente) return;
    clearTimeout(attente.timer);
    this.attentes.delete(r.transaction);
    attente.resolve({ ok: r.status === 'ok', data: r.data, error: r.error });
  }

  /** Envoie `bridge/request/<suffixe>` et attend la réponse (ou le délai). */
  envoyer(suffixe: string, payload: Record<string, unknown>): Promise<Z2mReponse> {
    const transaction = `dimotic-${Date.now().toString(36)}-${(this.compteur++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.attentes.delete(transaction);
        resolve({ ok: false, error: `pas de réponse de zigbee2mqtt en ${this.config.delaiReponseSec} s` });
      }, this.config.delaiReponseSec * 1000);
      timer.unref?.();
      this.attentes.set(transaction, { resolve, timer });
      this.eventBus.emitGeneric(`integration:${MODULE_NAME}:passthrough:publish`, {
        bridgeInstance: this.effectiveBridgeInstance,
        topic: this.sujet(`request/${suffixe}`),
        payload: { ...payload, transaction },
        qos: 1,
        retain: false
      });
    });
  }
}
