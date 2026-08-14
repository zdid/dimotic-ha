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
 * génération/compilation, localement ou via SSH distant (voir EspDisplayService.runPipelineRemote).
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
      description: "Conteneur Docker esphome (esphome/esphome, network_mode: host) et son répertoire de config — sur CETTE machine si \"Machine distante\" ci-dessous est vide, sinon sur la machine distante.",
      icon: '🐳',
      fields: [
        { name: 'esphomeContainer', label: 'Nom du conteneur', type: 'text', default: 'esphome' },
        { name: 'esphomeConfigDir', label: 'Répertoire de config monté', type: 'text', default: '/docker/esphome/config' },
        { name: 'pipelineScriptPath', label: 'Chemin du script Python (local)', type: 'text', hint: "Vide = applications/haplan/tools/generate_esphome_floorplan.py — sans effet si une machine distante est configurée (la commande forcée côté cible impose son propre chemin)" },
        { name: 'pythonBin', label: 'Binaire Python', type: 'text', default: 'python3' }
      ]
    },
    {
      title: 'Machine distante (optionnel)',
      description: "Laisser \"Hôte\" vide pour exécuter localement (valable seulement si CETTE machine héberge le conteneur esphome). Sinon, délégation par SSH — clé dédiée, commande forcée côté cible (~/bin/espdisplay-agent-run.sh) qui ne permet RIEN d'autre que ce pipeline précis. Mis en place pour ha2 → falbala le 14/08/2026 (ha2/Pi4 n'a pas assez de RAM pour compiler ESP-IDF).",
      icon: '🌐',
      fields: [
        { name: 'remote.host', label: 'Hôte', type: 'text', placeholder: '192.168.1.26', hint: 'Vide = exécution locale' },
        { name: 'remote.sshUser', label: 'Utilisateur SSH', type: 'text', default: 'didier' },
        { name: 'remote.sshKeyPath', label: 'Clé SSH privée (chemin dans le conteneur)', type: 'text', hint: 'Doit être montée en volume, ex: /app/secrets/espdisplay-agent_id_ed25519 (lecture seule, uid/gid 1000)' }
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
  description: 'Orchestration des écrans ESP (ESPHome/LVGL) : reçoit une demande de déploiement (ex: depuis HAPLAN) et exécute le pipeline génération+compilation Python correspondant, localement ou via SSH distant.',
  icon: '🖥️',

  menu: ESPDISPLAY_MENU_CONFIG,

  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'espdisplay',
  configUi: ESPDISPLAY_UI_METADATA
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
