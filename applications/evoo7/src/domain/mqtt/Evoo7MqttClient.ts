/**
 * Evoo7MqttClient
 *
 * Connexion MQTT dédiée au broker EVOO7 (indépendante du broker HA géré par le socle) — mirroring
 * la connexion par source de NommageMqttIntegrationService. Écoute les topics Sensor des données
 * sélectionnées (consultation=true), publie sur le topic Commande unique d'EVOO7.
 *
 * Couche : Infrastructure MQTT propre à l'application.
 */

import * as mqtt from 'mqtt';
import type { Logger } from '../../../../core/dist/exports';
import type { Evoo7MqttConfig } from '../config-schema';

export type Evoo7MessageCallback = (topic: string, payload: string) => void;

export class Evoo7MqttClient {
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  private messageCallbacks: Evoo7MessageCallback[] = [];
  private connectionCallbacks: ((connected: boolean) => void)[] = [];
  private subscribedTopics: Set<string> = new Set();

  constructor(private readonly logger: Logger) {}

  connect(config: Evoo7MqttConfig): Promise<void> {
    const protocol = config.useTls ? 'mqtts' : 'mqtt';
    const brokerUrl = `${protocol}://${config.host}:${config.port}`;

    this.logger.info('Evoo7MqttClient', `Connexion au broker EVOO7 ${brokerUrl}...`);

    const options: mqtt.IClientOptions = {
      clientId: config.clientId,
      keepalive: config.keepalive,
      reconnectPeriod: config.reconnectPeriod,
      clean: config.cleanSession,
      username: config.username,
      password: config.password,
      rejectUnauthorized: config.rejectUnauthorized
    };

    const client = mqtt.connect(brokerUrl, options);
    this.client = client;

    client.on('message', (topic: string, payload: Buffer) => {
      const message = payload.toString('utf8');
      for (const callback of this.messageCallbacks) callback(topic, message);
    });

    client.on('close', () => {
      this.connected = false;
      this.notifyConnectionChange();
    });

    client.on('error', (err: Error) => {
      this.logger.error('Evoo7MqttClient', `Erreur MQTT: ${err.message}`);
    });

    client.on('reconnect', () => {
      this.logger.info('Evoo7MqttClient', 'Tentative de reconnexion au broker EVOO7...');
    });

    return new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error('Timeout de connexion au broker EVOO7'));
      }, 30000);

      client.once('connect', () => {
        clearTimeout(connectTimeout);
        this.connected = true;
        this.logger.info('Evoo7MqttClient', 'Connecté au broker EVOO7 avec succès');
        this.notifyConnectionChange();
        resolve();
      });

      client.once('error', (err) => {
        clearTimeout(connectTimeout);
        reject(err);
      });
    });
  }

  disconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.client) {
        resolve();
        return;
      }
      this.client.end(true, {}, () => {
        this.connected = false;
        this.subscribedTopics.clear();
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(callback: Evoo7MessageCallback): void {
    this.messageCallbacks.push(callback);
  }

  onConnectionChange(callback: (connected: boolean) => void): void {
    this.connectionCallbacks.push(callback);
  }

  private notifyConnectionChange(): void {
    for (const callback of this.connectionCallbacks) callback(this.connected);
  }

  subscribeTopic(topic: string, qos: 0 | 1 | 2 = 0): void {
    if (!this.client || this.subscribedTopics.has(topic)) return;
    this.client.subscribe(topic, { qos }, (err) => {
      if (err) {
        this.logger.error('Evoo7MqttClient', `Erreur d'abonnement à ${topic}: ${err.message}`);
        return;
      }
      this.subscribedTopics.add(topic);
      this.logger.debug('Evoo7MqttClient', `Abonné à ${topic}`);
    });
  }

  unsubscribeTopic(topic: string): void {
    if (!this.client || !this.subscribedTopics.has(topic)) return;
    this.client.unsubscribe(topic);
    this.subscribedTopics.delete(topic);
  }

  publish(topic: string, payload: string, qos: 0 | 1 | 2 = 0): void {
    if (!this.client || !this.connected) {
      // mqtt.js ne lève pas d'exception synchrone pour un publish sur un client déconnecté (il
      // met en file ou échoue silencieusement selon les options) — on rend l'échec explicite ici
      // plutôt que de laisser l'appelant croire que la commande est partie.
      throw new Error('Client EVOO7 non connecté');
    }
    this.client.publish(topic, payload, { qos });
  }
}
