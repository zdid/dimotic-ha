/**
 * Module principal de l'application ESPDISPLAY
 *
 * Ce fichier est scanné par AppService pour la détection automatique. Il doit exporter :
 * - ESPDISPLAY_APP : ApplicationModule (métadonnées)
 * - createEspDisplayService : Factory de service
 *
 * ⚠️ Le nom du répertoire (espdisplay) DOIT correspondre à l'ID déclaré ici.
 *
 * Orchestration des écrans ESP (ESPHome/LVGL) : déclenché par un événement générique sur
 * l'EventBus partagé (ex: HAPLAN -> espdisplay:deploy-floorplan), exécute le pipeline Python de
 * génération/compilation, toujours par SSH sur la machine ESPHome (voir EspDisplayService.runPipelineRemote).
 *
 * Configuration UI ajoutée le 14/08/2026 (absente jusque-là — squelette minimal du 13/08) :
 * découvert en conditions réelles que la config `remote.*` (hôte/utilisateur/clé SSH), mise en
 * place à la main via SSH pour contourner l'absence de python3/conteneur esphome sur ha2, n'était
 * consultable ni modifiable que par un accès direct à data/espdisplay/config.yaml — aucun moyen de
 * la voir depuis l'UI, ni même de trouver l'application dans "Paramètres Techniques" (pas de menu
 * du tout). Corrigé en reprenant le pattern teleinfo/rpigpio (ModuleUiMetadata + ApplicationMenuConfig).
 */

import type { ApplicationModule, ModuleUiMetadata, IEventBus, Logger, IAppConfigProvider, ConfigService } from '../../../core/dist/exports';
import { AppConfigProvider } from '../../../core/dist/exports';
import { EspDisplayService, type IEspDisplayService } from './EspDisplayService';
import { type EspDisplayConfig } from './config-schema';

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

export const ESPDISPLAY_UI_METADATA: ModuleUiMetadata = {
  title: 'ESPDISPLAY - Écrans ESP',
  description: "Orchestration du déploiement de firmware sur les écrans ESP (ESPHome/LVGL) — déclenché depuis HAPLAN (bouton \"Déployer sur l'écran\") ou toute autre application future. N'exécute rien lui-même : appelle le pipeline Python déjà existant, localement ou sur une machine distante (ex: ha2 vers falbala, quand la machine qui héberge ce service n'a ni python3 ni le conteneur Docker esphome).",
  icon: '🖥️',
  category: 'ESPDISPLAY',
  menuLabel: 'Écrans ESP',
  menuIcon: '🖥️',
  menuOrder: 27,
  menuPath: '/espdisplay/config',
  fields: [
    {
      title: 'Conteneur ESPHome',
      description: "Conteneur Docker esphome (esphome/esphome, network_mode: host) et son répertoire de config — sur la machine ESPHome ci-dessous (celle qui héberge le conteneur), pas sur celle qui affiche cette page.",
      icon: '🐳',
      fields: [
        { name: 'esphomeContainer', label: 'Nom du conteneur', type: 'text', default: 'esphome' },
        { name: 'esphomeConfigDir', label: 'Répertoire de config monté', type: 'text', default: '/docker/esphome/config' },
        { name: 'pipelineScriptPath', label: 'Chemin du script Python (sur la machine ESPHome)', type: 'text', hint: "Vide = generate_esphome_floorplan.py du dépôt sur la machine ESPHome (dossier applications/haplan/tools)" },
        { name: 'pythonBin', label: 'Binaire Python', type: 'text', default: 'python3' }
      ]
    },
    {
      title: 'Machine ESPHome (obligatoire)',
      description: "Machine qui héberge le conteneur esphome (la compilation ESP-IDF demande beaucoup de mémoire : pas sur un Pi4). Le déploiement y est toujours lancé par SSH, avec la clé SSH unique de dimotic-ha (la même que pour les autres machines) — à autoriser une fois pour cet utilisateur sur cette machine (voir la page d'accueil). Côté machine ESPHome, ~/bin/espdisplay-agent-run.sh lance le pipeline. Réglages communs à toutes les machines (diffusés).",
      icon: '🌐',
      fields: [
        { name: 'remote.host', label: 'Hôte', type: 'text', placeholder: '192.168.1.26', required: true, hint: 'Obligatoire — adresse de la machine ESPHome' },
        { name: 'remote.sshUser', label: 'Utilisateur SSH', type: 'text', default: 'didier' }
      ]
    }
  ]
};

export const ESPDISPLAY_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'Écrans ESP',
  entry: {
    label: 'Écrans ESP',
    icon: '🖥️',
    path: '/espdisplay/config',
    order: 27
  }
};

export const ESPDISPLAY_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'espdisplay',
  name: 'ESPDISPLAY',
  description: 'Orchestration des écrans ESP (ESPHome/LVGL) : reçoit une demande de déploiement (ex: depuis HAPLAN) et exécute le pipeline génération+compilation Python correspondant, par SSH sur la machine ESPHome.',
  icon: '🖥️',

  menu: ESPDISPLAY_MENU_CONFIG,

  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'espdisplay',
  configUi: ESPDISPLAY_UI_METADATA,

  // ⭐ fonctionnelles-supervisor_specs v2.6, Phase 1 (16/08/2026) — première application migrée en
  // process séparé. bridgedEvents ne garde que le sens local → MQTT, non couvert par le pont
  // générique (§7.1) : espdisplay:deploy-floorplan, émis par HAPLAN (resté in-process) sur le bus
  // local de core, doit être explicitement relayé vers espdisplay. L'autre sens
  // (espdisplay:deploy-result, émis PAR espdisplay) est reçu automatiquement par le pont MQTT→local
  // générique, plus besoin de le déclarer ici.
  runsAsSeparateProcess: true,
  bridgedEvents: ['espdisplay:deploy-floorplan']
};

export function createEspDisplayService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<EspDisplayConfig>
): IEspDisplayService {
  const service = EspDisplayService.create(eventBus, logger, configProvider);

  eventBus.emit('app:menu:register', {
    appId: 'espdisplay',
    menuConfig: ESPDISPLAY_MENU_CONFIG
  });

  return service;
}

export function createEspDisplayServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): IEspDisplayService {
  const configProvider = new AppConfigProvider<EspDisplayConfig>('espdisplay' as any, configService);
  return createEspDisplayService(eventBus, logger, configProvider);
}

export * from './EspDisplayService';
export * from './config-schema';
