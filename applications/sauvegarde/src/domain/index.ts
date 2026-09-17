/**
 * Module principal de l'application Sauvegarde/Restauration
 *
 * Scanné par AppService pour la détection automatique. Exporte SAUVEGARDE_APP (métadonnées) et
 * createSauvegardeService (factory). Voir specs/current/fonctionnelles-sauvegarde_specs_v1.0.md.
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
import { SAUVEGARDE_SOCKET_EVENTS, SAUVEGARDE_ALL_EVENTS, SAUVEGARDE_PERSISTENT_EVENTS } from './socket-events';
import { SauvegardeService, type ISauvegardeService } from './SauvegardeService';
import type { SauvegardeConfig } from './config-schema';

// ============================================================================
// Métadonnées UI — connexion Nextcloud + répertoires de déploiement couverts (§6 de la spec).
// La restauration elle-même (assistant à étapes) vit sur sa propre page, pas dans ce formulaire
// technique généré automatiquement (ModuleManager.ts ne rend que des champs plats/tableaux
// simples, pas un assistant multi-étapes).
// ============================================================================

export const SAUVEGARDE_UI_METADATA: ModuleUiMetadata = {
  title: 'Sauvegarde/Restauration',
  description: "Connexion au Nextcloud de sauvegarde et répertoires de déploiement couverts, en vue d'une restauration croisée entre machines.",
  icon: '💾',
  category: 'Sauvegarde',
  menuLabel: 'Sauvegarde/Restauration',
  menuIcon: '💾',
  menuOrder: 30,
  menuPath: '/sauvegarde/config',
  badge: 'Nextcloud',

  fields: [
    {
      title: 'Connexion Nextcloud',
      description: "URL WebDAV et référence au mot de passe d'application — jamais la valeur elle-même, voir §3bis de la spec (le fichier vit au niveau de l'hôte, hors de tout ce qui est sauvegardé).",
      icon: '☁️',
      fields: [
        {
          // ⭐ 17/09/2026, demande explicite : préremplir avec un exemple fictif mais éditable
          // (pas juste un `placeholder` fantôme qui disparaît à la frappe) — `default` devient la
          // vraie valeur initiale du champ tant qu'aucune vraie config n'a été sauvegardée
          // (ModuleManager.generateFieldHtml : value = config existante ?? field.default).
          //
          // ⭐ 17/09/2026 (2e remarque) — juste le domaine, pas le chemin WebDAV complet : le
          // champ `user` ci-dessous servait à rien tant qu'il n'était pas réellement utilisé pour
          // construire l'adresse — désormais `NextcloudWebDavClient` reconstruit
          // `<serverUrl>/remote.php/dav/files/<user>` lui-même, jamais saisi à la main.
          name: 'nextcloud.serverUrl',
          label: 'URL du serveur Nextcloud',
          type: 'text',
          required: true,
          default: 'https://nextcloud.exemple.fr',
          hint: "Juste le domaine — le chemin WebDAV complet est reconstruit automatiquement à partir de ceci et de l'utilisateur ci-dessous."
        },
        {
          name: 'nextcloud.user',
          label: 'Utilisateur Nextcloud',
          type: 'text',
          required: true,
          default: 'utilisateur'
        },
        {
          name: 'nextcloud.rootPath',
          label: 'Sous-dossier racine (optionnel)',
          type: 'text',
          default: 'dimotic-backups'
        },
        {
          name: 'nextcloud.appPasswordFile',
          label: "Chemin du fichier hôte contenant le mot de passe d'application",
          type: 'text',
          required: true,
          // ⭐ 17/09/2026 : plus de valeur Docker par défaut (/docker/...) — dépend trop du type de
          // machine (Docker vs dev local vs RPi1) pour être un bon défaut universel. Exemple
          // volontairement générique, à remplacer par le vrai chemin de CETTE machine — jamais
          // sous un dossier synchronisé (Nextcloud desktop, ownCloud/...) : voir §3bis.
          default: '/chemin/vers/.secrets/nextcloud-backup',
          hint: 'Jamais la valeur elle-même — un fichier au niveau de l\'hôte, hors de tout ce qui est sauvegardé (jamais sous un dossier synchronisé par le client Nextcloud).'
        }
      ]
    },
    {
      title: 'Répertoires de déploiement couverts',
      description: "Un répertoire par site/machine/app — sert à lister ce qui existe sur Nextcloud et à savoir comment arrêter/redémarrer le service lors d'une restauration. La machine de destination d'une restauration se choisit séparément, dans l'assistant de restauration.",
      icon: '🗂️',
      fields: [
        {
          name: 'targets',
          label: 'Répertoires',
          type: 'array',
          itemLabel: 'Répertoire',
          itemFields: [
            { name: 'id', label: 'Identifiant', type: 'text', required: true, placeholder: 'ha2-dimotic-ha' },
            { name: 'site', label: 'Site', type: 'text', required: true, placeholder: 'stfort' },
            { name: 'machine', label: 'Machine', type: 'text', required: true, placeholder: 'ha2' },
            { name: 'host', label: 'Hôte (pour la poussée du secret Nextcloud)', type: 'text', placeholder: '192.168.1.51' },
            { name: 'deploymentDir', label: 'Répertoire de déploiement', type: 'text', required: true, placeholder: 'dimotic-ha' },
            {
              name: 'deploymentType',
              label: 'Type',
              type: 'select',
              options: [
                { value: 'docker', label: 'Docker' },
                { value: 'raw', label: 'Systemd (non-Docker)' }
              ],
              default: 'docker'
            },
            { name: 'unitName', label: 'Nom du conteneur/de l\'unité', type: 'text', required: true, placeholder: 'dimotic-ha' },
            { name: 'destinationPath', label: 'Chemin réel sur la machine', type: 'text', required: true, placeholder: '/docker/dimotic-ha' }
          ]
        }
      ]
    }
  ]
};

// ============================================================================
// Configuration du menu
// ============================================================================

export interface MenuEntry {
  id?: string;
  label: string;
  icon?: string;
  path: string;
  order: number;
  badge?: string;
}

export interface ApplicationMenuConfig {
  category: string;
  section: string;
  entry: MenuEntry;
  pages?: MenuEntry[];
}

export const SAUVEGARDE_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'Sauvegarde',
  entry: {
    label: 'Sauvegarde/Restauration',
    icon: '💾',
    path: '/sauvegarde/config',
    order: 30,
    badge: 'Nextcloud'
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      icon: '📊',
      path: '/applications/sauvegarde/presentation/index.html',
      order: 1
    }
  ]
};

// ============================================================================
// Déclaration du module Sauvegarde/Restauration
// ============================================================================

export const SAUVEGARDE_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'sauvegarde',
  name: 'Sauvegarde/Restauration',
  description: "Restauration de sauvegardes (dimotic-ha, HA, services tiers) depuis le Nextcloud auto-hébergé, vers n'importe quelle machine du foyer.",
  icon: '💾',

  menu: SAUVEGARDE_MENU_CONFIG,

  // 'standalone', pas 'integration' : pas de découverte MQTT HA, cette app ne parle qu'à Nextcloud
  // et par SSH aux machines cibles.
  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: false,
  configSection: 'sauvegarde',
  configUi: SAUVEGARDE_UI_METADATA,
  socketEvents: SAUVEGARDE_SOCKET_EVENTS,

  // Process séparé, comme arexx/teleinfo/rpigpio — voir fonctionnelles-supervisor_specs.
  runsAsSeparateProcess: true,

  // ⭐ 17/09/2026 — sans ça, la requête gossip vers core (CorrelatedRequester, voir
  // SauvegardeService.handleGossipImport) ne traverserait jamais la frontière de process : ceci
  // n'est PAS couvert par `socketEvents` (qui ne concerne que le pont Socket.io client↔serveur),
  // c'est le pont EventBus process↔process, même mécanisme que ia/planificateur
  // (voir leurs bridgedEvents respectifs pour 'ia:command'/'ia:command:reply').
  bridgedEvents: ['sauvegarde:gossip-targets:get', 'sauvegarde:gossip-targets:reply']
};

// ============================================================================
// Factory du service
// ============================================================================

export function createSauvegardeService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<SauvegardeConfig>
): ISauvegardeService {
  const service = SauvegardeService.create(eventBus, logger, configProvider);

  eventBus.emit('app:socket-events:registered', {
    appId: 'sauvegarde',
    socketEvents: SAUVEGARDE_ALL_EVENTS,
    persistentEvents: SAUVEGARDE_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'sauvegarde',
    menuConfig: SAUVEGARDE_MENU_CONFIG
  });

  return service;
}

export function createSauvegardeServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService
): ISauvegardeService {
  const configProvider = new AppConfigProvider<SauvegardeConfig>('sauvegarde', configService);
  return createSauvegardeService(eventBus, logger, configProvider);
}

// Exporter les composants
export * from './SauvegardeService';
export * from './socket-events';
export * from './config-schema';
export * from './types';
