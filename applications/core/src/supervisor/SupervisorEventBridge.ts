// applications/core/src/supervisor/SupervisorEventBridge.ts
//
// Pont bidirectionnel entre l'EventBus local (partagé par toutes les applications in-process, ex:
// HAPLAN) et MQTT (pour une application migrée en process séparé, ex: espdisplay) — conforme à
// fonctionnelles-supervisor_specs v2.4 §3/§6.3. Ne relaie qu'un ensemble déclaré d'événements par
// application migrée (jamais un relais générique "tout ce qui passe sur le bus local"), même
// principe que SocketBridge.registerAppSocketEvents() : la liste vient de ce que l'application
// migrée déclare (ApplicationModule.bridgedEvents, ex: ESPDISPLAY_APP — espdisplay n'a pas de
// socketEvents Socket.io propres, ces deux événements ne transitaient jusqu'ici qu'en interne
// entre HAPLAN et EspDisplayService), plus `app:menu:register` toujours ajouté automatiquement
// (voir AppService.detectApplicationModules()).
//
// Anti-boucle STRUCTUREL (pas un flag sur le payload, qui fuirait dans les données métier) : un
// événement injecté localement suite à une réception MQTT est marqué "en cours d'injection" dans un
// registre interne au pont ; le relais local→MQTT vérifie ce registre avant de republier et
// n'agit jamais sur un événement qu'il est lui-même en train d'injecter.

import type { IEventBus } from '../application/IEventBus';
import { MqttEventBus, type MqttEventBusBrokerConfig } from '../application/MqttEventBus';
import type { Logger } from '../infrastructure/logger/index';

export interface SupervisorEventBridgeConfig {
  machineId: string;
  mqttConfig: MqttEventBusBrokerConfig;
  logger?: Logger;
}

export class SupervisorEventBridge {
  private readonly localEventBus: IEventBus;
  private readonly mqttBus: MqttEventBus;
  private readonly logger?: Logger;
  /** Noms d'événements actuellement en cours d'injection MQTT→local — le relais local→MQTT les
   *  ignore pendant ce temps (synchrone : posé juste avant emitGeneric() local, retiré juste
   *  après, la totalité des listeners synchrones se déclenchent entre les deux). */
  private readonly currentlyInjecting: Set<string> = new Set();
  private readonly bridgedEvents: Set<string> = new Set();

  constructor(localEventBus: IEventBus, config: SupervisorEventBridgeConfig) {
    this.localEventBus = localEventBus;
    this.logger = config.logger;
    this.mqttBus = new MqttEventBus({
      appId: 'core',
      machineId: config.machineId,
      mqttConfig: config.mqttConfig,
      logger: config.logger
    });
  }

  /**
   * Déclare un événement comme devant traverser la frontière process — à appeler pour chaque
   * événement d'une application migrée (voir AppService.detectApplicationModules(), qui connaît
   * déjà `appModule.socketEvents` au moment où `runsAsSeparateProcess` est détecté).
   */
  bridgeEvent(eventName: string): void {
    if (this.bridgedEvents.has(eventName)) return;
    this.bridgedEvents.add(eventName);

    // Local → MQTT
    this.localEventBus.onGeneric(eventName, (data) => {
      if (this.currentlyInjecting.has(eventName)) return; // écho de notre propre injection MQTT→local
      this.mqttBus.emitGeneric(eventName, data);
    });

    // MQTT → Local
    this.mqttBus.onGeneric(eventName, (data) => {
      this.currentlyInjecting.add(eventName);
      try {
        this.localEventBus.emitGeneric(eventName, data);
      } finally {
        this.currentlyInjecting.delete(eventName);
      }
    });

    this.logger?.debug('supervisor:bridge', `Événement ponté EventBus local ↔ MQTT : ${eventName}`);
  }
}
