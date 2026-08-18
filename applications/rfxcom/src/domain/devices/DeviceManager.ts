/**
 * DeviceManager
 *
 * Registre des devices RFXCOM physiques : deux listes distinctes (fonctionnelles-rfxcom_specs
 * §11.2) — "paramétrés" (persistés dans config-rfxcom-devices-v1.0.yaml) et "auto-discovery"
 * (en mémoire uniquement pendant la session, jamais persistés tant qu'ils ne sont pas paramétrés).
 *
 * Couche : Domaine — pas de dépendance MQTT/EventBus/YAML (RfxComService fait le pont).
 */

import type { Logger } from '../../../../core/dist/exports';
import { determineQuoi, getProtocole } from '../classification';
import type { RfxComDeviceInfo, RfxComDiscoveredDevice, RfxComRawMessage } from '../types';

export class DeviceManager {
  private configuredDevices: Map<string, RfxComDeviceInfo> = new Map();
  private discoveredDevices: Map<string, RfxComDiscoveredDevice> = new Map();

  constructor(private readonly logger: Logger) {}

  // ==========================================================================
  // Chargement / accès
  // ==========================================================================

  loadConfigured(devices: Record<string, RfxComDeviceInfo>): void {
    this.configuredDevices.clear();
    for (const [uniqueId, device] of Object.entries(devices)) {
      this.configuredDevices.set(uniqueId, device);
    }
    this.logger.info('DeviceManager', `${this.configuredDevices.size} device(s) paramétré(s) chargé(s)`);
  }

  getConfiguredDevices(): RfxComDeviceInfo[] {
    return Array.from(this.configuredDevices.values());
  }

  getConfiguredDevicesRecord(): Record<string, RfxComDeviceInfo> {
    return Object.fromEntries(this.configuredDevices);
  }

  getDiscoveredDevices(): RfxComDiscoveredDevice[] {
    return Array.from(this.discoveredDevices.values());
  }

  getDevice(uniqueId: string): RfxComDeviceInfo | undefined {
    return this.configuredDevices.get(uniqueId);
  }

  // ==========================================================================
  // Traitement des messages RF433
  // ==========================================================================

  /**
   * Traite un message RF433 normalisé : si le device est déjà paramétré, met à jour lastSeen
   * (et commandDeviceId, qui peut varier d'un message à l'autre pour un même émetteur logique
   * — improbable mais sans coût de le rafraîchir). Sinon, l'ajoute (ou le met à jour) dans la
   * liste auto-discovery, en mémoire seulement.
   */
  handleRawMessage(message: RfxComRawMessage): { uniqueId: string; isNew: boolean } {
    const protocole = getProtocole(message.type);
    // unitCode distingue les boutons d'une même télécommande multi-unités (ex: HomeEasy AC 2 ou
    // 4 boutons, tous sur le même sensorId/house code) — sans lui, tous les boutons d'une même
    // télécommande physique collisionnaient sur le même uniqueId, rendant impossible de les
    // associer à des récepteurs différents. Absent pour les devices sans notion d'unité
    // (capteurs, compteurs), donc suffixe omis dans ce cas.
    const unitSuffix = message.unitCode !== undefined ? `_${message.unitCode}` : '';
    // subType distingue les entités multiples d'un même capteur physique (ex: un capteur TH9
    // "baromètre" envoie Temperature ET Humidity avec le même sensorId — sans le subType dans
    // l'id, la seconde lecture écraserait silencieusement la première au lieu de créer une
    // entité séparée). Cohérent avec buildStateDeviceId() (classification.ts) qui inclut déjà
    // le subType pour la même raison.
    const uniqueId = `${protocole}_${message.subType.toLowerCase()}_${message.sensorId.toLowerCase()}${unitSuffix}`;

    const configured = this.configuredDevices.get(uniqueId);
    if (configured) {
      configured.lastSeen = message.timestamp.toISOString();
      if (message.commandDeviceId) {
        configured.commandDeviceId = message.commandDeviceId;
      }
      return { uniqueId, isNew: false };
    }

    const alreadyDiscovered = this.discoveredDevices.has(uniqueId);
    this.discoveredDevices.set(uniqueId, {
      sensorId: message.sensorId,
      type: message.type,
      subType: message.subType,
      uniqueId,
      defaultQuoi: determineQuoi(message.type, message.subType),
      unitCode: message.unitCode,
      detectedAt: message.timestamp.toISOString()
    });

    if (!alreadyDiscovered) {
      this.logger.info('DeviceManager', `Nouveau device détecté: ${uniqueId} (${message.type}/${message.subType})`);
    }

    return { uniqueId, isNew: !alreadyDiscovered };
  }

  /** Supprime tous les devices auto-découverts non paramétrés (fonctionnelles-rfxcom_specs §11.2 toolbar). */
  clearUnconfigured(): number {
    const count = this.discoveredDevices.size;
    this.discoveredDevices.clear();
    return count;
  }

  /**
   * Paramètre un device : le fait passer d'auto-discovery (ou crée un nouveau) vers la liste
   * paramétrée, avec son nom QUOI---OÙ complet. `transmitToHa` défaut à false (fonctionnelles-
   * rfxcom_specs §12.5 : "sauvegardés avec transmitToHa à false" — l'utilisateur l'active ensuite).
   */
  setDeviceName(uniqueId: string, name: string): RfxComDeviceInfo {
    const discovered = this.discoveredDevices.get(uniqueId);
    const existing = this.configuredDevices.get(uniqueId);

    const device: RfxComDeviceInfo = existing
      ? { ...existing, name }
      : {
          uniqueId,
          sensorId: discovered?.sensorId ?? uniqueId,
          type: discovered?.type ?? 'RFXSensor',
          subType: discovered?.subType ?? 'Unknown',
          protocole: getProtocole(discovered?.type ?? 'RFXSensor'),
          name,
          defaultQuoi: discovered?.defaultQuoi ?? '',
          transmitToHa: false,
          unitCode: discovered?.unitCode
        };

    this.configuredDevices.set(uniqueId, device);
    this.discoveredDevices.delete(uniqueId);

    return device;
  }

  /**
   * Crée un device SANS passer par la découverte RF — cas d'un protocole qui ne remonte jamais
   * de signal reçu (Rfy/Somfy RTS, voir fonctionnelles-rfxcom_specs §17ter). Contrairement à
   * setDeviceName(), ne dépend pas de discoveredDevices : tous les champs sont fournis
   * explicitement par l'appelant (RfxComService, depuis le payload Socket.io). `commandDeviceId`
   * est calculé ici (format "sensorId/unitCode", identique à Lighting2) plutôt que reconstruit
   * plus tard — un device Rfy n'ayant jamais de trame RF reçue pour le déduire autrement.
   */
  createManualDevice(params: {
    sensorId: string;
    type: RfxComDeviceInfo['type'];
    subType: string;
    protocole: string;
    unitCode: number;
    name: string;
  }): RfxComDeviceInfo {
    const uniqueId = `${params.protocole}_${params.subType.toLowerCase()}_${params.sensorId.toLowerCase()}_${params.unitCode}`;
    const device: RfxComDeviceInfo = {
      uniqueId,
      sensorId: params.sensorId,
      type: params.type,
      subType: params.subType,
      protocole: params.protocole,
      name: params.name,
      defaultQuoi: determineQuoi(params.type, params.subType),
      transmitToHa: false,
      unitCode: params.unitCode,
      commandDeviceId: `${params.sensorId}/${params.unitCode}`
    };
    this.configuredDevices.set(uniqueId, device);
    this.logger.info('DeviceManager', `Device créé manuellement: ${uniqueId}`);
    return device;
  }

  setTransmitToHa(uniqueId: string, transmitToHa: boolean): RfxComDeviceInfo | undefined {
    const device = this.configuredDevices.get(uniqueId);
    if (!device) return undefined;
    device.transmitToHa = transmitToHa;
    return device;
  }

  deleteDevice(uniqueId: string): boolean {
    return this.configuredDevices.delete(uniqueId);
  }
}
