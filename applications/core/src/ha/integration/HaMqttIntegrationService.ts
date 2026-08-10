// =============================================================================
// HaMqttIntegrationService — Façade MQTT générique pour l'intégration HA
//
// Possède une connexion MQTT (MqttTransport) PAR bridge_instance (voir
// techniques-socle-ha-mqtt_specs v4.9 §8.5.1) et délègue la construction des
// messages aux modules purs discovery.ts / stateCommand.ts / passthrough.ts.
// =============================================================================

import { MqttTransport, type MqttMessage } from '../../infrastructure/transport/MqttTransport';
import { Logger } from '../../infrastructure/logger/index';
import { createMqttError } from '../../types/errors';
import { getBridgeStatusTopic, HA_STATUS_TOPIC } from './types/ha-mqtt';
import type { HaMqttDiscoveryEntity, HaMqttStateMessage } from './types/ha-mqtt';
import { buildDiscoveryPayload, publishDiscovery, publishAttributes, unpublishDiscovery, type EssentialEntityData } from './discovery';
import { publishState, subscribeCommands, parseIncomingCommand, type ParsedIncomingCommand } from './stateCommand';
import { publishDiscoveryPassthrough, publishPassthrough } from './passthrough';

/** Configuration réseau du broker unique du socle (voir techniques-socle-ha-mqtt_specs §7.1). */
export interface HaMqttBrokerConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  keepalive?: number;
  /** Délai de reconnexion en secondes (défaut : 5). */
  reconnectDelay?: number;
}

type CommandCallback = (event: ParsedIncomingCommand) => void;
type ConnectionCallback = (moduleName: string, bridgeInstance: string, connected: boolean) => void;
type HaOnlineCallback = (moduleName: string, bridgeInstance: string) => void;

function bridgeKey(moduleName: string, bridgeInstance: string): string {
  return `${moduleName}:${bridgeInstance}`;
}

export class HaMqttIntegrationService {
  private bridges: Map<string, MqttTransport> = new Map();
  private commandCallbacks: CommandCallback[] = [];
  private connectionCallbacks: ConnectionCallback[] = [];
  private haOnlineCallbacks: HaOnlineCallback[] = [];

  constructor(private readonly logger: Logger) {}

  /**
   * Connecte un nouveau bridge_instance. Une connexion MQTT dédiée est ouverte,
   * avec son propre LWT natif sur `/{moduleName}/{bridgeInstance}/status`.
   */
  async connectBridge(moduleName: string, bridgeInstance: string, broker: HaMqttBrokerConfig): Promise<void> {
    const key = bridgeKey(moduleName, bridgeInstance);
    if (this.bridges.has(key)) {
      this.logger.debug('ha:mqtt', `Bridge déjà connecté: ${key}`);
      return;
    }

    const transport = new MqttTransport(
      {
        host: broker.host,
        port: broker.port,
        clientId: `${moduleName}-${bridgeInstance}`,
        username: broker.username ?? '',
        password: broker.password ?? '',
        keepalive: broker.keepalive ?? 60,
        reconnectDelay: broker.reconnectDelay ?? 5,
        willTopic: getBridgeStatusTopic(moduleName, bridgeInstance),
      },
      this.logger
    );

    transport.onConnect(() => {
      this.logger.info('ha:mqtt', `Bridge connecté: ${key}`);
      this.notifyConnection(moduleName, bridgeInstance, true);
    });

    transport.onDisconnect((reason) => {
      this.logger.warn('ha:mqtt', `Bridge déconnecté: ${key} (${reason ?? 'raison inconnue'})`);
      this.notifyConnection(moduleName, bridgeInstance, false);
    });

    transport.onError((error) => {
      const appError = createMqttError('MQTT_CONNECTION_LOST', error.message, `ha:mqtt:${key}`, { host: broker.host, port: String(broker.port) });
      this.logger.error('ha:mqtt', `${appError.code} sur ${key}: ${appError.message}`);
    });

    transport.onMessage((message) => this.handleMessage(moduleName, bridgeInstance, message));

    this.bridges.set(key, transport);
    transport.connect();
    // ⭐ Second déclencheur de republication de découverte, indépendant de "notre bridge vient de
    // se connecter" — voir HA_STATUS_TOPIC. QoS 0 : un birth message manqué au tout premier
    // abonnement (course avec l'envoi du retained par le broker) n'est pas critique, le
    // déclencheur "bridge connection" existant reste le chemin principal.
    transport.subscribe(HA_STATUS_TOPIC, 0);
  }

  /**
   * Déconnecte un bridge_instance (fermeture propre, publie le LWT offline).
   */
  disconnectBridge(moduleName: string, bridgeInstance: string): void {
    const key = bridgeKey(moduleName, bridgeInstance);
    const transport = this.bridges.get(key);
    if (!transport) return;

    transport.disconnect();
    this.bridges.delete(key);
    this.logger.info('ha:mqtt', `Bridge déconnecté et retiré: ${key}`);
  }

  /**
   * Flip manuel du statut retained online/offline, sans fermer la connexion —
   * pour un module qui détecte lui-même la perte du matériel (ex: port série).
   */
  markBridgeStatus(moduleName: string, bridgeInstance: string, online: boolean): void {
    this.getBridgeOrWarn(moduleName, bridgeInstance)?.publishStatus(online);
  }

  isBridgeConnected(moduleName: string, bridgeInstance: string): boolean {
    return this.bridges.get(bridgeKey(moduleName, bridgeInstance))?.getConnected() ?? false;
  }

  /**
   * Publie une découverte à partir des données essentielles fournies par le module
   * (voir techniques-socle-ha-mqtt_specs §8.5.0 : cette méthode normalise le message complet).
   *
   * Une entité `commandEnabled` est automatiquement abonnée à son topic de commande —
   * sans ce couplage, aucun module ne recevait jamais les commandes HA→app en pratique,
   * `subscribeCommandsFor` n'étant appelé par aucun module métier.
   */
  publishDiscoveryFor(
    moduleName: string,
    bridgeInstance: string,
    component: string,
    objectId: string,
    deviceId: string,
    essential: EssentialEntityData
  ): void {
    const transport = this.getBridgeOrWarn(moduleName, bridgeInstance);
    if (!transport) return;

    const entity: HaMqttDiscoveryEntity = buildDiscoveryPayload(essential, {
      moduleName,
      bridgeInstance,
      deviceId,
      component,
      objectId,
    });
    publishDiscovery(transport, component, objectId, entity);

    if (essential.commandEnabled) {
      subscribeCommands(transport, moduleName, bridgeInstance, deviceId);
    }
  }

  /**
   * Publie la taxonomie d'une entité sur son topic d'attributs dédié — voir
   * discovery.ts::publishAttributes. À appeler uniquement à la (re)découverte.
   */
  publishAttributesFor(
    moduleName: string,
    bridgeInstance: string,
    component: string,
    objectId: string,
    attributsTaxonomie: Record<string, unknown>
  ): void {
    const transport = this.getBridgeOrWarn(moduleName, bridgeInstance);
    if (!transport) return;
    publishAttributes(transport, component, objectId, attributsTaxonomie);
  }

  /**
   * Retire une découverte déjà publiée (voir discovery.ts::unpublishDiscovery) — à utiliser quand
   * un module désélectionne une donnée/un device qui avait déjà été annoncé à HA.
   */
  removeDiscoveryFor(moduleName: string, bridgeInstance: string, component: string, objectId: string): void {
    const transport = this.getBridgeOrWarn(moduleName, bridgeInstance);
    if (!transport) return;
    unpublishDiscovery(transport, component, objectId);
  }

  publishState(moduleName: string, bridgeInstance: string, deviceId: string, state: HaMqttStateMessage): void {
    const transport = this.getBridgeOrWarn(moduleName, bridgeInstance);
    if (!transport) return;
    publishState(transport, moduleName, bridgeInstance, deviceId, state);
  }

  subscribeCommandsFor(moduleName: string, bridgeInstance: string, deviceId: string): void {
    const transport = this.getBridgeOrWarn(moduleName, bridgeInstance);
    if (!transport) return;
    subscribeCommands(transport, moduleName, bridgeInstance, deviceId);
  }

  publishDiscoveryPassthrough(moduleName: string, bridgeInstance: string, sourceTopic: string, payload: unknown): void {
    const transport = this.getBridgeOrWarn(moduleName, bridgeInstance);
    if (!transport) return;
    publishDiscoveryPassthrough(transport, sourceTopic, payload);
  }

  publishPassthrough(
    moduleName: string,
    bridgeInstance: string,
    topic: string,
    payload: unknown,
    qos?: 0 | 1,
    retain?: boolean
  ): void {
    const transport = this.getBridgeOrWarn(moduleName, bridgeInstance);
    if (!transport) return;
    publishPassthrough(transport, topic, payload, qos, retain);
  }

  onCommand(callback: CommandCallback): void {
    this.commandCallbacks.push(callback);
  }

  onConnectionChange(callback: ConnectionCallback): void {
    this.connectionCallbacks.push(callback);
  }

  /** ⭐ Notifié quand HA publie `online` sur HA_STATUS_TOPIC — voir ha-mqtt.ts pour le pourquoi. */
  onHaOnline(callback: HaOnlineCallback): void {
    this.haOnlineCallbacks.push(callback);
  }

  // ===========================================================================
  // Privé
  // ===========================================================================

  private handleMessage(moduleName: string, bridgeInstance: string, message: MqttMessage): void {
    if (message.topic === HA_STATUS_TOPIC) {
      if (message.payload.toString() === 'online') {
        this.logger.info('ha:mqtt', `HA en ligne (birth message) — republication de la découverte pour ${bridgeKey(moduleName, bridgeInstance)}`);
        for (const callback of this.haOnlineCallbacks) {
          try {
            callback(moduleName, bridgeInstance);
          } catch (error) {
            this.logger.error('ha:mqtt', `Erreur dans callback HA online: ${error}`);
          }
        }
      }
      return;
    }

    const parsed = parseIncomingCommand(message);
    if (!parsed) return;

    for (const callback of this.commandCallbacks) {
      try {
        callback(parsed);
      } catch (error) {
        this.logger.error('ha:mqtt', `Erreur dans callback de commande: ${error}`);
      }
    }
  }

  private notifyConnection(moduleName: string, bridgeInstance: string, connected: boolean): void {
    for (const callback of this.connectionCallbacks) {
      try {
        callback(moduleName, bridgeInstance, connected);
      } catch (error) {
        this.logger.error('ha:mqtt', `Erreur dans callback de connexion: ${error}`);
      }
    }
  }

  private getBridgeOrWarn(moduleName: string, bridgeInstance: string): MqttTransport | undefined {
    const key = bridgeKey(moduleName, bridgeInstance);
    const transport = this.bridges.get(key);
    if (!transport) {
      this.logger.warn('ha:mqtt', `Bridge non connecté: ${key}`);
    }
    return transport;
  }
}
