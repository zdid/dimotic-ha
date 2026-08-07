/**
 * Types spécifiques à l'application NOMMAGE
 * Gestion des conventions de nommage et taxonomie (QUOI/OÙ)
 */

import type { HaStructuredEntity } from '../../../core/dist/exports';

// ============================================================================
// Types pour le parsing QUOI/OÙ (basé sur nommage_specs_v1.0.md)
// ============================================================================

/**
 * Structure extraite d'un message de découverte MQTT
 * Format attendu : "quoi---lieu_precis--lieu--lieu_pere--lieu_grand_pere"
 */
export interface DiscoveryMessage {
  // ⭐ v1.1 — Identifiant de la source MQTT d'origine (config.sources[].id)
  sourceId: string;

  // Partiel : Chaîne brute reçue dans le payload MQTT
  rawName: string;

  // QUOI (Type de l'appareil)
  rawQuoi: string;
  slugQuoi: string;

  // OÙ (Hiérarchie géographique)
  rawLieux: string;
  lieuxSegments: string[];

  // Niveaux géographiques (null si non présent)
  nomPrecis?: string;
  slugPrecis?: string;

  nomLieu?: string;          // ⭐ OBLIGATOIRE (Pièce/Area HA)
  slugLieu?: string;

  nomPere?: string;          // Étage/Floor HA
  slugPere?: string;

  nomGrandPere?: string;     // Bâtiment/Label HA
  slugGrandPere?: string;

  // Métadonnées du message MQTT — topic d'origine, préfixe NON modifié (utilisé pour le passthrough)
  topic: string;
  payload: Record<string, unknown>;
  timestamp: Date;
}

/**
 * Résultat du parsing et classification
 */
export interface ParsedTaxonomy {
  // QUOI
  quoi: {
    raw: string;
    slug: string;
  };
  
  // OÙ (structuré)
  ou: {
    precis?: TaxonomyLevel;
    lieu?: TaxonomyLevel;       // ⭐ OBLIGATOIRE
    pere?: TaxonomyLevel;
    grandPere?: TaxonomyLevel;
  };
  
  // Pour l'intégration HA
  haAreaId?: string;           // Area ID à créer dans HA
  haAreaName?: string;        // Nom de l'Area
  haEntityId?: string;        // entity_id suggérée
  haDeviceClass?: string;    // Classe de l'entité HA
  
  // Attributs à injecter dans HA (via MQTT Discovery)
  haAttributes: {
    attributs_taxonomie: {
      quoi: string;
      slug_quoi: string;
      lieu_precis?: string;
      slug_precis?: string;
      lieu_principal?: string;
      slug_lieu?: string;
      lieu_pere?: string;
      slug_pere?: string;
      lieu_grand_pere?: string;
      slug_grand_pere?: string;
    };
    // Autres attributs à transmettre
    [key: string]: unknown;
  };
  
  // Source
  sourceTopic: string;
  sourcePayload: Record<string, unknown>;
}

/**
 * Niveau de taxonomie (avec raw et slug)
 */
export interface TaxonomyLevel {
  raw: string;
  slug: string;
}

/**
 * ⭐ v1.1 — Événement de découverte émis par NOMMAGE vers le socle, pour publication via le
 * Passthrough MQTT (mode "découverte") — voir techniques-socle-ha-mqtt_specs §8.5.6 et
 * implementation-nommage_specs §5.3. `sourceTopic` garde le préfixe d'origine (non réécrit par
 * NOMMAGE) ; c'est le socle qui le remplace par `homeassistant`.
 */
export interface PassthroughDiscoveryEvent {
  sourceTopic: string;
  payload: Record<string, unknown>;
}

/**
 * Événement de publication libre émis par NOMMAGE vers le socle (Passthrough MQTT, mode
 * "complet") — utilisé pour porter attributs_taxonomie sur un topic dédié que NOMMAGE contrôle
 * (json_attributes_topic), puisque le state_topic de l'entité relayée appartient à la source
 * tierce (son format n'est pas sous notre contrôle, contrairement à evoo7/rfxcom).
 */
export interface PassthroughPublishEvent {
  topic: string;
  payload: Record<string, unknown>;
  qos?: 0 | 1;
  retain?: boolean;
}

/**
 * Événement de découverte interne (pour l'UI/le suivi — nommage:discovery:parsed)
 */
export interface NommageDiscoveryEvent {
  type: 'nommage:discovery:parsed';
  sourceId: string;
  discoveryMessage: {
    rawName: string;
    topic: string;
    payload: Record<string, unknown>;
  };
  parsedTaxonomy: ParsedTaxonomy;
  timestamp: Date;
}

/**
 * Structure complète de la taxonomie pour une entité
 * (utilisée pour l'affichage et le filtrage)
 */
export interface TaxonomyStructure {
  entityId: string;
  taxonomy: ParsedTaxonomy;
  haEntity?: HaStructuredEntity;
  lastUpdated: Date;
}

/**
 * Événement de mise à jour de la structure globale
 */
export interface TaxonomyStructureUpdate {
  type: 'nommage:structure:updated';
  structures: TaxonomyStructure[];
  timestamp: Date;
}

// ============================================================================
// Types pour Socket.io
// ============================================================================

/**
 * ⭐ Statut d'une connexion source individuelle (fonctionnelles-nommage_specs §3.5).
 */
export interface SourceStatus {
  id: string;
  connected: boolean;
}

/**
 * ⭐ Nombre d'entrées traitées (messages de découverte parsés avec succès) pour une date donnée
 * (format ISO "AAAA-MM-JJ"). Utilisé pour l'historique glissant sur 5 jours.
 */
export interface DailyCount {
  date: string;
  count: number;
}

/**
 * Statut de l'application NOMMAGE
 */
export interface NommageStatus {
  connected: boolean;
  mqttConnected: boolean;
  discoveryTopics: string[];
  parsedMessagesCount: number;
  lastParsedAt?: Date;
  error?: string;
  // ⭐ Statut détaillé par connexion (une entrée par source configurée)
  sources: SourceStatus[];
  // ⭐ Nombre d'entrées traitées par jour, sur les 5 derniers jours (plus ancien → plus récent),
  // toujours 5 éléments (0 si aucune entrée ce jour-là)
  dailyCounts: DailyCount[];
}

/**
 * Message de log pour l'UI
 */
export interface NommageLogMessage {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: Date;
  data?: unknown;
}
