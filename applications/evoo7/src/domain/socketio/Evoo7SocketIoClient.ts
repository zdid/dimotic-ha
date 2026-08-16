/**
 * Evoo7SocketIoClient
 *
 * Connexion Socket.IO DIRECTE au boîtier EVOO7 — remplace Evoo7MqttClient (16/08/2026, décision
 * utilisateur) : le boîtier parle nativement Socket.IO, l'ancien passage par un broker MQTT dédié
 * + traducteur externe (`zdidEVOO7mqtt`, ~2019) était une couche ajoutée, pas le protocole réel du
 * matériel — confirmé en conditions réelles avant d'écrire cette classe (voir TODO.md).
 *
 * ⚠️ `socket.io-client` doit être en v2.x précisément (voir package.json) — la v4 ne complète
 * jamais la poignée de main avec ce boîtier (erreur "server error", firmware trop ancien pour le
 * protocole Engine.IO v4 par défaut du client v4/v3).
 *
 * Protocole du boîtier (rétro-ingénierie du traducteur `zdidEVOO7mqtt/evoo7connecteur.js`) :
 * - Connexion : `socket.emit('identification', {user, passwd})` — passwd encodé en MD5, jamais en
 *   clair (voir `zdidEVOO7mqtt/appmean.js`, `md5(motdepasse)` avant stockage).
 * - Réception : `authorized`/`unauthorized` (résultat identification), `datas` (objet complet
 *   nom→valeur — reçu au moins une fois à la connexion, puis à nouveau pour chaque groupe de
 *   valeurs qui changent, pas nécessairement toutes les 43 à chaque fois).
 * - Envoi : `socket.emit('update', {name, value, echange})` — `echange` est un identifiant
 *   généré ici mais le boîtier ne le renvoie pas de façon exploitable dans sa réponse ;
 *   correlation faite ici par file d'attente (un seul update en vol à la fois, comme le faisait
 *   déjà le traducteur via `pause-queue`) plutôt que par l'identifiant.
 * - Confirmation : `updateok`/`updateko`, sans lien fiable vers la commande précise si plusieurs
 *   étaient en vol — d'où la file d'attente stricte.
 *
 * Couche : Infrastructure Socket.IO propre à l'application (miroir d'Evoo7MqttClient).
 */

import * as crypto from 'node:crypto';
import io = require('socket.io-client');
import type { Logger } from '../../../../core/dist/exports';
import type { Evoo7BoxConfig } from '../config-schema';

export type Evoo7DataCallback = (name: string, value: unknown) => void;

const UPDATE_TIMEOUT_MS = 10000;

interface QueuedUpdate {
  name: string;
  value: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class Evoo7SocketIoClient {
  private socket: SocketIOClient.Socket | null = null;
  private connected = false;
  private dataCallbacks: Evoo7DataCallback[] = [];
  private connectionCallbacks: ((connected: boolean) => void)[] = [];

  private updateQueue: QueuedUpdate[] = [];
  private updateInFlight: QueuedUpdate | null = null;
  private updateTimeout: NodeJS.Timeout | null = null;

  constructor(private readonly logger: Logger) {}

  connect(config: Evoo7BoxConfig): Promise<void> {
    const address = `http://${config.address}:${config.port}`;
    this.logger.info('Evoo7SocketIoClient', `Connexion à ${address}...`);

    const socket: SocketIOClient.Socket = io.connect(address, { reconnection: true, reconnectionDelay: 5000, timeout: 10000 });
    this.socket = socket;

    socket.on('datas', (data: Record<string, unknown>) => {
      for (const name in data) {
        for (const callback of this.dataCallbacks) callback(name, data[name]);
      }
    });

    socket.on('unauthorized', (message: unknown) => {
      this.logger.warn('Evoo7SocketIoClient', `Identification refusée par le boîtier EVOO7: ${JSON.stringify(message)}`);
    });

    socket.on('updateok', () => this.settleInFlightUpdate(null));
    socket.on('updateko', (message: unknown) => this.settleInFlightUpdate(new Error(`Commande EVOO7 refusée: ${JSON.stringify(message)}`)));

    socket.on('close', () => {
      this.connected = false;
      this.notifyConnectionChange();
    });
    socket.on('disconnect', () => {
      this.connected = false;
      this.notifyConnectionChange();
    });
    socket.on('error', (err: Error) => {
      this.logger.error('Evoo7SocketIoClient', `Erreur Socket.IO: ${err.message || err}`);
    });
    socket.on('reconnect_attempt', () => {
      this.logger.info('Evoo7SocketIoClient', 'Tentative de reconnexion au boîtier EVOO7...');
    });

    return new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error('Timeout de connexion au boîtier EVOO7'));
      }, 30000);

      socket.once('connect', () => {
        clearTimeout(connectTimeout);
        this.connected = true;
        this.logger.info('Evoo7SocketIoClient', 'Connecté au boîtier EVOO7, identification...');
        socket.emit('identification', {
          user: config.user,
          passwd: crypto.createHash('md5').update(config.password).digest('hex')
        });
        this.notifyConnectionChange();
        resolve();
      });

      socket.once('connect_error', (err: Error) => {
        clearTimeout(connectTimeout);
        reject(err);
      });
    });
  }

  disconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout);
        this.updateTimeout = null;
      }
      this.updateInFlight = null;
      this.updateQueue = [];
      if (!this.socket) {
        resolve();
        return;
      }
      this.socket.close();
      this.socket = null;
      this.connected = false;
      resolve();
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onData(callback: Evoo7DataCallback): void {
    this.dataCallbacks.push(callback);
  }

  onConnectionChange(callback: (connected: boolean) => void): void {
    this.connectionCallbacks.push(callback);
  }

  private notifyConnectionChange(): void {
    for (const callback of this.connectionCallbacks) callback(this.connected);
  }

  /**
   * Envoie une commande au boîtier — mise en file, une seule commande en vol à la fois (le
   * boîtier ne fournit aucun moyen fiable de corréler une réponse à une commande précise, voir
   * commentaire d'en-tête). Rejette après 10s sans réponse ou sur updateko.
   */
  sendUpdate(name: string, value: string): Promise<void> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('Client EVOO7 non connecté'));
    }
    return new Promise<void>((resolve, reject) => {
      this.updateQueue.push({ name, value, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.updateInFlight || this.updateQueue.length === 0 || !this.socket) return;

    const next = this.updateQueue.shift()!;
    this.updateInFlight = next;
    const echange = 'DOMOTIQUE' + Math.round(Math.random() * 100000000);
    this.logger.info('Evoo7SocketIoClient', `Envoi de la commande EVOO7: ${next.name} = ${next.value} (${echange})`);
    this.socket.emit('update', { name: next.name, value: next.value, echange });

    this.updateTimeout = setTimeout(() => {
      this.logger.warn('Evoo7SocketIoClient', `Pas de réponse du boîtier EVOO7 pour ${next.name} après ${UPDATE_TIMEOUT_MS}ms`);
      this.settleInFlightUpdate(new Error('Timeout de la commande EVOO7 — aucune réponse du boîtier'));
    }, UPDATE_TIMEOUT_MS);
  }

  private settleInFlightUpdate(error: Error | null): void {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
    const inFlight = this.updateInFlight;
    this.updateInFlight = null;
    if (!inFlight) {
      // updateok/updateko reçu sans commande en attente — pas anormal en soi (peut arriver après
      // un timeout déjà expiré côté client), simple traçabilité.
      this.logger.debug('Evoo7SocketIoClient', 'updateok/updateko reçu sans commande en attente');
    } else if (error) {
      inFlight.reject(error);
    } else {
      inFlight.resolve();
    }
    this.processQueue();
  }
}
