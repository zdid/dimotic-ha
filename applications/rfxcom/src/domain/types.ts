/**
 * Types du domaine RFXCOM
 *
 * Conforme à fonctionnelles-rfxcom_specs_v5.6.md §2/§4/§6, recepteurs-emetteurs-rfxcom_specs_v5.1.md
 * §3/§6/§10, classification-rfxcom_specs_v1.0.md.
 */

// ============================================================================
// Message brut normalisé (après mapping depuis la bibliothèque npm `rfxcom`)
// ============================================================================

/** Types de devices RFXCOM gérés (fonctionnelles-rfxcom_specs §4). */
export type RfxComDeviceType =
  | 'RFXSensor'
  | 'RFXMeter'
  | 'Lighting1'
  | 'Lighting2'
  | 'Lighting4'
  | 'Lighting5'
  | 'Lighting6'
  | 'Blinds1';

/**
 * Message RF433 normalisé, produit par RfxComTransceiver à partir de l'événement
 * `device` de la bibliothèque npm `rfxcom` (fonctionnelles-rfxcom_specs §6.1).
 */
export interface RfxComRawMessage {
  type: RfxComDeviceType;
  subType: string;
  sensorId: string;             // "0x...", toujours en majuscules
  /** Code d'unité/canal (Lighting2 notamment) — absent pour les capteurs simples. */
  unitCode?: number;
  /**
   * Identifiant déjà au format attendu par les méthodes de la classe Transmitter correspondante
   * pour RENVOYER une commande (ex: Lighting2 → "0xID/unitCode", Lighting1 → "A1"
   * houseCode+unitCode) — le format diffère par protocole, calculé une fois ici par
   * RfxComTransceiver plutôt que reconstruit ailleurs. Absent pour les capteurs (non pilotables).
   */
  commandDeviceId?: string;
  seqNbr: number;
  /** Valeur brute rssi de la bibliothèque rfxcom, échelle 0-15 (PAS des dBm). */
  signalLevel: number;
  /** Valeur brute batterie de la bibliothèque rfxcom, échelle 0-9 ou 0-15 selon le protocole. */
  batteryLevel: number;
  data: Record<string, unknown>;
  timestamp: Date;
}

// ============================================================================
// Devices RFXCOM physiques (config-rfxcom-devices-v1.0.yaml — rfxcom_devices)
// ============================================================================

/**
 * Device RFXCOM physique tel que persisté dans le fichier de configuration centralisé.
 * `uniqueId` = `<protocole>_<sensorId>` (fonctionnelles-rfxcom_specs §2.2).
 */
export interface RfxComDeviceInfo {
  uniqueId: string;             // <protocole>_<sensorId>, ex: "lighting2_0x02b3"
  sensorId: string;             // "0x02B3"
  type: RfxComDeviceType;
  subType: string;
  protocole: string;            // "lighting2", "rfxsensor", ...
  /** QUOI---OÙ (nommage_specs_v1.0), "QUOI---[à compléter]" tant que le OÙ n'est pas saisi. */
  name: string;
  defaultQuoi: string;          // Auto-déterminé depuis subType (classification-rfxcom_specs §4)
  /** ⭐ v5.4 — conditionne l'envoi vers HA, indépendamment de QUOI/OÙ (fonctionnelles-rfxcom_specs §9.1). */
  transmitToHa: boolean;
  /** Code d'unité par défaut utilisé pour l'encodage deviceId (§8.5.1), si applicable. */
  unitCode?: number;
  /** Voir RfxComRawMessage.commandDeviceId — absent pour les devices non pilotables (capteurs). */
  commandDeviceId?: string;
  lastSeen?: string;            // ISO8601, mis à jour à chaque réception
}

/** Device détecté par scan mais pas encore paramétré (en mémoire uniquement, jamais persisté). */
export interface RfxComDiscoveredDevice {
  sensorId: string;
  type: RfxComDeviceType;
  subType: string;
  uniqueId: string;
  defaultQuoi: string;
  unitCode?: number;
  detectedAt: string;
}

// ============================================================================
// Récepteurs logiques (config-rfxcom-devices-v1.0.yaml — rfxcom_receivers)
// ============================================================================

export type ReceiverType = 'switch' | 'light' | 'cover' | 'scene';
export type CoverType = 'Curtain1' | 'Curtain2' | 'Curtain3' | 'Blind1' | 'Blind2' | 'Blind3';
export type EmitterAction = 'toggle' | 'on' | 'off' | 'set_level' | 'open' | 'close' | 'stop';

/** Émetteur associé à un récepteur — appairage N↔N (recepteurs-emetteurs-rfxcom_specs §4.2). */
export interface AssociatedEmitter {
  emitterId: string;            // <protocole>_<sensorId>
  action: EmitterAction;
  value?: number;                // 0-100%, pour set_level
}

export interface SceneAction {
  target: string;                // receiverId
  command: string;
  value?: number;
  delayMs?: number;
}

export interface BaseReceiverConfig {
  receiverId: string;             // recepteur_<seq>
  name: string;                   // QUOI---OÙ
  primaryEmitter: string;         // Émetteur principal pour les commandes HA→RFXCOM
  emitters: AssociatedEmitter[];
  transmitToHa: boolean;
  icon?: string;
}

export interface ReceiverSwitchConfig extends BaseReceiverConfig {
  type: 'switch';
}

export interface ReceiverLightConfig extends BaseReceiverConfig {
  type: 'light';
  isDimmable: boolean;
  defaultLevel?: number;          // 0-100%
}

export interface ReceiverCoverConfig extends BaseReceiverConfig {
  type: 'cover';
  coverType: CoverType;
  openTimeSec: number;            // ⭐ obligatoire
  closeTimeSec: number;           // ⭐ obligatoire
}

/**
 * Une scène n'a ni primaryEmitter ni emitters (elle ne réagit pas à un appairage RF433, elle
 * pilote d'autres récepteurs) — ne dérive donc pas de BaseReceiverConfig, contrairement aux
 * switch/light/cover (fonctionnelles-rfxcom_specs §14.3.1).
 */
export interface ReceiverSceneConfig {
  receiverId: string;              // scene_<seq>
  name: string;                    // QUOI---OÙ
  type: 'scene';
  transmitToHa: boolean;
  icon?: string;
  description?: string;
  sceneType: 'parallel' | 'sequential';
  delayBetweenCommands?: number;  // ms, défaut 500
  actions: SceneAction[];
}

/** Récepteurs pilotables via un primaryEmitter — tout ReceiverConfig sauf les scènes. */
export type CommandableReceiverConfig =
  | ReceiverSwitchConfig
  | ReceiverLightConfig
  | ReceiverCoverConfig;

export type ReceiverConfig = CommandableReceiverConfig | ReceiverSceneConfig;

/** État courant d'un récepteur cover (fonctionnelles-rfxcom_specs §16.4). */
export interface CoverRuntimeState {
  state: 'up' | 'down' | 'intermediate';
  position: number;               // 0-100
  lastCommandAt: number;          // epoch ms, pour le calcul position = f(temps écoulé)
}

// ============================================================================
// Fichier de configuration centralisé (config-rfxcom-devices-v1.0.yaml)
// ============================================================================

export interface RfxComDevicesConfig {
  rfxcom_devices: Record<string, RfxComDeviceInfo>;
  rfxcom_receivers: Record<string, ReceiverConfig>;
}

// ============================================================================
// Statut / commandes exposés à l'UI et au socle
// ============================================================================

export interface RfxComStatus {
  connected: boolean;
  devicesCount: number;
  receiversCount: number;
  lastDiscovery: string | null;
  scanInProgress: boolean;
  error?: string;
}

export interface RfxComCommand {
  receiverId: string;
  action: string;
  value?: number;
  timestamp: string;
}

export interface SceneExecutionResult {
  sceneId: string;
  success: boolean;
  executedCommands: number;
  failedCommands: number;
  errors: Array<{ receiverId: string; action: string; error: string }>;
  duration: number;
}
