// applications/core/src/application/IpcEventBus.ts
//
// Implémentation de IEventBus par IPC (process.send()/process.on('message')) plutôt que MQTT — pour
// une application migrée qui reste sur LA MÊME machine que core (spawn()'ée directement par
// ProcessSupervisor). Remplace MqttEventBus (16/08/2026, décision utilisateur) pour ce cas : l'IPC
// est un tuyau privé parent↔enfant, déjà présent gratuitement dès qu'un process est lancé avec
// `stdio: [..., 'ipc']`, sans dépendance à un broker MQTT/à ses identifiants pour ce canal.
//
// Contrairement à MQTT, l'IPC n'a pas de concept de topic ni de wildcard : chaque message envoyé
// arrive directement — et uniquement — au process en face (le parent, ou l'enfant, selon le sens).
// Toute la mécanique de parsing de topic / abonnement par nom / anti-écho self-origin de
// MqttEventBus disparaît : il n'y a qu'UN seul correspondant possible de chaque côté du tuyau.
//
// Utilisée côté ENFANT (dans chaque standalone.ts, via process.send/process.on('message')). Le
// pendant côté CORE (parent, un canal par enfant, diffusion à plusieurs enfants intéressés par un
// même nom d'événement) est SupervisorEventBridge — pas cette classe, dont l'API suppose un seul
// correspondant fixe.

import type { AppEvents } from '../types/events';
import type { IEventBus } from './IEventBus';

export interface IpcEnvelope {
  event: string;
  data: unknown;
}

export class IpcEventBus implements IEventBus<AppEvents> {
  private readonly listeners: Map<string, Set<(data: unknown) => void>> = new Map();

  constructor() {
    process.on('message', (message: IpcEnvelope) => this.handleMessage(message));
  }

  // ===========================================================================
  // IEventBus — événements typés (délèguent au mécanisme générique, comme EventBus.ts/MqttEventBus.ts)
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
    // Livraison locale immédiate ET synchrone en plus de l'envoi IPC — même raison que
    // MqttEventBus.emitGeneric() : un process qui émet et écoute son propre événement (pattern
    // EventEmitter courant) doit se comporter identiquement à EventBus.ts (in-process). Sans ce
    // chemin, un process qui écoute son propre événement ne le recevrait jamais — l'IPC ne
    // renvoie jamais à l'expéditeur ce qu'il vient d'envoyer.
    this.deliverLocally(event, data);
    if (process.send) {
      process.send({ event, data } satisfies IpcEnvelope);
    }
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

  private handleMessage(message: IpcEnvelope): void {
    if (!message || typeof message.event !== 'string') return;
    this.deliverLocally(message.event, message.data);
  }
}
