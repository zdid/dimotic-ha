/**
 * SensorRegistry
 *
 * Registre des capteurs AREXX : deux listes distinctes, comme DeviceManager (RFXCOM) — "paramétrés"
 * (persistés dans arexx-sensors-v1.0.yaml) et "auto-discovery" (en mémoire uniquement pendant la
 * session, jamais persistés tant qu'ils ne sont pas nommés).
 *
 * Couche : Domaine — pas de dépendance MQTT/EventBus/YAML (ArexxService fait le pont).
 */

import type { Logger } from '../../../core/dist/exports';
import type { ArexxDiscoveredSensor, ArexxRawReading, ArexxSensorInfo } from './types';

export class SensorRegistry {
  private configuredSensors: Map<string, ArexxSensorInfo> = new Map();
  private discoveredSensors: Map<string, ArexxDiscoveredSensor> = new Map();

  constructor(private readonly logger: Logger) {}

  // ==========================================================================
  // Chargement / accès
  // ==========================================================================

  loadConfigured(sensors: Record<string, ArexxSensorInfo>): void {
    this.configuredSensors.clear();
    for (const [uniqueId, sensor] of Object.entries(sensors)) {
      this.configuredSensors.set(uniqueId, sensor);
    }
    this.logger.info('SensorRegistry', `${this.configuredSensors.size} capteur(s) paramétré(s) chargé(s)`);
  }

  getConfiguredSensors(): ArexxSensorInfo[] {
    return Array.from(this.configuredSensors.values());
  }

  getConfiguredSensorsRecord(): Record<string, ArexxSensorInfo> {
    return Object.fromEntries(this.configuredSensors);
  }

  getDiscoveredSensors(): ArexxDiscoveredSensor[] {
    return Array.from(this.discoveredSensors.values());
  }

  getSensor(uniqueId: string): ArexxSensorInfo | undefined {
    return this.configuredSensors.get(uniqueId);
  }

  // ==========================================================================
  // Traitement des lectures normalisées (push/poll/usb)
  // ==========================================================================

  /**
   * Traite une lecture normalisée : si le capteur est déjà paramétré, met à jour lastValue/lastSeen.
   * Sinon, l'ajoute (ou le met à jour) dans la liste auto-discovery, en mémoire seulement.
   */
  handleReading(reading: ArexxRawReading): { uniqueId: string; isNew: boolean } {
    const uniqueId = `arexx_${reading.rawId}${reading.kind === 'humidity' ? '_rh' : ''}`;

    const configured = this.configuredSensors.get(uniqueId);
    if (configured) {
      configured.lastValue = reading.value;
      configured.lastSeen = reading.timestamp.toISOString();
      return { uniqueId, isNew: false };
    }

    const alreadyDiscovered = this.discoveredSensors.has(uniqueId);
    this.discoveredSensors.set(uniqueId, {
      uniqueId,
      kind: reading.kind,
      detectedAt: reading.timestamp.toISOString()
    });

    if (!alreadyDiscovered) {
      this.logger.info('SensorRegistry', `Nouveau capteur détecté: ${uniqueId} (${reading.kind})`);
    }

    return { uniqueId, isNew: !alreadyDiscovered };
  }

  /**
   * Paramètre un capteur : le fait passer d'auto-discovery (ou crée un nouveau) vers la liste
   * paramentée, avec son nom QUOI---OÙ complet. `transmitToHa` défaut à false — l'utilisateur
   * l'active ensuite (même convention que RFXCOM DeviceManager.setDeviceName).
   */
  setSensorName(uniqueId: string, name: string): ArexxSensorInfo {
    const discovered = this.discoveredSensors.get(uniqueId);
    const existing = this.configuredSensors.get(uniqueId);

    const sensor: ArexxSensorInfo = existing
      ? { ...existing, name }
      : {
          uniqueId,
          kind: discovered?.kind ?? 'temperature',
          name,
          transmitToHa: false
        };

    this.configuredSensors.set(uniqueId, sensor);
    this.discoveredSensors.delete(uniqueId);

    return sensor;
  }

  setTransmitToHa(uniqueId: string, transmitToHa: boolean): ArexxSensorInfo | undefined {
    const sensor = this.configuredSensors.get(uniqueId);
    if (!sensor) return undefined;
    sensor.transmitToHa = transmitToHa;
    return sensor;
  }

  deleteSensor(uniqueId: string): boolean {
    return this.configuredSensors.delete(uniqueId);
  }
}
