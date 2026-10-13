/**
 * Module principal de l'application ESPS-ASSEMBLE (assembleur de sources ESPHome ; ex-« espdisplay », renommée le 14/10/2026).
 *
 * Scanné par AppService (détection automatique). Exporte : ESPS_ASSEMBLE_APP (ApplicationModule), createAssembleurService /
 * createAssembleurServiceWithConfig (factories). ⚠️ Le nom du répertoire (esps-assemble) DOIT correspondre à l'ID déclaré ici.
 *
 * Application DÉSACTIVÉE à l'arrivée (cycle de vie des applications) : on l'active depuis Gestion des applications. Elle remplace
 * `espdisplay` (ancien pipeline SSH vers la machine ESPHome, abandonné au profit de l'usine de l'application `esphome`).
 */

import type { ApplicationModule, ModuleUiMetadata, IEventBus, Logger, IAppConfigProvider, ConfigService } from '../../../core/dist/exports';
import { AppConfigProvider } from '../../../core/dist/exports';
import { AssembleurService, type IAssembleurService } from './AssembleurService';
import type { AssembleurConfig } from './config-schema';
import type { ClientHa } from './plans/source-ha';
import { ASSEMBLEUR_SOCKET_EVENTS, ASSEMBLEUR_ALL_EVENTS, ASSEMBLEUR_PERSISTENT_EVENTS } from './socket-events';

export interface MenuEntry { id?: string; label: string; icon?: string; path: string; order: number; badge?: string; parentId?: string }
export interface ApplicationMenuConfig { category: string; section: string; entry: MenuEntry; pages?: MenuEntry[] }

export const ESPS_ASSEMBLE_UI_METADATA: ModuleUiMetadata = {
  title: 'ESPS-ASSEMBLE - Assembleur de sources ESPHome',
  description:
    "Assemble les appareils ESP (matériel + éléments de la bibliothèque) en paquets et demande leur fabrication à l'usine (application ESPHome) par MQTT. Ne compile rien.",
  icon: '🧩',
  category: 'ESPS-ASSEMBLE',
  menuLabel: 'Assembleur ESP',
  menuIcon: '🧩',
  menuOrder: 27,
  menuPath: '/esps-assemble/config',
  fields: [
    {
      title: 'Ce site',
      description: "Le site figure dans les sujets MQTT (les sites restent étanches). L'adresse joignable est celle de CETTE instance vue de l'usine (ex. 192.168.1.51:8087) ; vide = adresse locale.",
      icon: '📍',
      fields: [
        { name: 'site', label: 'Site', type: 'text', required: true, placeholder: 'stfort' },
        { name: 'adresseJoignable', label: "Adresse joignable depuis l'usine", type: 'text', placeholder: '192.168.1.51:8087' },
        { name: 'revisionsGardees', label: 'Révisions de paquets conservées par appareil', type: 'number', default: 5 }
      ]
    },
    {
      title: 'Broker MQTT du site',
      description: "Là où l'assembleur publie ses demandes (messages conservés) et lit l'état de l'usine et du poseur.",
      icon: '📡',
      fields: [
        { name: 'mqtt.hote', label: 'Hôte MQTT', type: 'text', default: '127.0.0.1' },
        { name: 'mqtt.port', label: 'Port MQTT', type: 'number', default: 1883 },
        { name: 'mqtt.utilisateur', label: 'Utilisateur MQTT', type: 'text' },
        { name: 'mqtt.motDePasse', label: 'Mot de passe MQTT', type: 'password' }
      ]
    }
  ]
};

export const ESPS_ASSEMBLE_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'Assembleur ESP',
  entry: { label: 'Assembleur ESP', icon: '🧩', path: '/esps-assemble/config', order: 27 },
  pages: [{ id: 'appareils', label: 'Appareils', icon: '🧩', path: '/applications/esps-assemble/presentation/index.html', order: 1 }]
};

export const ESPS_ASSEMBLE_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'esps-assemble',
  name: 'ESPS-ASSEMBLE',
  description: "Assembleur de sources ESPHome : matériel + éléments de bibliothèque → paquet, demande à l'usine par MQTT.",
  icon: '🧩',
  menu: ESPS_ASSEMBLE_MENU_CONFIG,
  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'esps-assemble',
  configUi: ESPS_ASSEMBLE_UI_METADATA,
  socketEvents: ASSEMBLEUR_SOCKET_EVENTS,
  runsAsSeparateProcess: true
};

export function createAssembleurService(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<AssembleurConfig>, clientHa?: ClientHa): IAssembleurService {
  const service = new AssembleurService(eventBus, logger, configProvider, undefined, undefined, undefined, undefined, undefined, clientHa);
  eventBus.emit('app:socket-events:registered', { appId: 'esps-assemble', socketEvents: ASSEMBLEUR_ALL_EVENTS, persistentEvents: ASSEMBLEUR_PERSISTENT_EVENTS });
  eventBus.emit('app:menu:register', { appId: 'esps-assemble', menuConfig: ESPS_ASSEMBLE_MENU_CONFIG });
  return service;
}

export function createAssembleurServiceWithConfig(eventBus: IEventBus, logger: Logger, configService: ConfigService, clientHa?: ClientHa): IAssembleurService {
  return createAssembleurService(eventBus, logger, new AppConfigProvider<AssembleurConfig>('esps-assemble' as any, configService), clientHa);
}

export * from './AssembleurService';
export * from './config-schema';
export * from './socket-events';
export * from './assembleur/fiches';
export * from './assembleur/resolution';
export * from './assembleur/verification';
export * from './assembleur/paquet';
export * from './plans/coordonnees';
export * from './plans/generation';
export * from './plans/image';
export * from './plans/generer-fichiers';
export * from './plans/source-ha';
