/**
 * EsphomeService — orchestrateur de l'application ESPHOME (fonctionnelles-esphome_specs v1.2).
 *
 * ⭐ SQUELETTE (13/10/2026, étape 2 de la conception) : charge et recharge la configuration, publie l'état
 * (options actives, site, sites servis) à l'interface. Les connexions MQTT, la boucle de l'usine (compilation par
 * l'API Docker) et celle du poseur (envoi à l'ESP, déclaration dans HA) ne sont PAS encore écrites : le champ
 * `implementation` de l'état le dit explicitement à l'interface.
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { esphomeConfigSchema, type EsphomeConfig } from './config-schema';
import { ESPHOME_CLIENT_EVENTS, ESPHOME_SOCKET_EVENTS } from './socket-events';
import { creerLiaisons, fabriqueMqtt, type FabriqueTransport, type Liaisons } from './MqttSites';
import { jobSchema, poseSchema, topics, revisionAcceptee, type Job, type Pose } from './messages';
import type { Identite } from './presence';

export interface EsphomeStatus {
  site: string;
  adresseJoignable: string;
  usine: { actif: boolean; sitesServis: string[]; enRetrait: string | null; connexions: { site: string; connecte: boolean }[]; demandes: DemandeVue[] };
  poseur: { actif: boolean; enRetrait: string | null; connecte: boolean; poses: PoseVue[] };
  /** Avancement de la réalisation : 'squelette' tant que les boucles usine/poseur (traitement des demandes) ne sont pas écrites. */
  implementation: 'squelette';
}

/** Demande reçue (vue de l'interface) — la compilation n'est pas encore écrite : elle reste « en_attente ». */
export interface DemandeVue { site: string; appareil: string; revision: number; action: string; recueLe: string }
export interface PoseVue { appareil: string; revision: number; esp: string; recueLe: string }

export interface IEsphomeService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class EsphomeService implements IEsphomeService {
  private config: EsphomeConfig;
  private liaisons: Liaisons = {};
  private readonly demandes = new Map<string, DemandeVue>();
  private readonly poses = new Map<string, PoseVue>();
  /** Dernière révision traitée par appareil (une demande plus ancienne ou déjà traitée est ignorée). */
  private readonly revisions = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<EsphomeConfig>,
    private readonly fabrique: FabriqueTransport = fabriqueMqtt(logger),
    private readonly identite: Identite = {
      instance: process.env.DIMOTIC_MACHINE_ID || 'esphome',
      port: Number(process.env.DIMOTIC_WEB_PORT) || 8087
    }
  ) {
    this.config = this.loadConfig();
    this.setupEventListeners();
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<EsphomeConfig>, fabrique?: FabriqueTransport, identite?: Identite): EsphomeService {
    return new EsphomeService(eventBus, logger, configProvider, fabrique, identite);
  }

  private loadConfig(): EsphomeConfig {
    return esphomeConfigSchema.parse(this.configProvider.getAppConfig() as Partial<EsphomeConfig>);
  }

  private setupEventListeners(): void {
    this.eventBus.on(ESPHOME_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());
    // Process séparé : sa propre instance de ConfigService est distincte de celle du cœur qui a écrit le fichier,
    // d'où `reload()` AVANT de relire (même correctif que rpigpio/teleinfo).
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== 'esphome' || !event.success) return;
      this.configProvider.reload();
      try {
        this.config = this.loadConfig();
        this.logger.info('EsphomeService', 'Configuration rechargée — reconnexion des sites');
        this.arreterLiaisons();
        this.demarrerLiaisons();
      } catch (error) {
        this.logger.error('EsphomeService', `Configuration invalide, ancienne conservée : ${(error as Error).message}`);
        this.eventBus.emit(ESPHOME_SOCKET_EVENTS.ERROR, { message: `Configuration invalide : ${(error as Error).message}` });
      }
      this.emitStatus();
    });
  }

  async start(): Promise<void> {
    this.logger.info(
      'EsphomeService',
      `Démarrage (site ${this.config.site}) — usine ${this.config.usine.actif ? 'active' : 'inactive'}, poseur ${this.config.poseur.actif ? 'actif' : 'inactif'} — squelette : les demandes sont reçues et listées, pas encore traitées`
    );
    this.demarrerLiaisons();
    this.emitStatus();
  }

  async stop(): Promise<void> {
    this.arreterLiaisons();
    this.logger.info('EsphomeService', 'Arrêt');
  }

  // --- Liaisons MQTT -------------------------------------------------------------------------------------------

  private demarrerLiaisons(): void {
    this.liaisons = creerLiaisons(this.config, this.identite, this.fabrique);
    const { usine, poseur } = this.liaisons;

    if (usine) {
      for (const bus of usine.bus) {
        bus.abonner(
          topics.jobs(bus.site),
          jobSchema,
          (job) => this.surDemande(job),
          {
            vide: (topic) => this.surDemandeSupprimee(bus.site, topic),
            invalide: (topic, raison) => this.logger.warn('EsphomeService', `Demande invalide ignorée (${topic}) : ${raison}`)
          }
        );
        bus.surConnexion(() => {
          this.logger.info('EsphomeService', `Usine connectée au broker du site ${bus.site}`);
          // Laisser arriver la présence conservée d'un éventuel autre agent AVANT d'annoncer la nôtre.
          this.timers.push(setTimeout(() => usine.presence.annoncer(), 1500));
          this.emitStatus();
        });
      }
      usine.presence.surChangement((d) => {
        this.logger.info('EsphomeService', d.actif ? 'Usine : seul agent actif' : `Usine en retrait — ${d.raison}`);
        this.emitStatus();
      });
      usine.bus.forEach((b) => b.connecter());
    }

    if (poseur) {
      const bus = poseur.bus[0];
      bus.abonner(
        topics.poses(bus.site),
        poseSchema,
        (pose) => this.surPose(pose),
        {
          vide: (topic) => this.surPoseSupprimee(topic),
          invalide: (topic, raison) => this.logger.warn('EsphomeService', `Message de pose invalide ignoré (${topic}) : ${raison}`)
        }
      );
      bus.surConnexion(() => {
        this.logger.info('EsphomeService', `Poseur connecté au broker du site ${bus.site}`);
        this.timers.push(setTimeout(() => poseur.presence.annoncer(), 1500));
        this.emitStatus();
      });
      poseur.presence.surChangement((d) => {
        this.logger.info('EsphomeService', d.actif ? 'Poseur : seul agent actif' : `Poseur en retrait — ${d.raison}`);
        this.emitStatus();
      });
      bus.connecter();
    }
  }

  private arreterLiaisons(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    for (const role of [this.liaisons.usine, this.liaisons.poseur]) role?.bus.forEach((b) => b.deconnecter());
    this.liaisons = {};
    this.demandes.clear();
    this.poses.clear();
  }

  private surDemande(job: Job): void {
    if (this.liaisons.usine && !this.liaisons.usine.presence.etat.actif) {
      this.logger.info('EsphomeService', `Demande ${job.appareil}@${job.revision} (${job.site}) non traitée : usine en retrait`);
      return;
    }
    const cle = `${job.site}/${job.appareil}`;
    if (!revisionAcceptee(job.revision, this.revisions.get(cle))) {
      this.logger.info('EsphomeService', `Demande ${job.appareil}@${job.revision} ignorée : révision déjà traitée ou plus ancienne`);
      return;
    }
    this.demandes.set(cle, { site: job.site, appareil: job.appareil, revision: job.revision, action: job.action, recueLe: new Date().toISOString() });
    this.logger.info('EsphomeService', `Demande reçue : ${job.appareil}@${job.revision} (${job.action}, site ${job.site}) — traitement à venir`);
    this.emitStatus();
  }

  private surDemandeSupprimee(site: string, topic: string): void {
    const appareil = topic.split('/').pop() ?? '';
    if (this.demandes.delete(`${site}/${appareil}`)) {
      this.logger.info('EsphomeService', `Demande ${appareil} (${site}) annulée ou supprimée`);
      this.emitStatus();
    }
  }

  private surPose(pose: Pose): void {
    if (this.liaisons.poseur && !this.liaisons.poseur.presence.etat.actif) return;
    this.poses.set(pose.appareil, { appareil: pose.appareil, revision: pose.revision, esp: pose.esp, recueLe: new Date().toISOString() });
    this.logger.info('EsphomeService', `Pose reçue : ${pose.appareil}@${pose.revision} vers ${pose.esp} — traitement à venir`);
    this.emitStatus();
  }

  private surPoseSupprimee(topic: string): void {
    const appareil = topic.split('/').pop() ?? '';
    if (this.poses.delete(appareil)) this.emitStatus();
  }

  getStatus(): EsphomeStatus {
    const { usine, poseur } = this.liaisons;
    return {
      site: this.config.site,
      adresseJoignable: this.config.adresseJoignable,
      usine: {
        actif: this.config.usine.actif,
        sitesServis: this.config.usine.sites.map((s) => s.id),
        enRetrait: usine && !usine.presence.etat.actif ? usine.presence.etat.raison : null,
        connexions: (usine?.bus ?? []).map((b) => ({ site: b.site, connecte: b.connecte })),
        demandes: [...this.demandes.values()]
      },
      poseur: {
        actif: this.config.poseur.actif,
        enRetrait: poseur && !poseur.presence.etat.actif ? poseur.presence.etat.raison : null,
        connecte: poseur?.bus[0]?.connecte ?? false,
        poses: [...this.poses.values()]
      },
      implementation: 'squelette'
    };
  }

  private emitStatus(): void {
    this.eventBus.emit(ESPHOME_SOCKET_EVENTS.STATUS, this.getStatus());
  }
}
