// src/types/config.ts
// Types de configuration partagés entre toutes les couches
// Conforme à specs-techniques-socle-ha-mqtt-v4.3.md §7

import { z } from 'zod';

// Type générique pour les configurations de modules
// Chaque module exportera son propre type de configuration
export type ModuleConfig = Record<string, unknown>;

// ============================================================================
// TYPES PRINCIPAUX
// ============================================================================

/**
 * Métadonnées pour un champ de configuration
 * Utilisé pour la génération dynamique des formulaires dans l'UI
 */
export interface ConfigField {
  name: string;                    // Nom du champ (ex: 'serialPort', 'mqtt.host')
  label: string;                   // Label à afficher
  type: 'text' | 'string' | 'number' | 'boolean' | 'select' | 'password' | 'string-array' | 'array';
  placeholder?: string;
  hint?: string;                   // Texte d'aide
  description?: string;            // Description détaillée
  required?: boolean;
  default?: unknown;               // Valeur par défaut
  options?: { value: string; label: string }[] | string[]; // Pour les selects (format simple ou {value, label})
  min?: number;                   // Pour number
  max?: number;
  step?: number;
  // Uniquement pour type: 'array' — liste d'objets avec ajout/suppression dynamique, rendue par
  // Alpine côté navigateur (voir applications/core/src/presentation/ui/ts/config/ModuleManager.ts
  // generateArrayFieldHtml()). itemFields décrit la forme d'un élément (chemins pointés
  // supportés, ex: "mqtt.host") ; ne supporte pas de sous-champ 'array' imbriqué.
  itemFields?: ConfigField[];
  itemLabel?: string;
  minItems?: number;
}

/**
 * Groupe de champs de configuration
 * Permet d'organiser les champs en sections logiques (MQTT, HA, etc.)
 */
export interface ConfigFieldGroup {
  title?: string;                 // Titre du groupe (ex: 'MQTT', 'HA')
  description?: string;           // Description du groupe
  icon?: string;                 // Icône du groupe
  fields: ConfigField[];          // Champs du groupe
}

/**
 * Métadonnées UI pour un module d'application
 * Permet la génération dynamique des formulaires de configuration
 * 
 * @example
 * // Structure plate
 * { fields: [{ name: 'host', type: 'text', ... }] }
 * 
 * @example
 * // Structure avec groupes
 * { fields: [
 *     { title: 'MQTT', fields: [{ name: 'mqtt.host', type: 'text', ... }] },
 *     { title: 'HA', fields: [{ name: 'ha.enabled', type: 'boolean', ... }] }
 *   ] }
 */
export interface ModuleUiMetadata {
  title: string;                  // Titre de la section
  description: string;            // Description
  icon?: string;                  // Icône (optionnel)
  category?: string;             // Catégorie pour le menu
  menuLabel?: string;            // Label du menu
  menuIcon?: string;             // Icône du menu
  menuOrder?: number;             // Ordre dans le menu
  menuPath?: string;              // Chemin du menu
  badge?: string;                 // Badge à afficher
  // ⭐ Supporter les champs plats OU les groupes
  fields: ConfigField[] | ConfigFieldGroup[];
}

/** Module d'application (pour la détection dynamique) */
export interface ApplicationModule {
  id: string;                    // Identifiant unique
  name: string;                  // Nom affiché
  description: string;           // Description
  icon: string;                 // Icône (emoji)
  type: 'core' | 'integration' | 'standalone';
  /**
   * À qui l'application s'adresse — distinct de `type` (qui décrit le mécanisme technique).
   * 'inspection' : consultation de ce qui est déjà configuré (ex: ArbreOuQuoi).
   * 'configuration' : paramétrage technique de la maison, jamais destiné à un usage quotidien par
   * toute la famille (ex: RFXCOM, EVOO7, AREXX, IA, gestion des applications).
   * 'end-user' : usage quotidien par tous (ex: HAPLAN) — seule cette catégorie est candidate à une
   * exposition externe (voir discussion architecture accès externe).
   */
  audience?: 'inspection' | 'configuration' | 'end-user';
  configurable: boolean;         // Peut être configuré via UI
  socketEvents?: Record<string, string>; // Événements Socket.io spécifiques
  requiredMqtt?: boolean;       // Nécessite MQTT
  requiredHaWs?: boolean;       // Nécessite HA WebSocket
  status?: 'configured' | 'partial' | 'missing' | 'error';
  // NOUVEAU : Pour la génération dynamique de l'UI
  configUi?: ModuleUiMetadata;    // Métadonnées pour l'interface utilisateur
  configSection?: string;          // Nom de la section dans la config (par défaut = id)
  /**
   * ⭐ fonctionnelles-supervisor_specs v2.6 §5 (Phase 1, 16/08/2026) : tourne comme un process OS
   * séparé (spawn/kill via ProcessSupervisor, communication via MqttEventBus) plutôt qu'in-process
   * via AppService.startApplicationService(). Distinct de `type` (qui décrit "a sa propre page de
   * config" — sens existant, sans rapport) : plusieurs apps ont déjà `type: 'standalone'` dans ce
   * sens sans vouloir tourner en process séparé (haplan, planificateur, arbreouquoi...). Seul
   * `espdisplay` l'a à `true` en Phase 1.
   */
  runsAsSeparateProcess?: boolean;
  /** Événements EventBus génériques à ponter vers MQTT pour une app `runsAsSeparateProcess` (en plus
   *  de `app:menu:register`, toujours ponté automatiquement pour ces apps) — ex: espdisplay déclare
   *  ici `espdisplay:deploy-floorplan`/`espdisplay:deploy-result` (ESPDISPLAY_EVENTS). */
  bridgedEvents?: string[];
}

/** Résultat de sauvegarde de la config */
export interface ConfigSaveResult {
  success: boolean;
  error?: string;
}

/**
 * Configuration complète de l'application
 * Structure conforme à data/config.yaml
 * 
 * NOTE: Les modules peuvent ajouter leurs propres sections via l'indexation [key: string]
 */
export interface AppConfig {
  ha: HaConfig;
  web: WebConfig;
  logging: LoggingConfig;
  // Les sections spécifiques aux modules sont ajoutées dynamiquement
  [key: string]: unknown;
}

// ============================================================================
// SECTION HA (Home Assistant)
// ============================================================================

/** Configuration WebSocket HA */
export interface HaWsConfig {
  host: string;             // Required: adresse IP du serveur HA
  port: number;             // Default: 8123
  token: string;            // Required: Long-Lived Access Token
  reconnect_delay: number;  // Default: 5 (secondes, backoff exponentiel)
}

/** Configuration de structuration du référentiel HA */
export interface HaStructureConfig {
  include_unassigned: boolean;  // Default: false
  unassigned_label: string;     // Default: "Non assigné"
}

/** Configuration HA complète */
export interface HaConfig {
  ws_enable: boolean;
  mqtt_enable: boolean;
  ws?: HaWsConfig;
  mqtt?: MqttConfig;
  structure: HaStructureConfig;
}

// ============================================================================
// SECTION MQTT
// ============================================================================

/** Configuration MQTT */
export interface MqttConfig {
  host: string;             // Required: adresse IP du broker MQTT
  port: number;             // Default: 1883
  client_id: string;        // Required: identifiant unique par application
  username?: string;        // Optional
  password?: string;        // Optional
  keepalive: number;        // Default: 60 (secondes)
  reconnect_delay: number;  // Default: 5 (secondes)
}

// ============================================================================
// SECTION WEB (Serveur HTTP)
// ============================================================================

/**
 * Configuration de la porte d'authentification OAuth2 HA — voir décision "accès externe"
 * (conception 2026-07-28). Désactivée par défaut : aucun effet sur une instance interne tant
 * que `enabled` n'est pas explicitement activé (prévu pour une future instance externe dédiée).
 * Le flux OAuth2 HA (GET /auth/authorize, POST /auth/token) sert uniquement de portail de
 * connexion — tous les utilisateurs authentifiés partagent ensuite le même accès complet via
 * le jeton longue durée déjà utilisé par le serveur (ha.ws.token), pas de permissions
 * différenciées par utilisateur HA (choix explicitement tranché).
 */
export interface AuthConfig {
  enabled: boolean;           // Default: false
  ha_base_url: string;        // URL HTTP publique de HA (distincte de ha.ws.host/port, LAN/WebSocket)
  client_id: string;          // Origine publique de cette instance (ex: https://haplan.example.com/)
  redirect_uri: string;       // ex: https://haplan.example.com/auth/callback (même origine que client_id)
  session_secret: string;     // Secret HMAC de signature du cookie de session — requis si enabled
  session_ttl_hours: number;  // Default: 720 (30 jours)
}

/** Configuration du serveur web */
export interface WebConfig {
  port: number;  // Default: 8080
  host: string;  // Default: "0.0.0.0"
  auth?: AuthConfig;
}

// ============================================================================
// SECTION LOGGING
// ============================================================================

/** Configuration de rotation des logs */
export interface LogRotateConfig {
  max_size_mb: number;  // Default: 10
  max_files: number;    // Default: 5
}

/** Configuration du logging */
export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';  // Default: "info"
  rotate: LogRotateConfig;
}

// ============================================================================
// TYPES DE VALIDATION
// ============================================================================

/** Statut de validation d'un champ individuel */
export interface ValidationStatus {
  isValid: boolean;
  isRequired: boolean;
  errorMessage?: string;
  warningMessage?: string;
  section: 'ha' | 'mqtt' | 'web' | 'logging' | string;
  path: string;
}

/** Erreur de validation */
export interface ValidationError {
  path: string;               // Chemin du champ (ex: "ha.ws.host")
  message: string;            // Message d'erreur
  severity: 'error';          // Toujours "error" pour les erreurs
  section: string;           // Section concernée
  required: boolean;         // Champ requis
}

/** Avertissement de validation */
export interface ValidationWarning {
  path: string;               // Chemin du champ
  message: string;            // Message d'avertissement
  severity: 'warning';        // Toujours "warning" pour les avertissements
  section: string;           // Section concernée
  required: boolean;         // Toujours false pour les warnings
}

/** Résultat complet de validation */
export interface ConfigValidationResult {
  valid: boolean;           // true si aucune erreur
  errors: ValidationError[];
  warnings: ValidationWarning[];
  requiredMissing: string[]; // Liste des chemins des champs requis manquants
}

// ============================================================================
// SCHÉMAS ZOD (Source de vérité pour la validation)
// ============================================================================

// Schéma pour HA WebSocket
export const haWsSchema = z.object({
  host: z.string().min(1, "HA host is required"),
  port: z.number().int().positive().default(8123),
  token: z.string().min(1, "Long-Lived Access Token is required"),
  reconnect_delay: z.number().int().nonnegative().default(5),
});

// Schéma pour la structuration HA
export const haStructureSchema = z.object({
  include_unassigned: z.boolean().default(false),
  unassigned_label: z.string().default("Non assigné"),
});

// Schéma pour MQTT
export const mqttSchema = z.object({
  host: z.string().min(1, "MQTT host is required"),
  port: z.number().int().positive().default(1883),
  client_id: z.string().min(1, "MQTT client_id is required"),
  username: z.string().optional(),
  password: z.string().optional(),
  keepalive: z.number().int().positive().default(60),
  reconnect_delay: z.number().int().nonnegative().default(5),
});

// Schéma pour la porte d'authentification OAuth2 HA (voir AuthConfig)
export const authSchema = z.object({
  enabled: z.boolean().default(false),
  ha_base_url: z.string().default(""),
  client_id: z.string().default(""),
  redirect_uri: z.string().default(""),
  session_secret: z.string().default(""),
  session_ttl_hours: z.number().int().positive().default(720),
});

// Schéma pour Web
export const webSchema = z.object({
  port: z.number().int().positive().default(8080),
  host: z.string().default("0.0.0.0"),
  auth: authSchema.optional(),
});

// Schéma pour Logging
export const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  rotate: z.object({
    max_size_mb: z.number().int().positive().default(10),
    max_files: z.number().int().positive().default(5),
  }),
});

// Schéma HA complet
//
// ws/mqtt sont volontairement assouplis ici (.partial()) : le client (TechnicalConfigManager,
// presentation/ui) envoie TOUJOURS les deux sous-objets complets sur `config:save`, même quand
// une seule section a été éditée (l'autre reste à ses valeurs par défaut, ex: mqtt.host: '').
// Avec haWsSchema/mqttSchema strictes directement ici, la validation Zod échouait alors sur la
// section non éditée et non activée (ex: sauvegarder uniquement HA WebSocket échouait sur
// "MQTT host is required", mqtt_enable pourtant resté à false) — bug réel constaté le 06/08/2026.
// La vraie exigence (host/token non vides) n'est appliquée que si la section correspondante est
// activée, via superRefine ci-dessous.
export const haConfigSchema = z.object({
  ws_enable: z.boolean().default(false),
  mqtt_enable: z.boolean().default(false),
  ws: haWsSchema.partial().optional(),
  mqtt: mqttSchema.partial().optional(),
  structure: haStructureSchema,
}).superRefine((data, ctx) => {
  if (data.ws_enable) {
    const result = haWsSchema.safeParse(data.ws ?? {});
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['ws', ...issue.path] });
      }
    }
  }
  if (data.mqtt_enable) {
    const result = mqttSchema.safeParse(data.mqtt ?? {});
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['mqtt', ...issue.path] });
      }
    }
  }
});

// Schéma technique complet (sans les sections métier spécifiques)
// Les modules peuvent étendre ce schéma avec leurs propres sections
export const technicalConfigSchema = z.object({
  ha: haConfigSchema.optional(),
  web: webSchema,
  logging: loggingSchema,
  // Les sections spécifiques aux modules seront ajoutées dynamiquement
});

// Schéma complet de l'application (extensible par les applications)
export const appConfigSchema = technicalConfigSchema.extend({});

// Type dérivé du schéma
export type TechnicalConfig = z.infer<typeof technicalConfigSchema>;
export type AppConfigFromSchema = z.infer<typeof appConfigSchema>;

// ============================================================================
// VALEURS PAR DÉFAUT
// ============================================================================

/** Configuration par défaut pour les paramètres techniques */
export const DEFAULT_TECHNICAL_CONFIG: TechnicalConfig = {
  ha: {
    ws_enable: false,
    mqtt_enable: false,
    ws: {
      host: "",
      port: 8123,
      token: "",
      reconnect_delay: 5,
    },
    structure: {
      include_unassigned: false,
      unassigned_label: "Non assigné",
    },
  },
  web: {
    port: 8080,
    host: "0.0.0.0",
  },
  logging: {
    level: "info",
    rotate: {
      max_size_mb: 10,
      max_files: 5,
    },
  },
};

// ============================================================================
// UTILITAIRES
// ============================================================================

/**
 * Vérifie si une application est de type "intégration" (nécessite HA WS ou MQTT)
 * Basé sur la présence de ha.mqtt_enable ou ha.ws_enable dans la config
 */
export function isIntegrationApp(config: AppConfig): boolean {
  return config.ha?.mqtt_enable === true || config.ha?.ws_enable === true;
}

/**
 * Extrait les champs requis manquants d'un résultat de validation
 */
export function getRequiredMissing(config: AppConfig, validationResult: ConfigValidationResult): string[] {
  const requiredFields: string[] = [
    'ha.ws.host',
    'ha.ws.token',
  ];
  
  if (isIntegrationApp(config)) {
    requiredFields.push('mqtt.host', 'mqtt.client_id');
  }
  
  return requiredFields.filter(field => {
    const value = getNestedValue(config, field);
    return value === undefined || value === null || value === '';
  });
}

/**
 * Récupère une valeur imbriquée par son chemin (ex: "ha.ws.host")
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      return record[key];
    }
    return undefined;
  }, obj as unknown);
}

/**
 * Définit une valeur imbriquée par son chemin
 */
export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys: string[] = path.split('.').filter((k): k is string => k.length > 0);
  if (keys.length === 0) return;
  
  let current: Record<string, unknown> = obj;
  
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const existing = current[key] as unknown;
    if (!existing || typeof existing !== 'object' || existing === null) {
      current[key] = {};
    }
    current = existing as Record<string, unknown>;
  }
  
  const finalKey: string = keys[keys.length - 1]!;
  const numericFields = ['port', 'reconnect_delay', 'keepalive', 'max_size_mb', 'max_files'] as const;
  current[finalKey] = numericFields.includes(finalKey as never) ? Number(value) : value;
}
