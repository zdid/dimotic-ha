/**
 * Module principal de l'application ia.
 *
 * Scanné par AppService pour la détection automatique. Exporte IA_APP (métadonnées) et
 * createIaService — reçoit un HaBridgeClient (⭐ 24/08/2026, façade générique vers le référentiel
 * HA détenu par `core`, voir HaBridgeClient.ts) pour résoudre localement les outils de lecture,
 * specs §1/§8. `ia` n'exécute jamais d'action HA elle-même (seul `planificateur` le fait, point
 * d'exécution unique) — HaBridgeClient.sendCommand/processConversation ne lui sont donc pas utiles,
 * comme HaWsClient ne l'était déjà pas avant cette migration.
 */

import {
  ApplicationModule,
  ModuleUiMetadata,
  IEventBus,
  Logger,
  IAppConfigProvider,
  ConfigService,
  AppConfigProvider,
  HaBridgeClient
} from '../../../core/dist/exports';
import { IA_ALL_EVENTS, IA_PERSISTENT_EVENTS } from './socket-events';
import { IaService, type IIaService } from './IaService';
import type { IaConfig } from './config-schema';

// ============================================================================
// Métadonnées UI
// ============================================================================

export const IA_UI_METADATA: ModuleUiMetadata = {
  title: 'IA - Émulateur Ollama / Mistral',
  description: "Émule le protocole Ollama pour l'intégration native de Home Assistant, relaie vers Mistral avec accès à un jeu d'outils domotiques (lecture directe, action via planificateur).",
  icon: '🤖',
  category: 'IA',
  menuLabel: 'IA',
  menuIcon: '🤖',
  menuOrder: 29,
  menuPath: '/ia/config',
  badge: 'Mistral',

  fields: [
    {
      title: 'Mistral',
      description: 'Clé API et modèle par défaut. Limites de débit par modèle (throttling préventif + backoff sur 429) réglables dans data/ia/config.yaml (mistralRateLimits), pas ici — un modèle différent a des quotas indépendants.',
      icon: '🔑',
      fields: [
        { name: 'mistralApiKey', label: 'Clé API Mistral', type: 'password' },
        { name: 'mistralBaseUrl', label: 'URL de base de l\'API', type: 'string', default: 'https://api.mistral.ai/v1' },
        { name: 'defaultMistralModel', label: 'Modèle par défaut', type: 'string', default: 'mistral-small-latest' }
      ]
    },
    {
      title: 'Comparatif Claude (optionnel)',
      description: 'Bascule TOUT le traitement domotique vers Claude au lieu de Mistral, via la couche de compatibilité OpenAI d\'Anthropic — sert à comparer les deux sur les mêmes commandes, pas un routage permanent. Nécessite une clé API sur platform.claude.com (distincte d\'un abonnement claude.ai Pro).',
      icon: '🧪',
      fields: [
        { name: 'provider', label: 'Fournisseur actif', type: 'select', options: [
          { value: 'mistral', label: 'Mistral' },
          { value: 'anthropic', label: 'Claude (comparatif)' }
        ] },
        { name: 'anthropicApiKey', label: 'Clé API Anthropic', type: 'password' },
        { name: 'anthropicBaseUrl', label: 'URL de base de l\'API', type: 'string', default: 'https://api.anthropic.com/v1' },
        { name: 'defaultAnthropicModel', label: 'Modèle', type: 'string', default: 'claude-haiku-4-5-20251001' }
      ]
    },
    {
      title: 'Accès Claude Code (MCP)',
      description: "Donne à Claude Code les mêmes outils que Mistral (lister_entites, obtenir_etat, executer_action — ce dernier agit réellement sur la maison). Désactivé par défaut ; ne démarre que si activé ET jeton défini. Réseau local uniquement : ne jamais exposer ce port sur Internet. Changement pris en compte au redémarrage de l'application IA. Côté Claude Code : claude mcp add --transport http dimotic http://<machine>:<port>/mcp --header \"Authorization: Bearer <jeton>\"",
      icon: '🔌',
      fields: [
        { name: 'mcpEnabled', label: 'Activer l\'accès MCP', type: 'boolean', default: false },
        { name: 'mcpToken', label: 'Jeton d\'accès', type: 'password', storage: 'secret', hint: 'Chaîne secrète longue (ex: openssl rand -hex 32). Obligatoire.' },
        { name: 'mcpPort', label: 'Port MCP', type: 'number', default: 8765 },
        { name: 'mcpHost', label: 'Adresse d\'écoute', type: 'string', default: '0.0.0.0', hint: '127.0.0.1 = cette machine seulement ; 0.0.0.0 = tout le réseau local' }
      ]
    },
    {
      title: 'Serveur Ollama émulé',
      description: 'Port dédié, indépendant du port web du socle.',
      icon: '📡',
      fields: [
        { name: 'ollamaHttpPort', label: 'Port HTTP', type: 'number', default: 11434 },
        { name: 'rulesFile', label: 'Fichier de règles personnalisé (optionnel)', type: 'string', default: '', description: "Vide (recommandé) : les règles utilisées sont data/ia/personnalise/regles_mistral.txt si ce fichier existe, sinon la version embarquée (copie renouvelée à chaque démarrage dans data/ia/modele_integre/). Pour personnaliser : copier le fichier de modele_integre/ vers personnalise/ puis le modifier. Renseigner ici un chemin (absolu, ou relatif à applications/ia/) remplace data/ia/personnalise/." }
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

export const IA_MENU_CONFIG: ApplicationMenuConfig = {
  category: 'Paramètres Techniques',
  section: 'IA',
  entry: {
    label: 'IA',
    icon: '🤖',
    path: '/ia/config',
    order: 29,
    badge: 'Mistral'
  },
  pages: [
    {
      id: 'dashboard',
      label: 'Tableau de bord',
      icon: '📊',
      path: '/applications/ia/presentation/index.html',
      order: 1
    }
  ]
};

// ============================================================================
// Déclaration du module
// ============================================================================

export const IA_APP: ApplicationModule & { menu?: ApplicationMenuConfig } = {
  id: 'ia',
  name: 'IA',
  description: "Émulateur de protocole Ollama routant vers Mistral, avec outils domotiques et routage vers l'application 'planificateur'.",
  icon: '🤖',

  menu: IA_MENU_CONFIG,

  type: 'standalone',
  audience: 'configuration',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: true,
  // ⭐ 24/08/2026 — migration en process séparé (découplage HaStructureRegistry/HaWsClient via
  // HaBridgeClient, voir IaService.ts) : résout le redémarrage complet de core à la désactivation
  // depuis Gestion des applications (superviseur Phase 2).
  runsAsSeparateProcess: true,
  configSection: 'ia',
  configUi: IA_UI_METADATA,
  socketEvents: IA_ALL_EVENTS,
  // ⭐ 25/08/2026, bug réel corrigé : les réponses corrélées de `planificateur` (ToolExecutor.ts/
  // StructuredRouter.ts, CorrelatedRequester) n'atteignaient jamais `ia` depuis la migration en
  // process séparé des deux apps — aucun des deux ne fait partie des motifs génériques déjà pontés
  // (integration:*/ha:*), c'est l'échappatoire bridgedEvents prévue pour ce cas (voir
  // SupervisorEventBridge.ts). Constaté en conditions réelles : "allume le salon" timeout après
  // 4 tentatives, ToolExecutor logue "Timeout (10000ms) en attente de réponse sur
  // ia:tool:execute:reply" — planificateur répondait bien, la réponse n'était simplement jamais
  // relayée jusqu'au process ia.
  //
  // ⭐ 25/08/2026 (suite, même jour) : planificateur:deploy manqué au premier passage — 3e canal de
  // corrélation (ExecutionEngine.deployRequester → DeployResponder.ts), sens INVERSE des deux
  // premiers (planificateur émet, ia répond) : planificateur:deploy doit donc être ponté vers `ia`
  // (émission reçue ici), pas planificateur:deploy:reply (voir planificateur/domain/index.ts pour
  // le sens inverse). Constaté en conditions réelles : repli sur deployAndExecute (verbe/lieu non
  // résolu par resolution.ts, ex: "sac" — lieu inconnu) systématiquement en échec, ExecutionEngine
  // logue "Timeout (15000ms) en attente de réponse sur planificateur:deploy:reply" — ia ne
  // recevait jamais la demande de réinterprétation, ne pouvait donc jamais répondre.
  // ⭐ 26/08/2026 — planificateur:macros:list déjà émis (PlanificateurService.ts, pour son propre
  // tableau de bord) mais jamais relayé jusqu'ici vers ia : nécessaire pour que l'interpréteur
  // déterministe (specs §16) puisse reconnaître un nom de macro en tête de phrase sans solliciter
  // planificateur à chaque tentative (voir interpreter/macros.ts).
  // ⭐ 24/09/2026 — planificateur:deploy (réinterprétation complète au déclenchement) remplacé par
  // planificateur:condition (évaluation d'une condition en texte libre, ConditionEvaluator.ts).
  bridgedEvents: ['ia:tool:execute:reply', 'ia:command:reply', 'planificateur:condition', 'planificateur:macros:list']
};

// ============================================================================
// Factory du service
// ============================================================================

export function createIaService(
  eventBus: IEventBus,
  logger: Logger,
  configProvider: IAppConfigProvider<IaConfig>,
  haBridgeClient: HaBridgeClient
): IIaService {
  const service = IaService.create(eventBus, logger, configProvider, haBridgeClient);

  eventBus.emit('app:socket-events:registered', {
    appId: 'ia',
    socketEvents: IA_ALL_EVENTS,
    persistentEvents: IA_PERSISTENT_EVENTS
  });

  eventBus.emit('app:menu:register', {
    appId: 'ia',
    menuConfig: IA_MENU_CONFIG
  });

  return service;
}

export function createIaServiceWithConfig(
  eventBus: IEventBus,
  logger: Logger,
  configService: ConfigService,
  haBridgeClient: HaBridgeClient
): IIaService {
  const configProvider = new AppConfigProvider<IaConfig>('ia', configService);
  return createIaService(eventBus, logger, configProvider, haBridgeClient);
}

// Exporter les composants
export * from './IaService';
export * from './socket-events';
export * from './config-schema';
export * from './types';
