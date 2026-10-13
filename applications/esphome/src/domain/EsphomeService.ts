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
import * as os from 'node:os';
import * as path from 'node:path';
import { FactoryService, type PublicationUsine, type ResultatTraitement } from './factory/FactoryService';
import { DockerApi } from './factory/DockerApi';
import { SecretsStore } from './factory/SecretsStore';
import type { Etat } from './messages';
import { InstallerService, type PublicationPoseur } from './installer/InstallerService';
import { HaDeclarer, type ClientHa } from './installer/HaDeclarer';
import { televerserOta } from './installer/OtaClient';
import { reconnaitre, juger, type Releve, type Verdict } from './factory/Reconnaissance';
import type { DockerClient } from './factory/DockerApi';

/** Traitement d'une demande par l'usine — injectable pour les tests. */
export interface TraiteurUsine {
  traiter(job: Job): Promise<ResultatTraitement>;
}
export type FabriqueTraiteur = (config: EsphomeConfig, identite: Identite, publication: PublicationUsine) => TraiteurUsine;
/** Traitement d'une pose par le poseur — injectable pour les tests. */
export interface TraiteurPoseur {
  traiter(pose: Pose): Promise<ResultatTraitement>;
}
export type FabriquePoseur = (config: EsphomeConfig, publication: PublicationPoseur) => TraiteurPoseur;

const ESSAIS_MAX = 3;
const DELAI_ESSAI_MS = 30_000;

export interface EsphomeStatus {
  site: string;
  adresseJoignable: string;
  usine: { actif: boolean; sitesServis: string[]; enRetrait: string | null; connexions: { site: string; connecte: boolean }[]; demandes: DemandeVue[] };
  poseur: { actif: boolean; enRetrait: string | null; connecte: boolean; poses: PoseVue[] };
  /** Avancement de la réalisation : 'squelette' tant que les boucles usine/poseur (traitement des demandes) ne sont pas écrites. */
  implementation: 'squelette';
}

/** Demande reçue (vue de l'interface) — la compilation n'est pas encore écrite : elle reste « en_attente ». */
export interface DemandeVue { site: string; appareil: string; revision: number; action: string; recueLe: string; etat: 'en_attente' | 'en_cours' | 'a_reessayer'; essais: number }
export interface PoseVue { appareil: string; revision: number; esp: string; recueLe: string; etat: 'en_attente' | 'en_cours' | 'a_reessayer'; essais: number }

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
  private traiteur: TraiteurUsine | null = null;
  private poseur: TraiteurPoseur | null = null;
  private filePoses: Pose[] = [];
  private enCoursPoseur = false;
  private readonly revisionsPoses = new Map<string, number>();
  private readonly revisionPoseCourante = new Map<string, number>();
  private file: Job[] = [];
  private enCours = false;
  private liaisonsActives = 0;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<EsphomeConfig>,
    private readonly fabrique: FabriqueTransport = fabriqueMqtt(logger),
    private readonly identite: Identite = {
      instance: process.env.DIMOTIC_MACHINE_ID || 'esphome',
      port: Number(process.env.DIMOTIC_WEB_PORT) || 8087
    },
    private readonly fabriqueTraiteur: FabriqueTraiteur = (c, i, p) => EsphomeService.traiteurReel(c, i, p, logger),
    private readonly clientHa?: ClientHa,
    private readonly fabriquePoseur: FabriquePoseur = (c, p) => EsphomeService.poseurReel(c, p, clientHa, logger)
  ) {
    this.config = this.loadConfig();
    this.setupEventListeners();
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<EsphomeConfig>, fabrique?: FabriqueTransport, identite?: Identite, fabriqueTraiteur?: FabriqueTraiteur, clientHa?: ClientHa, fabriquePoseur?: FabriquePoseur): EsphomeService {
    return new EsphomeService(eventBus, logger, configProvider, fabrique, identite, fabriqueTraiteur, clientHa, fabriquePoseur);
  }

  private static poseurReel(config: EsphomeConfig, publication: PublicationPoseur, clientHa: ClientHa | undefined, logger: Logger): TraiteurPoseur {
    if (!clientHa) throw new Error('liaison Home Assistant indisponible pour le poseur');
    return new InstallerService({
      telecharger: async (url) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      },
      ota: (o) => televerserOta({ ...o, surProgres: undefined }),
      ha: new HaDeclarer(clientHa),
      publication,
      motDePasseOta: config.poseur.motDePasseOta,
      attendre: (ms) => new Promise((r) => setTimeout(r, ms)),
      intervalleVerifMs: 10_000,
      delaiVerifMs: 180_000
    });
  }

  /** Adresse publique de l'instance vue des autres sites : celle de la configuration, sinon la première adresse IPv4 locale. */
  static adresseJoignable(config: EsphomeConfig, identite: Identite): string {
    if (config.adresseJoignable) return config.adresseJoignable;
    const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
    return `${ip}:${identite.port}`;
  }

  private static traiteurReel(config: EsphomeConfig, identite: Identite, publication: PublicationUsine, logger: Logger): TraiteurUsine {
    const u = config.usine;
    const racine = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'esphome', 'machine_partage');
    return new FactoryService({
      telecharger: async (url) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      },
      docker: new DockerApi(u.esphome.socketDocker),
      secrets: new SecretsStore(path.join(u.esphome.dossierConfig, 'secrets.yaml')),
      publication,
      dossierConfig: u.esphome.dossierConfig,
      cheminDansConteneur: u.esphome.cheminDansConteneur,
      conteneur: u.esphome.conteneur,
      partage: { dossier: racine, url: `http://${EsphomeService.adresseJoignable(config, identite)}/api/apps/esphome/partage` },
      revisionsGardees: u.conservation.revisions,
      surJournal: (m) => logger.debug('EsphomeService', m.trimEnd())
    });
  }

  private loadConfig(): EsphomeConfig {
    return esphomeConfigSchema.parse(this.configProvider.getAppConfig() as Partial<EsphomeConfig>);
  }

  private setupEventListeners(): void {
    this.eventBus.on(ESPHOME_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());
    this.eventBus.on(ESPHOME_CLIENT_EVENTS.CARTE_RECONNAITRE, () => void this.reconnaitreCarte());
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
    this.liaisonsActives++;
    this.traiteur = usine ? this.fabriqueTraiteur(this.config, this.identite, this.publicationUsine()) : null;
    this.poseur = null;
    if (poseur) {
      try {
        this.poseur = this.fabriquePoseur(this.config, this.publicationPoseur());
      } catch (e) {
        this.logger.error('EsphomeService', `Poseur indisponible : ${(e as Error).message}`);
      }
    }

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
    this.file = [];
    this.filePoses = [];
    this.traiteur = null;
    this.poseur = null;
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
    // Une demande plus récente remplace celle qui attend encore dans la file (pas celle en cours de traitement).
    this.file = this.file.filter((j) => !(j.site === job.site && j.appareil === job.appareil));
    this.file.push(job);
    this.demandes.set(cle, { site: job.site, appareil: job.appareil, revision: job.revision, action: job.action, recueLe: new Date().toISOString(), etat: 'en_attente', essais: 0 });
    this.logger.info('EsphomeService', `Demande reçue : ${job.appareil}@${job.revision} (${job.action}, site ${job.site})`);
    this.emitStatus();
    void this.traiterFile();
  }

  /** Une compilation à la fois, dans l'ordre d'arrivée. */
  private async traiterFile(): Promise<void> {
    if (this.enCours || !this.traiteur) return;
    this.enCours = true;
    try {
      let job: Job | undefined;
      while ((job = this.file.shift()) && this.traiteur) {
        const cle = `${job.site}/${job.appareil}`;
        const vue = this.demandes.get(cle);
        if (vue) { vue.etat = 'en_cours'; vue.essais++; this.emitStatus(); }
        this.revisionCourante.set(cle, job.revision);
        let resultat: ResultatTraitement;
        try {
          resultat = await this.traiteur.traiter(job);
        } catch (e) {
          this.logger.error('EsphomeService', `Traitement de ${job.appareil}@${job.revision} : erreur inattendue : ${(e as Error).message}`);
          resultat = 'echec';
        }
        if (resultat === 'a_reessayer' && vue && vue.essais < ESSAIS_MAX) {
          vue.etat = 'a_reessayer';
          const a = job;
          this.timers.push(setTimeout(() => { if (this.demandes.get(cle)?.revision === a.revision) { this.file.push(a); void this.traiterFile(); } }, DELAI_ESSAI_MS));
        } else {
          if (resultat === 'termine') this.revisions.set(cle, job.revision);
          this.demandes.delete(cle);
        }
        this.emitStatus();
      }
    } finally {
      this.enCours = false;
    }
  }

  private readonly revisionCourante = new Map<string, number>();

  /** Publication de l'usine sur le broker du site de la demande (sites étanches). */
  private publicationUsine(): PublicationUsine {
    const bus = (site: string) => this.liaisons.usine?.bus.find((b) => b.site === site);
    const maintenant = () => new Date().toISOString();
    return {
      statut: (site, appareil, etat: Etat, extra = {}) =>
        bus(site)?.publier(topics.status(site, appareil), { v: 1, site, appareil, revision: this.revisionCourante.get(`${site}/${appareil}`) ?? 0, at: maintenant(), etat, detail: '', ...extra }, true),
      pose: (site, appareil, pose) => bus(site)?.publier(topics.pose(site, appareil), { v: 1, at: maintenant(), ...pose }, true),
      supprimerDemande: (site, appareil) => bus(site)?.supprimer(topics.job(site, appareil))
    };
  }

  private surDemandeSupprimee(site: string, topic: string): void {
    const appareil = topic.split('/').pop() ?? '';
    this.file = this.file.filter((j) => !(j.site === site && j.appareil === appareil));
    if (this.demandes.delete(`${site}/${appareil}`)) {
      this.logger.info('EsphomeService', `Demande ${appareil} (${site}) annulée ou supprimée`);
      this.emitStatus();
    }
  }

  private surPose(pose: Pose): void {
    if (this.liaisons.poseur && !this.liaisons.poseur.presence.etat.actif) return;
    const cle = pose.appareil;
    if (!revisionAcceptee(pose.revision, this.revisionsPoses.get(cle))) {
      this.logger.info('EsphomeService', `Pose ${pose.appareil}@${pose.revision} ignorée : révision déjà traitée ou plus ancienne`);
      return;
    }
    this.filePoses = this.filePoses.filter((p) => p.appareil !== pose.appareil);
    this.filePoses.push(pose);
    this.poses.set(cle, { appareil: pose.appareil, revision: pose.revision, esp: pose.esp, recueLe: new Date().toISOString(), etat: 'en_attente', essais: 0 });
    this.logger.info('EsphomeService', `Pose reçue : ${pose.appareil}@${pose.revision} vers ${pose.esp}`);
    this.emitStatus();
    void this.traiterPoses();
  }

  /** Une pose à la fois ; ESP injoignable : nouvelle tentative toutes les `intervalleMinutes` pendant `dureeMinutes`. */
  private async traiterPoses(): Promise<void> {
    if (this.enCoursPoseur || !this.poseur) return;
    this.enCoursPoseur = true;
    try {
      let pose: Pose | undefined;
      while ((pose = this.filePoses.shift()) && this.poseur) {
        const vue = this.poses.get(pose.appareil);
        if (vue) { vue.etat = 'en_cours'; vue.essais++; this.emitStatus(); }
        this.revisionPoseCourante.set(pose.appareil, pose.revision);
        let resultat: ResultatTraitement;
        try {
          resultat = await this.poseur.traiter(pose);
        } catch (e) {
          this.logger.error('EsphomeService', `Pose de ${pose.appareil}@${pose.revision} : erreur inattendue : ${(e as Error).message}`);
          resultat = 'echec';
        }
        const t = this.config.poseur.tentatives;
        const essaisMax = Math.floor(t.dureeMinutes / t.intervalleMinutes) + 1;
        if (resultat === 'a_reessayer' && vue && vue.essais < essaisMax) {
          vue.etat = 'a_reessayer';
          const a = pose;
          this.timers.push(setTimeout(() => { if (this.poses.get(a.appareil)?.revision === a.revision) { this.filePoses.push(a); void this.traiterPoses(); } }, t.intervalleMinutes * 60_000));
        } else {
          if (resultat === 'termine') this.revisionsPoses.set(pose.appareil, pose.revision);
          else if (resultat === 'a_reessayer') this.logger.warn('EsphomeService', `Pose de ${pose.appareil}@${pose.revision} abandonnée après ${essaisMax} essais`);
          this.poses.delete(pose.appareil);
        }
        this.emitStatus();
      }
    } finally {
      this.enCoursPoseur = false;
    }
  }

  /** Publication du poseur sur le broker de SON site. */
  private publicationPoseur(): PublicationPoseur {
    const bus = () => this.liaisons.poseur?.bus[0];
    return {
      statut: (site, appareil, etat: Etat, extra = {}) =>
        bus()?.publier(topics.status(site, appareil), { v: 1, site, appareil, revision: this.revisionPoseCourante.get(appareil) ?? 0, at: new Date().toISOString(), etat, detail: '', ...extra }, true),
      supprimerPose: (site, appareil) => bus()?.supprimer(topics.pose(site, appareil))
    };
  }

  private surPoseSupprimee(topic: string): void {
    const appareil = topic.split('/').pop() ?? '';
    this.filePoses = this.filePoses.filter((p) => p.appareil !== appareil);
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

  /** Docker de l'usine, remplaçable par les tests. */
  dockerUsine: DockerClient | null = null;

  /**
   * Reconnaissance de la carte branchée sur la machine de l'usine (§5.4) : lecture seule. Les catalogues de modèles et
   * d'appareils viendront de l'assembleur (étape 3) ; en attendant le verdict compare à des listes vides.
   */
  async reconnaitreCarte(): Promise<{ releve: Releve; verdict: Verdict } | null> {
    const u = this.config.usine;
    if (!u.actif) {
      this.eventBus.emit(ESPHOME_SOCKET_EVENTS.ERROR, { message: "La reconnaissance d'une carte demande l'option « usine » active sur cette machine." });
      return null;
    }
    try {
      const docker = this.dockerUsine ?? new DockerApi(u.esphome.socketDocker);
      const releve = await reconnaitre(docker, u.esphome.conteneur, u.premierFlash.peripherique);
      const verdict = juger(releve, [], []);
      this.eventBus.emit(ESPHOME_SOCKET_EVENTS.CARTE_RELEVE, { releve, verdict, at: new Date().toISOString() });
      this.logger.info('EsphomeService', `Carte reconnue : ${releve.puceBrute}, flash ${releve.flash ?? '?'}, MAC ${releve.mac} — ${verdict.type}`);
      return { releve, verdict };
    } catch (e) {
      this.logger.warn('EsphomeService', `Reconnaissance de la carte : ${(e as Error).message}`);
      this.eventBus.emit(ESPHOME_SOCKET_EVENTS.ERROR, { message: (e as Error).message });
      return null;
    }
  }

  private emitStatus(): void {
    this.eventBus.emit(ESPHOME_SOCKET_EVENTS.STATUS, this.getStatus());
  }
}
