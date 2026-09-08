/**
 * TeleinfoService — orchestrateur de l'application TELEINFO.
 *
 * Rôle limité au paramétrage (mêmes principes que rpigpio, 12/08/2026) : stocke les 2 compteurs
 * (ADCO, QUOI/OÙ), génère le config.yaml de l'agent (generator.ts) et déploie l'agent + ce config
 * sur le RPi1 cible (DeployService, SSH + systemd — pas de Docker, voir config-schema.ts).
 *
 * ⭐ 16/08/2026 : seule connexion MQTT de ce service — en LECTURE SEULE, uniquement pour suivre la
 * présence de l'agent RPi1 distant (LWT + battement de cœur ajoutés côté agent, voir
 * device-agent/ha-publisher.js, topic `teleinfo/agent/status`, payload JSON {status, timestamp}).
 */

import * as path from 'node:path';
import type { IEventBus, Logger, IAppConfigProvider, RemoteAction } from '../../../core/dist/exports';
import { MqttTransport, isRunningInDocker, ensureGlobalSshKey } from '../../../core/dist/exports';
import { teleinfoConfigSchema, type TeleinfoConfig } from './config-schema';
import { compteursConfigSchema, DEFAULT_COMPTEURS_CONFIG, type CompteurDefinition, type CompteursConfigFile } from './storage-schema';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { generateAgentConfig } from './generator';
import { DeployService } from './DeployService';
import { TELEINFO_SOCKET_EVENTS, TELEINFO_CLIENT_EVENTS } from './socket-events';

const AGENT_PRESENCE_TOPIC = 'teleinfo/agent/status';
// ⭐ 05/09/2026 — voir device-agent/ha-publisher.js::publishDiscovered. Un segment par ADCO
// (retenu), pas un blob unique : chaque ADCO reste indépendamment rejouable/idempotent si l'agent
// redémarre, et un abonnement générique (+) couvre tout ADCO même pas encore vu à l'écriture de ce
// code.
const AGENT_DISCOVERED_TOPIC_FILTER = 'teleinfo/agent/discovered/+';
const AGENT_DISCOVERED_TOPIC_PREFIX = 'teleinfo/agent/discovered/';

export interface TeleinfoStatus {
  compteursCount: number;
  targets: { id: string; host: string; serviceName: string }[];
  /** true si CETTE instance tourne dans un conteneur Docker — voir core/infrastructure/runtime/docker.ts.
   *  Affecte le texte de préparation SSH affiché par cible (TargetCards.js). */
  isRunningInDocker: boolean;
  /** Racine réelle du projet (process.env.PROJECT_ROOT) — utilisée pour le `cd` préalable à
   *  ssh-copy-id hors Docker sur la page Déploiement (TargetCards.js, ⭐ 24/08/2026). */
  projectRoot: string;
  /** Présence de l'agent RPi1 distant — null tant qu'aucun message n'a encore été reçu. */
  agentOnline: boolean | null;
  /** Horodatage ISO de la dernière fois qu'un message de présence a été reçu (quel que soit son
   *  contenu) — permet d'afficher "dernier contact" même si l'agent est actuellement hors ligne. */
  agentLastSeenAt: string | null;
}

export interface ITeleinfoService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type SaveCompteurInput = CompteurDefinition & { originalAdco?: number };

export class TeleinfoService implements ITeleinfoService {
  private config: TeleinfoConfig;
  private readonly compteursManager: ConfigFileManager<CompteursConfigFile>;
  private compteurs: CompteurDefinition[];
  private readonly deployService: DeployService;
  private agentTransport: MqttTransport | null = null;
  private agentOnline: boolean | null = null;
  private agentLastSeenAt: string | null = null;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<TeleinfoConfig>
  ) {
    this.config = teleinfoConfigSchema.parse(configProvider.getAppConfig());

    const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'teleinfo');
    this.compteursManager = new ConfigFileManager<CompteursConfigFile>(
      path.join(dataDir, 'teleinfo-compteurs-v1.0.yaml'),
      compteursConfigSchema,
      DEFAULT_COMPTEURS_CONFIG,
      this.logger,
      'compteurs'
    );
    this.compteurs = this.compteursManager.load().compteurs;

    this.deployService = new DeployService(this.logger);

    this.setupEventListeners();
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<TeleinfoConfig>): TeleinfoService {
    return new TeleinfoService(eventBus, logger, configProvider);
  }

  private setupEventListeners(): void {
    this.eventBus.on(TELEINFO_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());
    this.eventBus.on(TELEINFO_CLIENT_EVENTS.GET_COMPTEURS, () => this.emitCompteurs());
    this.eventBus.on(TELEINFO_CLIENT_EVENTS.SAVE_COMPTEUR, (data: unknown) => this.handleSaveCompteur(data as SaveCompteurInput));
    this.eventBus.on(TELEINFO_CLIENT_EVENTS.DELETE_COMPTEUR, (data: unknown) => this.handleDeleteCompteur(data as { adco: number }));
    this.eventBus.on(TELEINFO_CLIENT_EVENTS.REMOTE_OP, (data: unknown) => {
      const { targetId, action } = data as { targetId: string; action: RemoteAction };
      this.handleRemoteOp(targetId, action);
    });

    // ⭐ 05/09/2026, même bug réel que arexx (corrigé le 25/08/2026, jamais propagé ici bien que
    // "même patron") : this.config n'était chargé qu'une fois, au démarrage du service — une cible
    // ou un réglage MQTT modifié depuis Paramètres Techniques était bien écrit sur disque, jamais
    // relu ici. teleinfo:status continuait de renvoyer targets:[] jusqu'au prochain redémarrage
    // (ou un rafraîchissement de page qui, en réalité, ne changeait rien côté serveur — la
    // coïncidence d'un second GET arrivant après un éventuel redémarrage ailleurs masquait la
    // vraie cause). Recharge simple, pas de reconnexion MQTT ici (lecture seule, présence agent).
    //
    // ⭐ `configProvider.reload()` AVANT `getAppConfig()` — indispensable : ce process séparé a sa
    // PROPRE instance ConfigService (voir standalone.ts), en mémoire depuis son propre démarrage,
    // distincte de celle de core qui a écrit le fichier. `getAppConfig()` seul relit cette instance
    // en mémoire, pas le fichier — sans reload() explicite, on obtient encore l'ancienne valeur
    // malgré le nom de la méthode (piège trouvé en testant ce correctif en conditions réelles :
    // `teleinfo:status` republiait bien tout seul après sauvegarde, mais avec l'hôte resté ancien).
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== 'teleinfo' || !event.success) return;
      this.configProvider.reload();
      this.config = teleinfoConfigSchema.parse(this.configProvider.getAppConfig());
      this.emitStatus();
    });
  }

  async start(): Promise<void> {
    this.logger.info('TeleinfoService', 'Démarrage du service teleinfo...');
    ensureGlobalSshKey();
    this.connectAgentPresence();
    this.emitStatus();
    this.emitCompteurs();
    this.logger.info('TeleinfoService', 'Service teleinfo démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('TeleinfoService', 'Arrêt du service teleinfo');
    this.agentTransport?.disconnect();
    this.agentTransport = null;
  }

  // ==========================================================================
  // Présence de l'agent RPi1 distant (LWT + battement de cœur côté agent, lecture seule ici)
  // ==========================================================================

  private connectAgentPresence(): void {
    this.agentTransport = new MqttTransport(
      {
        host: this.config.mqtt.host,
        port: this.config.mqtt.port,
        clientId: `teleinfo-presence-${this.config.targets[0]?.host || 'none'}`,
        username: this.config.mqtt.user || '',
        password: this.config.mqtt.password || '',
        keepalive: 60,
        reconnectDelay: 5,
        protocolVersion: 5
      },
      this.logger
    );
    this.agentTransport.onMessage((message) => {
      const payloadString = Buffer.isBuffer(message.payload) ? message.payload.toString() : message.payload;

      if (message.topic.startsWith(AGENT_DISCOVERED_TOPIC_PREFIX)) {
        this.handleDiscoveredAdco(payloadString);
        return;
      }

      let parsed: { status?: string } | null = null;
      try {
        parsed = JSON.parse(payloadString);
      } catch {
        this.logger.warn('TeleinfoService', `Message de présence agent illisible: ${payloadString}`);
        return;
      }
      this.agentOnline = parsed?.status === 'online';
      this.agentLastSeenAt = new Date().toISOString();
      this.logger.debug('TeleinfoService', `Présence agent RPi1: ${parsed?.status} (${AGENT_PRESENCE_TOPIC})`);
      this.emitStatus();
    });
    this.agentTransport.subscribe(AGENT_PRESENCE_TOPIC, 1);
    this.agentTransport.subscribe(AGENT_DISCOVERED_TOPIC_FILTER, 1);
    this.agentTransport.connect();
  }

  /**
   * ⭐ 05/09/2026 (demande utilisateur) — un ADCO lu par l'agent mais pas encore déclaré crée
   * automatiquement l'entrée compteur correspondante (quoi/lieu provisoires, "à identifier" —
   * modifiable ensuite via le formulaire existant, comme n'importe quel compteur). Pas d'action si
   * cet ADCO est déjà connu (relecture d'un message retenu après redémarrage de l'agent, ou trame
   * répétée) ou si les 2 emplacements physiques sont déjà occupés — même limite que
   * handleSaveCompteur, réutilisé tel quel pour ne pas dupliquer la logique de sauvegarde.
   */
  private handleDiscoveredAdco(payloadString: string): void {
    let parsed: { adco?: number } | null = null;
    try {
      parsed = JSON.parse(payloadString);
    } catch {
      this.logger.warn('TeleinfoService', `Message de découverte agent illisible: ${payloadString}`);
      return;
    }
    const adco = parsed?.adco;
    if (typeof adco !== 'number') return;
    if (this.compteurs.some((c) => c.adco === adco)) return;
    if (this.compteurs.length >= 2) {
      this.logger.warn('TeleinfoService', `ADCO ${adco} découvert mais 2 compteurs déjà déclarés — ignoré`);
      return;
    }

    this.logger.info('TeleinfoService', `ADCO ${adco} découvert sur l'agent RPi1 — création automatique de l'entrée compteur`);
    this.handleSaveCompteur({ adco, quoi: 'compteur', lieu: 'a-identifier' });
  }

  // ==========================================================================
  // Compteurs — CRUD (au plus 2, contrainte physique de la bascule GPIO)
  // ==========================================================================

  private handleSaveCompteur(input: SaveCompteurInput): void {
    try {
      const { originalAdco, ...compteur } = input;
      const existingIndex = this.compteurs.findIndex((c) => c.adco === (originalAdco ?? compteur.adco));

      if (existingIndex === -1 && this.compteurs.length >= 2) {
        this.emitError('2 compteurs déjà déclarés — la bascule GPIO ne gère que 2 positions. Supprime-en un avant d\'en ajouter un autre.');
        return;
      }

      if (existingIndex === -1) {
        this.compteurs.push(compteur);
      } else {
        this.compteurs[existingIndex] = compteur;
      }

      const result = this.compteursManager.save({ compteurs: this.compteurs });
      if (!result.success) {
        this.emitError(`Échec de sauvegarde: ${result.error}`);
        return;
      }

      this.eventBus.emit(TELEINFO_SOCKET_EVENTS.COMPTEUR_SAVED, compteur);
      this.emitCompteurs();
      this.emitStatus();
    } catch (error) {
      this.emitError(`Erreur de sauvegarde du compteur: ${error instanceof Error ? error.message : error}`);
    }
  }

  private handleDeleteCompteur(data: { adco: number }): void {
    const before = this.compteurs.length;
    this.compteurs = this.compteurs.filter((c) => c.adco !== data.adco);
    if (this.compteurs.length === before) {
      this.emitError(`Compteur introuvable: ${data.adco}`);
      return;
    }

    const result = this.compteursManager.save({ compteurs: this.compteurs });
    if (!result.success) {
      this.emitError(`Échec de suppression: ${result.error}`);
      return;
    }

    this.eventBus.emit(TELEINFO_SOCKET_EVENTS.COMPTEUR_DELETED, { adco: data.adco });
    this.emitCompteurs();
    this.emitStatus();
  }

  // ==========================================================================
  // Déploiement
  // ==========================================================================

  /**
   * Point d'entrée unique pour toute intervention distante (protocole uniforme partagé avec
   * rpigpio/arexx, 22-23/08/2026) — une cible précise est toujours désignée par son `targetId`
   * (⭐ multi-cible 23/08/2026 : `teleinfo` ne dépasse jamais 1 cible en pratique, mais le schéma
   * et le protocole restent identiques aux autres apps).
   */
  private async handleRemoteOp(targetId: string, action: RemoteAction): Promise<void> {
    const target = this.config.targets.find((t) => t.id === targetId);
    if (!target) {
      this.eventBus.emit(TELEINFO_SOCKET_EVENTS.REMOTE_OP_RESULT, {
        targetId,
        action,
        success: false,
        error: `Cible introuvable: ${targetId}`
      });
      return;
    }

    // ⭐ 05/09/2026 (demande utilisateur) — le déploiement n'exige plus les 2 compteurs déclarés à
    // l'avance : "il faut envoyer le package, surveiller la lecture des 2 compteurs, et la machine
    // distante doit répondre si possible avec la valeur de chaque numéro de compteur". Déployer avec
    // 0/1 compteur lance quand même l'agent (device-agent/main.js accepte désormais 0-2, voir son
    // en-tête) — tout ADCO lu mais non déclaré est publié sur teleinfo/agent/discovered/<adco>,
    // repris ci-dessous (handleDiscoveredAdco) pour créer automatiquement l'entrée compteur
    // correspondante. Seul le maximum physique (2, bascule GPIO à 2 positions) reste bloquant.
    if (action === 'deploy' && this.compteurs.length > 2) {
      this.eventBus.emit(TELEINFO_SOCKET_EVENTS.REMOTE_OP_RESULT, {
        targetId,
        action,
        success: false,
        error: `Au plus 2 compteurs (bascule GPIO à 2 positions) — actuellement ${this.compteurs.length}`
      });
      return;
    }

    try {
      const result = await (action === 'deploy'
        ? this.deployService.deploy(target, generateAgentConfig(this.config, this.compteurs), (chunk) => {
            this.eventBus.emit(TELEINFO_SOCKET_EVENTS.REMOTE_OP_PROGRESS, { targetId, chunk });
          })
        : action === 'start'
        ? this.deployService.start(target)
        : action === 'stop'
        ? this.deployService.stop(target)
        : action === 'restart'
        ? this.deployService.restart(target)
        : Promise.resolve({ success: false, error: `Action distante inconnue: ${action}` }));
      this.eventBus.emit(TELEINFO_SOCKET_EVENTS.REMOTE_OP_RESULT, { targetId, action, ...result });
    } catch (error) {
      this.eventBus.emit(TELEINFO_SOCKET_EVENTS.REMOTE_OP_RESULT, {
        targetId,
        action,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // ==========================================================================
  // Émission des événements
  // ==========================================================================

  private emitCompteurs(): void {
    this.eventBus.emit(TELEINFO_SOCKET_EVENTS.COMPTEURS_LIST, this.compteurs);
  }

  private emitStatus(): void {
    const status: TeleinfoStatus = {
      compteursCount: this.compteurs.length,
      targets: this.config.targets.map((t) => ({ id: t.id, host: t.host, serviceName: t.serviceName })),
      isRunningInDocker: isRunningInDocker(),
      projectRoot: process.env.PROJECT_ROOT || process.cwd(),
      agentOnline: this.agentOnline,
      agentLastSeenAt: this.agentLastSeenAt
    };
    this.eventBus.emit(TELEINFO_SOCKET_EVENTS.STATUS, status);
  }

  private emitError(message: string): void {
    this.logger.error('TeleinfoService', message);
    this.eventBus.emit(TELEINFO_SOCKET_EVENTS.ERROR, { message });
  }
}
