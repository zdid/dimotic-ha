/**
 * Module principal de l'application Sauvegarde/Restauration
 *
 * Scanné par AppService pour la détection automatique. Exporte SAUVEGARDE_APP (métadonnées) et
 * createSauvegardeService (factory). Voir specs/current/fonctionnelles-sauvegarde_specs_v1.4.md.
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
      description: "URL WebDAV — le mot de passe d'application ne se saisit jamais ici, voir §3bis : il se pousse par machine ci-dessous, dans un fichier fixe (/dimotic-secrets/), hors de tout ce qui est sauvegardé.",
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
          // ⭐ 17/09/2026, demande explicite : l'URL WebDAV reconstruite (déjà affichée sur le
          // tableau de bord) doit AUSSI apparaître ici, en direct pendant la saisie des deux champs
          // ci-dessus — pas seulement une fois sauvegardé. Nouveau type de champ générique
          // 'preview' (ModuleManager.generateFieldHtml + ConfigForm.setupFormListeners) : recalcule
          // et affiche un aperçu dès qu'un des champs de `previewOf` change, via une petite
          // bibliothèque de formules nommées côté ConfigForm (`computePreview`) — pas un moteur de
          // template générique, juste assez pour ce cas et les suivants du même genre.
          name: 'nextcloud.webdavUrlPreview',
          label: 'URL WebDAV reconstruite',
          type: 'preview',
          previewOf: ['nextcloud.serverUrl', 'nextcloud.user'],
          previewFormula: 'nextcloudWebdavUrl'
        },
        {
          name: 'nextcloud.rootPath',
          label: 'Sous-dossier racine (optionnel)',
          type: 'text',
          default: 'dimotic-backups'
        }
      ]
    },
    {
      title: 'Machines couvertes',
      // ⭐ 17/09/2026, simplifié trois fois sur demande explicite : une seule ligne par MACHINE,
      // point — plus de type de parent à choisir non plus, voir le commentaire de
      // sauvegardeTargetSchema (le futur script hôte sauvegarde /docker ET /dimotic-ha-addons,
      // saute celle qui n'existe pas). Ce que Nextcloud contient réellement se découvre en
      // listant, pas à pré-déclarer ici.
      description: "Une ligne par machine à couvrir. « Pousser » dépose le mot de passe Nextcloud ET le script de sauvegarde + son cron quotidien (3h05) sur la machine — la machine devient alors autonome, plus besoin de dimotic-ha pour que ses sauvegardes continuent. La machine de destination d'une restauration se choisit séparément, dans l'assistant de restauration.",
      icon: '🗂️',
      // ⭐ 23/09/2026 — bouton « Importer depuis le gossip » retiré (demande explicite, test live) :
      // la source (core.targets/haStackTargets) ne contenait que des cibles de déploiement
      // périmées, sans site, parfois en 127.0.0.1 — les machines se saisissent à la main.
      fields: [
        {
          // ⭐ 17/09/2026, demande explicite : la poussée du mot de passe Nextcloud par machine
          // (SSH, §3bis de la spec) vit ICI, sur cette page de Paramètres Techniques — pas sur le
          // tableau de bord (page application, revue beaucoup plus tard). `secretPush` (champ
          // générique sur ConfigField, ModuleManager.generateArrayFieldHtml) ajoute, à côté des
          // champs site/machine/host de chaque ligne, un mot de passe + bouton « Pousser » + tag
          // persistant (secretDeployed).
          //
          // ⭐ 18/09/2026, demande explicite : « Pousser » ne dépose plus SEULEMENT le mot de passe
          // — il dépose aussi le script de sauvegarde (chantier A, BackupScript.ts) et pose son cron
          // quotidien sur la machine cible (ScriptPushService) dans la foulée. Le tag ne passe à
          // « Déployé » que si les trois réussissent — voir SauvegardeService.handleSecretPush.
          //
          // Pas de champ "Identifiant" ici (⭐ 17/09/2026, "à quoi sert la zone identifiant ?") :
          // `id` reste dans le schéma (clé unique, utilisée par la poussée) mais n'est plus saisi à
          // la main — `hiddenIdFrom` le dérive automatiquement de site+machine, une seule fois, voir
          // deriveTargetId (config-schema.ts) et le x-effect correspondant dans
          // ModuleManager.generateArrayFieldHtml.
          name: 'targets',
          label: 'Machines',
          type: 'array',
          itemLabel: 'Machine',
          hiddenIdFrom: ['site', 'machine'],
          itemFields: [
            { name: 'site', label: 'Site', type: 'text', required: true, placeholder: 'stfort' },
            { name: 'machine', label: 'Machine', type: 'text', required: true, placeholder: 'ha2' },
            { name: 'host', label: 'Hôte (pour la poussée du secret et du script de sauvegarde)', type: 'text', required: true, placeholder: '192.168.1.51' }
          ],
          secretPush: {
            action: 'sauvegarde:secret:push',
            statusField: 'secretDeployed',
            passwordPlaceholder: "Mot de passe d'application Nextcloud",
            pushButtonLabel: '📤 Pousser',
            deployedLabel: '✅ Déployé',
            pendingLabel: '⏳ En attente'
          },
          // ⭐ 18/09/2026, demande explicite : déclencher une sauvegarde à la demande (ex. après de
          // grosses modifications), sans attendre le cron quotidien — exécute par SSH le script déjà
          // déployé par « Pousser » (SauvegardeService.handleBackupRunNow). N'apparaît un sens que si
          // le script a déjà été déployé (secretDeployed), mais reste affiché tout le temps — un
          // essai sur une ligne pas encore déployée échoue juste avec une erreur explicite ("script
          // absent"), pas besoin de le cacher conditionnellement.
          rowActions: [
            { action: 'sauvegarde:backup:run', label: '▶️ Lancer maintenant' }
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
    },
    {
      // ⭐ 23/09/2026 — assistant de restauration (page autonome, comme le tableau de bord HAPLAN).
      id: 'restauration',
      label: 'Restauration',
      icon: '♻️',
      path: '/applications/sauvegarde/presentation/sauvegarde/restauration.html',
      order: 2
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
  runsAsSeparateProcess: true
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
