/**
 * Module principal de l'application ESPHOME — scanné par AppService (détection automatique). Exporte :
 * ESPHOME_APP (ApplicationModule), createEsphomeService / createEsphomeServiceWithConfig (factories).
 *
 * ⚠️ Le nom du répertoire (esphome) DOIT correspondre à l'ID déclaré ici.
 *
 * Usine (compilation des firmwares ESPHome) et poseur (envoi à l'ESP, déclaration dans HA) — voir
 * `fonctionnelles-esphome_specs`. Application DÉSACTIVÉE à l'arrivée (cycle de vie des applications) : on
 * l'active depuis Gestion des applications, puis on coche les options `usine` et/ou `poseur` de cette machine.
 */

import {
  ApplicationModule,
  ModuleUiMetadata,
  IEventBus,
  Logger,
  IAppConfigProvider,
  ConfigService,
  AppConfigProvider
} from '../../../core/dist/exports';
import { ESPHOME_SOCKET_EVENTS, ESPHOME_ALL_EVENTS, ESPHOME_PERSISTENT_EVENTS } from './socket-events';
import { EsphomeService, IEsphomeService } from './EsphomeService';
import type { EsphomeConfig } from './config-schema';

export interface MenuEntry {
  id?: string;
  label: string;
  icon?: string;
  path: string;
  order: number;
  badge?: string;
  parentId?: string;
}

export interface ApplicationMenuConfig {
  category: string;
  section: string;
  entry: MenuEntry;
  pages?: MenuEntry[];
}

const brokerFields = (prefixe: string) => [
  { name: `${prefixe}.hote`, label: 'Hôte MQTT', type: 'text' as const, placeholder: '192.168.1.51' },
  { name: `${prefixe}.port`, label: 'Port MQTT', type: 'number' as const, default: 1883 },
  { name: `${prefixe}.utilisateur`, label: 'Utilisateur MQTT', type: 'text' as const },
  { name: `${prefixe}.motDePasse`, label: 'Mot de passe MQTT', type: 'password' as const }
];

export const ESPHOME_UI_METADATA: ModuleUiMetadata = {
  title: 'ESPHOME - usine et poseur de firmwares',
  description:
    "Compile les firmwares des appareils ESP (usine) et les envoie à l'ESP en les déclarant dans Home Assistant (poseur). Une seule application ; cochez l'option qui correspond à cette machine.",
  icon: '🏭',
  category: 'ESPHOME',
  menuLabel: 'ESPHome',
  menuIcon: '🏭',
  menuOrder: 26,
  menuPath: '/esphome/config',
  fields: [
    {
      title: 'Ce site',
      description: "Le site figure dans tous les sujets MQTT (les sites restent étanches). L'adresse joignable est celle de CETTE instance vue des autres sites (ex. 10.10.10.3:8087) ; vide = adresse locale.",
      icon: '📍',
      fields: [
        { name: 'site', label: 'Site', type: 'text', required: true, placeholder: 'stfort' },
        { name: 'adresseJoignable', label: 'Adresse joignable depuis les autres sites', type: 'text', placeholder: '10.10.10.3:8087' }
      ]
    },
    {
      title: 'Usine (compilation)',
      description: "À activer sur la machine qui héberge ESPHome (falbala) : récupère les sources, compile, crée les clés API.",
      icon: '🏭',
      fields: [
        { name: 'usine.actif', label: 'Usine active', type: 'boolean', default: false },
        { name: 'usine.esphome.conteneur', label: "Conteneur ESPHome", type: 'text', default: 'esphome' },
        { name: 'usine.esphome.dossierConfig', label: "Dossier de configuration d'ESPHome (vu par l'application)", type: 'text', default: '/esphome-config' },
        { name: 'usine.esphome.image', label: "Image ESPHome (version figée)", type: 'text', default: 'esphome/esphome:2025.11.2' },
        { name: 'usine.esphome.socketDocker', label: 'Socket Docker', type: 'text', default: '/var/run/docker.sock' },
        { name: 'usine.premierFlash.peripherique', label: 'Port USB du premier flash', type: 'text', default: '/dev/ttyUSB0' },
        { name: 'usine.premierFlash.reconnaissance', label: 'Reconnaître la carte avant de flasher', type: 'boolean', default: true },
        { name: 'usine.conservation.revisions', label: 'Révisions conservées par appareil', type: 'number', default: 5 },
        { name: 'usine.conservation.nettoyageJours', label: 'Nettoyage du cache après (jours sans compilation)', type: 'number', default: 30 },
        {
          name: 'usine.sites',
          label: 'Sites servis',
          type: 'array',
          itemLabel: 'Site',
          itemFields: [
            { name: 'id', label: 'Identifiant du site', type: 'text', required: true, placeholder: 'noisy' },
            ...brokerFields('mqtt')
          ]
        }
      ]
    },
    {
      title: 'Poseur (envoi à l\'ESP)',
      description: "À activer sur une machine toujours allumée de chaque site (ha2, noisy2) : envoie le firmware à l'ESP et déclare l'appareil dans le Home Assistant du site.",
      icon: '📡',
      fields: [
        { name: 'poseur.actif', label: 'Poseur actif', type: 'boolean', default: false },
        ...brokerFields('poseur.mqtt'),
        { name: 'poseur.tentatives.intervalleMinutes', label: 'Intervalle entre deux tentatives (minutes)', type: 'number', default: 5 },
        { name: 'poseur.tentatives.dureeMinutes', label: 'Durée maximale des tentatives (minutes)', type: 'number', default: 60 }
      ]
    }
  ]
};

export const ESPHOME_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'ESPHome',
  entry: { label: 'ESPHome', icon: '🏭', path: '/esphome/config', order: 26 },
  pages: [
    { id: 'tableau', label: 'Usine et poseur', icon: '🏭', path: '/applications/esphome/presentation/index.html', order: 1 }
  ]
};

export const ESPHOME_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'esphome',
  name: 'ESPHOME',
  description: "Usine (compilation des firmwares ESPHome) et poseur (envoi à l'ESP, déclaration dans Home Assistant) des appareils ESP assemblés par l'assembleur.",
  icon: '🏭',
  menu: ESPHOME_MENU_CONFIG,
  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'esphome',
  configUi: ESPHOME_UI_METADATA,
  socketEvents: ESPHOME_SOCKET_EVENTS,
  runsAsSeparateProcess: true
};

export function createEsphomeService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<EsphomeConfig>
): IEsphomeService {
  const service = EsphomeService.create(eventBus, logger, configProvider);

  eventBus.emit('app:socket-events:registered', {
    appId: 'esphome',
    socketEvents: ESPHOME_ALL_EVENTS,
    persistentEvents: ESPHOME_PERSISTENT_EVENTS
  });
  eventBus.emit('app:menu:register', { appId: 'esphome', menuConfig: ESPHOME_MENU_CONFIG });

  return service;
}

export function createEsphomeServiceWithConfig(eventBus: IEventBus, logger: Logger, configService: ConfigService): IEsphomeService {
  const configProvider = new AppConfigProvider<EsphomeConfig>('esphome' as any, configService);
  return createEsphomeService(eventBus, logger, configProvider);
}

export * from './EsphomeService';
export * from './config-schema';
export * from './socket-events';
export * from './messages';
export * from './presence';
export * from './bus';
export * from './AgentPresence';
export * from './MqttSites';
