/**
 * Types du domaine AREXX (capteurs BS1000/BS500).
 */

// ============================================================================
// Lecture brute normalisée (après mapping depuis un des 3 backends d'acquisition)
// ============================================================================

export type ArexxSensorKind = 'temperature' | 'humidity';

/**
 * Lecture normalisée, produite par les backends d'acquisition (push/poll/usb) à partir de leur
 * format d'origine respectif (form-encoded HTTP, table HTML, sortie du binaire rf_usb_http.elf).
 */
export interface ArexxRawReading {
  /** Identifiant matériel brut Arexx (ex: "8962"), avant préfixage. */
  rawId: string;
  kind: ArexxSensorKind;
  value: number;
  /** dBm du signal RF, si fourni par le backend. */
  signalDbm?: number;
  timestamp: Date;
}

// ============================================================================
// Capteurs AREXX (arexx-sensors-v1.0.yaml — arexx_sensors)
// ============================================================================

/** Capteur détecté par un backend d'acquisition mais pas encore paramétré (mémoire uniquement). */
export interface ArexxDiscoveredSensor {
  uniqueId: string;
  kind: ArexxSensorKind;
  detectedAt: string;
}

/** Capteur paramétré (persisté), qu'il transmette ou non vers HA. */
export interface ArexxSensorInfo {
  uniqueId: string;
  kind: ArexxSensorKind;
  /** Nom complet au format QUOI---OÙ (taxonomy.ts). */
  name: string;
  transmitToHa: boolean;
  lastValue?: number;
  lastSeen?: string;
}

// ============================================================================
// Statut
// ============================================================================

export interface ArexxStatus {
  acquisitionMode: 'push' | 'poll' | 'usb';
  running: boolean;
  sensorsCount: number;
  lastReadingAt: string | null;
  /** Port du serveur HTTP local (modes push/usb) — exposé pour la page Déploiement (§ scripts/deploy-sender.sh). */
  httpservPort: number;
  /** true si CETTE instance (le récepteur) tourne dans un conteneur Docker — voir core/infrastructure/runtime/docker.ts.
   *  Affecte le texte de la page Déploiement (préparation de l'accès SSH, §5.4bis) : la clé générée doit
   *  se trouver là où le conteneur peut la relire ensuite, pas seulement sur l'hôte. */
  isRunningInDocker: boolean;
  /** Émetteurs USB pilotables à distance (⭐ multi-cible 23/08/2026) — voir ArexxDeployService.ts. */
  targets: { id: string; host: string }[];
}
