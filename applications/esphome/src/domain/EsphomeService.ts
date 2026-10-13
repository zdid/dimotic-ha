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

export interface EsphomeStatus {
  site: string;
  adresseJoignable: string;
  usine: { actif: boolean; sitesServis: string[] };
  poseur: { actif: boolean };
  /** Avancement de la réalisation : 'squelette' tant que les boucles usine/poseur ne sont pas écrites. */
  implementation: 'squelette';
}

export interface IEsphomeService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class EsphomeService implements IEsphomeService {
  private config: EsphomeConfig;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<EsphomeConfig>
  ) {
    this.config = this.loadConfig();
    this.setupEventListeners();
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<EsphomeConfig>): EsphomeService {
    return new EsphomeService(eventBus, logger, configProvider);
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
        this.logger.info('EsphomeService', 'Configuration rechargée');
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
      `Démarrage (site ${this.config.site}) — usine ${this.config.usine.actif ? 'active' : 'inactive'}, poseur ${this.config.poseur.actif ? 'actif' : 'inactif'} — squelette : aucune boucle encore écrite`
    );
    this.emitStatus();
  }

  async stop(): Promise<void> {
    this.logger.info('EsphomeService', 'Arrêt');
  }

  getStatus(): EsphomeStatus {
    return {
      site: this.config.site,
      adresseJoignable: this.config.adresseJoignable,
      usine: { actif: this.config.usine.actif, sitesServis: this.config.usine.sites.map((s) => s.id) },
      poseur: { actif: this.config.poseur.actif },
      implementation: 'squelette'
    };
  }

  private emitStatus(): void {
    this.eventBus.emit(ESPHOME_SOCKET_EVENTS.STATUS, this.getStatus());
  }
}
