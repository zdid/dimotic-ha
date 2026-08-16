// src/application/MqttEventBus.ts
// Implémentation de IEventBus backée par MQTT plutôt qu'un EventEmitter local — permet à une
// application de tourner dans son propre process OS tout en restant un remplacement transparent
// de EventBus pour le code métier existant (create*Service(eventBus, ...) ne change pas).
//
// Conforme à fonctionnelles-supervisor_specs_v2.4 §6.3. Phase 1 (espdisplay) : voir le module
// applications/core/src/supervisor/ pour le pont symétrique côté core (EventBus local ↔ MQTT).

import type { AppEvents } from '../types/events';
import type { IEventBus } from './IEventBus';
import type { Logger } from '../infrastructure/logger/index';
import { MqttTransport, type MqttMessage } from '../infrastructure/transport/MqttTransport';

export interface MqttEventBusBrokerConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  keepalive?: number;
  reconnectDelay?: number;
}

export interface MqttEventBusConfig {
  /** Identifiant de cette application (ex: "espdisplay") — utilisé dans le topic publié. */
  appId: string;
  /** Identité de cette machine (core.machineId) — utilisée dans le topic publié. */
  machineId: string;
  mqttConfig: MqttEventBusBrokerConfig;
  logger?: Logger;
}

const TOPIC_PREFIX = 'dimotic/supervisor';

/**
 * Extrait {machineId, appId, eventName} d'un topic
 * `dimotic/supervisor/{machineId}/app/{appId}/event/{eventName}`, ou `null` si le topic ne
 * correspond pas à ce format (défensif — un abonnement wildcard peut en théorie recevoir autre
 * chose si le namespace `dimotic/supervisor/` est un jour réutilisé pour autre chose).
 */
function parseEventTopic(topic: string): { machineId: string; appId: string; eventName: string } | null {
  const match = topic.match(/^dimotic\/supervisor\/([^/]+)\/app\/([^/]+)\/event\/(.+)$/);
  if (!match) return null;
  return { machineId: match[1] as string, appId: match[2] as string, eventName: match[3] as string };
}

export class MqttEventBus implements IEventBus<AppEvents> {
  private readonly appId: string;
  private readonly machineId: string;
  private readonly transport: MqttTransport;
  /** Un Set de listeners par nom d'événement — un seul abonnement MQTT par événement, jamais un
   *  wildcard générique `#` (voir fonctionnelles-supervisor_specs v2.4 §6.3, "abonnement précis
   *  par événement réellement écouté"). */
  private readonly listeners: Map<string, Set<(data: unknown) => void>> = new Map();
  /** Événements déjà souscrits côté MQTT (évite un `subscribe()` redondant à chaque nouveau listener). */
  private readonly subscribedEvents: Set<string> = new Set();

  constructor(config: MqttEventBusConfig) {
    this.appId = config.appId;
    this.machineId = config.machineId;

    this.transport = new MqttTransport(
      {
        host: config.mqttConfig.host,
        port: config.mqttConfig.port,
        clientId: `${this.appId}-eventbus-${this.machineId}`,
        username: config.mqttConfig.username ?? '',
        password: config.mqttConfig.password ?? '',
        keepalive: config.mqttConfig.keepalive ?? 60,
        reconnectDelay: config.mqttConfig.reconnectDelay ?? 5,
        willTopic: `${TOPIC_PREFIX}/${this.machineId}/app/${this.appId}/eventbus-status`
      },
      config.logger
    );
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.connect();
  }

  // ===========================================================================
  // IEventBus — événements typés (délèguent au mécanisme générique, voir EventBus.ts : le
  // préfixe optionnel de l'implémentation in-process n'est en pratique jamais utilisé dans ce
  // projet — grep confirmé, `new EventBus()` toujours appelé sans argument)
  // ===========================================================================

  emit<K extends keyof AppEvents>(event: K, data: AppEvents[K]): boolean {
    return this.emitGeneric(String(event), data);
  }

  on<K extends keyof AppEvents>(event: K, listener: (data: AppEvents[K]) => void): void {
    this.onGeneric(String(event), listener as (data: unknown) => void);
  }

  once<K extends keyof AppEvents>(event: K, listener: (data: AppEvents[K]) => void): void {
    this.onceGeneric(String(event), listener as (data: unknown) => void);
  }

  off<K extends keyof AppEvents>(event: K, listener: (data: AppEvents[K]) => void): void {
    this.offGeneric(String(event), listener as (data: unknown) => void);
  }

  removeAllListeners<K extends keyof AppEvents>(event: K): void {
    this.listeners.delete(String(event));
  }

  // ===========================================================================
  // IEventBus — événements génériques
  // ===========================================================================

  emitGeneric<D = unknown>(event: string, data: D): boolean {
    // ⭐ Livraison locale immédiate ET synchrone en plus de la publication MQTT — un process qui
    // émet un événement et écoute ce même événement sur SA PROPRE instance (pattern courant avec
    // EventEmitter, ex: un module qui déclenche puis réagit à son propre événement) doit se
    // comporter identiquement à EventBus.ts, où ça marche "gratuitement" puisque tout passe par le
    // même EventEmitter. Sans ce chemin local, un émetteur qui écoute son propre événement ne le
    // recevrait JAMAIS : le filtre anti-écho de handleMessage() rejette explicitement tout message
    // MQTT dont l'origine est cette même instance (machineId+appId), pour éviter une double
    // livraison — voir handleMessage().
    this.deliverLocally(event, data);
    const topic = this.buildPublishTopic(event);
    this.transport.publish(topic, JSON.stringify(data ?? null), 1, false);
    return true;
  }

  private deliverLocally(event: string, data: unknown): void {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners) return;
    for (const listener of eventListeners) {
      try {
        listener(data);
      } catch {
        // Comportement identique à EventBus.ts (EventEmitter) : une erreur dans un listener
        // n'interrompt jamais les autres.
      }
    }
  }

  onGeneric<D = unknown>(event: string, listener: (data: D) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as (data: unknown) => void);

    if (!this.subscribedEvents.has(event)) {
      this.subscribedEvents.add(event);
      this.transport.subscribe(this.buildSubscribeTopic(event), 1);
    }
  }

  offGeneric<D = unknown>(event: string, listener: (data: D) => void): void {
    this.listeners.get(event)?.delete(listener as (data: unknown) => void);
  }

  onceGeneric<D = unknown>(event: string, listener: (data: D) => void): void {
    const wrapper = (data: D): void => {
      this.offGeneric(event, wrapper);
      listener(data);
    };
    this.onGeneric(event, wrapper);
  }

  // ===========================================================================
  // Privé
  // ===========================================================================

  /** Utile pour les tests et pour un bootstrap (standalone.ts) qui voudrait attendre la connexion
   *  avant de se considérer "démarré" — pas strictement nécessaire en usage normal, `MqttTransport`
   *  met déjà en attente publications/abonnements jusqu'à la connexion. */
  isConnected(): boolean {
    return this.transport.getConnected();
  }

  private buildPublishTopic(event: string): string {
    return `${TOPIC_PREFIX}/${this.machineId}/app/${this.appId}/event/${event}`;
  }

  /** Wildcard sur machine ET app (n'importe quelle app, sur n'importe quelle machine, peut être à
   *  l'origine de l'événement — comme c'était implicitement le cas en in-process), jamais sur le
   *  nom d'événement lui-même : un abonnement par événement réellement écouté, pas un `#` générique. */
  private buildSubscribeTopic(event: string): string {
    return `${TOPIC_PREFIX}/+/app/+/event/${event}`;
  }

  private handleMessage(message: MqttMessage): void {
    const parsed = parseEventTopic(message.topic);
    if (!parsed) return;

    // ⚠️ Le broker redélivre à ce même client ses propres publications si elles matchent un
    // abonnement wildcard qu'il a lui-même posé (pas de "no local" en MQTT 3.1.1, protocole utilisé
    // ici) — déjà livré localement de façon synchrone dans emitGeneric() (voir deliverLocally()),
    // ignorer ici pour éviter une double livraison.
    if (parsed.machineId === this.machineId && parsed.appId === this.appId) return;

    const payloadString = Buffer.isBuffer(message.payload) ? message.payload.toString() : message.payload;
    let data: unknown;
    try {
      data = JSON.parse(payloadString);
    } catch {
      return;
    }

    this.deliverLocally(parsed.eventName, data);
  }
}
