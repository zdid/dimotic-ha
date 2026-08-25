// applications/core/src/supervisor/SupervisorEventBridge.ts
//
// Pont bidirectionnel entre l'EventBus local (partagé par toutes les applications in-process, ex:
// HAPLAN) et les applications migrées en process séparé — conforme à fonctionnelles-supervisor_specs
// v2.5 §3/§6.3/§7.1, révisé le 16/08/2026 (décision utilisateur) : IPC (process.send()/'message',
// via ProcessSupervisor qui spawn() chaque app avec un canal `stdio: [...,'ipc']`) remplace MQTT
// pour ce pont — les apps migrées restent sur CETTE machine (spawn()'ées directement par `core`),
// aucun besoin de passer par un broker pour ce saut local. MQTT reste utilisé ailleurs (connexion
// HA de core, brokers dédiés propres à certaines apps comme evoo7) — seul CE pont change.
//
// Réception (app → core) : GÉNÉRIQUE par nature avec l'IPC — un canal `ChildProcess` est un tuyau
// point à point, tout ce qu'un enfant envoie via process.send() arrive forcément à ce pont via
// attachChild()'s handler `child.on('message', ...)`, sans abonnement ni nom à déclarer à l'avance
// (contrairement à MQTT, où il fallait un abonnement wildcard générique pour obtenir cette même
// propriété — voir l'historique dans TODO.md/CHANGELOG, ce pont a d'abord été construit sur MQTT).
//
// Émission (core → app) : reste ciblée par (appId, nom d'événement) — l'EventBus local est un
// simple EventEmitter, aucun concept de wildcard côté réception d'un abonnement local, et l'IPC
// n'a pas de diffusion native (un ChildProcess ne parle qu'à SON enfant) : bridgeEvent() route donc
// explicitement vers chaque app intéressée. Trois mécanismes réduisent le besoin de déclaration
// manuelle par app (voir AppService.detectApplicationModules()) : autoBridgeSocketEvents() (dérive
// les noms du payload d'app:socket-events:registered, déjà reçu automatiquement), les 4 motifs
// génériques émis par IntegrationBridge (`integration:{module}:command/bridge:connection/ha:online/
// passthrough:message`), et `app:module:config:saved`. `ApplicationModule.bridgedEvents` reste
// l'échappatoire pour un événement vraiment propre à une app (ex: espdisplay:deploy-floorplan).
//
// Respawn : un ChildProcess redémarré (backoff, ou start/stop manuel) est un NOUVEL objet, avec un
// NOUVEAU canal IPC — ProcessSupervisor doit rappeler attachChild() à chaque (re)spawn (detachChild()
// à la sortie). Contrairement à MQTT, aucune reconnexion automatique à gérer ici : le tuyau IPC est
// recréé par construction à chaque spawn(), rien à faire de plus.
//
// Anti-boucle STRUCTUREL (pas un flag sur le payload, qui fuirait dans les données métier) : un
// événement injecté localement suite à une réception IPC est marqué "en cours d'injection" dans un
// registre interne au pont ; le relais local→app vérifie ce registre avant de retransmettre et
// n'agit jamais sur un événement qu'il est lui-même en train d'injecter.

import type { ChildProcess } from 'node:child_process';
import type { IEventBus } from '../application/IEventBus';
import type { IpcEnvelope } from '../application/IpcEventBus';
import type { Logger } from '../infrastructure/logger/index';

export class SupervisorEventBridge {
  private readonly localEventBus: IEventBus;
  private readonly logger?: Logger;
  private readonly children: Map<string, ChildProcess> = new Map();
  /** Pour chaque nom d'événement ponté, l'ensemble des appId qui doivent le recevoir (sens
   *  core → app) — un ChildProcess ne diffuse qu'à SON enfant, il faut donc router explicitement
   *  vers chaque app intéressée plutôt que de compter sur une diffusion native. */
  private readonly interestedApps: Map<string, Set<string>> = new Map();
  private readonly localListenerAttached: Set<string> = new Set();
  /** Nom d'événement → appId d'origine, pour les injections app→local actuellement en cours
   *  (synchrone : posé juste avant emitGeneric() local, retiré juste après, la totalité des
   *  listeners synchrones se déclenchent entre les deux). ⭐ 25/08/2026, bug réel corrigé : c'était
   *  un simple Set<string> (nom d'événement seul) — le relais local→app ignorait ALORS TOUTE
   *  retransmission pendant l'injection, pas seulement le retour vers l'app d'origine. Résultat :
   *  un événement envoyé par l'app A et intéressant l'app B (ex: ia:tool:execute, A=ia, B=
   *  planificateur) n'atteignait jamais B — seul le cas "A intéressée par son propre événement"
   *  était le scénario prévu à l'origine, jamais celui-ci. Constaté en conditions réelles :
   *  ToolExecutor.ts timeout systématique sur ia:tool:execute:reply malgré planificateur qui
   *  répondait bien (vérifié en log) — le pont supprimait le relais avant même qu'il parte. */
  private readonly currentlyInjecting: Map<string, string> = new Map();
  private readonly socketEventsAutoBridged: Set<string> = new Set();

  constructor(localEventBus: IEventBus, logger?: Logger) {
    this.localEventBus = localEventBus;
    this.logger = logger;
  }

  /**
   * À appeler par ProcessSupervisor juste après spawn() (et à chaque respawn) — attache le canal
   * IPC de ce child au pont. Tout message envoyé par l'enfant (process.send() côté IpcEventBus)
   * est injecté sur le bus local, sans déclaration préalable (réception générique par nature).
   */
  attachChild(appId: string, child: ChildProcess): void {
    this.children.set(appId, child);
    child.on('message', (message: IpcEnvelope) => {
      if (!message || typeof message.event !== 'string') return;
      this.currentlyInjecting.set(message.event, appId);
      try {
        this.localEventBus.emitGeneric(message.event, message.data);
      } finally {
        this.currentlyInjecting.delete(message.event);
      }
    });
  }

  /** À appeler par ProcessSupervisor quand l'enfant sort (crash, arrêt volontaire) — le
   *  ChildProcess détaché ne recevra plus rien tant qu'attachChild() n'est pas rappelé au
   *  prochain spawn(). */
  detachChild(appId: string): void {
    this.children.delete(appId);
  }

  /**
   * Déclare un événement comme devant traverser la frontière process, sens core → app (core
   * publie localement, l'app séparée reçoit) — à appeler pour un événement vraiment propre à une
   * app (ex: espdisplay:deploy-floorplan) ou par les mécanismes génériques ci-dessous. Idempotent
   * par (appId, eventName) implicitement (interestedApps est un Set).
   */
  bridgeEvent(appId: string, eventName: string): void {
    const apps = this.interestedApps.get(eventName) ?? new Set<string>();
    apps.add(appId);
    this.interestedApps.set(eventName, apps);

    if (this.localListenerAttached.has(eventName)) return;
    this.localListenerAttached.add(eventName);

    this.localEventBus.onGeneric(eventName, (data) => {
      const originAppId = this.currentlyInjecting.get(eventName);
      for (const targetAppId of this.interestedApps.get(eventName) ?? []) {
        if (targetAppId === originAppId) continue; // écho de notre propre injection app→local
        this.children.get(targetAppId)?.send({ event: eventName, data } satisfies IpcEnvelope);
      }
    });

    this.logger?.debug('supervisor:bridge', `Événement ponté EventBus local → ${appId} (IPC) : ${eventName}`);
  }

  /**
   * Dès réception d'app:socket-events:registered pour CETTE app (déjà reçu automatiquement via
   * attachChild(), aucune déclaration nécessaire pour le recevoir), ponte chaque nom d'événement
   * présent dans son payload — remplace le besoin de recopier `Object.values(XXX_ALL_EVENTS)` dans
   * `bridgedEvents` de chaque app. Idempotent par appId.
   */
  autoBridgeSocketEvents(appId: string): void {
    if (this.socketEventsAutoBridged.has(appId)) return;
    this.socketEventsAutoBridged.add(appId);

    this.localEventBus.onGeneric('app:socket-events:registered', (data) => {
      const typed = data as { appId?: string; socketEvents?: Record<string, string> };
      if (typed.appId !== appId) return; // ne ponter que les événements de CETTE app
      for (const eventName of Object.values(typed.socketEvents ?? {})) {
        this.bridgeEvent(appId, eventName);
      }
    });
  }
}
