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
  private readonly config: TeleinfoConfig;
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
        reconnectDelay: 5
      },
      this.logger
    );
    this.agentTransport.onMessage((message) => {
      const payloadString = Buffer.isBuffer(message.payload) ? message.payload.toString() : message.payload;
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
    this.agentTransport.connect();
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

    if (action === 'deploy' && this.compteurs.length !== 2) {
      this.eventBus.emit(TELEINFO_SOCKET_EVENTS.REMOTE_OP_RESULT, {
        targetId,
        action,
        success: false,
        error: `Exactement 2 compteurs doivent être déclarés avant de déployer (actuellement ${this.compteurs.length})`
      });
      return;
    }

    try {
      const result = await (action === 'deploy'
        ? this.deployService.deploy(target, generateAgentConfig(this.config, this.compteurs))
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
