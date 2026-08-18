/**
 * Auto-détermination du QUOI depuis le type/subType RFXCOM.
 *
 * Conforme à fonctionnelles-rfxcom_specs_v5.6.md §6.2/§2.3 et classification-rfxcom_specs_v1.0.md §4/§5.
 * RfxComTransceiver normalise déjà les subType des capteurs/compteurs vers des noms génériques
 * (Temperature/Humidity/Motion/Contact/Current/Power) — voir RfxComTransceiver.ts.
 */

import type { RfxComDeviceType } from './types';

/** QUOI déterminé depuis le subType, pour les capteurs/compteurs (subType = valeur normalisée par le transceiver). */
const SUBTYPE_TO_QUOI: Record<string, string> = {
  Temperature: 'Température',
  Humidity: 'Humidité',
  Motion: 'Mouvement',
  Contact: 'Contact',
  Current: 'Courant',
  Power: 'Puissance'
};

/** QUOI déterminé depuis le type, pour les émetteurs (le subType RFXCOM — AC, X10, ... — n'influe pas sur le QUOI). */
const TYPE_TO_QUOI: Partial<Record<RfxComDeviceType, string>> = {
  Lighting1: 'Interrupteur',
  Lighting2: 'Bouton',
  Lighting4: 'Télécommande',
  Lighting5: 'Interrupteur',
  Lighting6: 'Interrupteur',
  Blinds1: 'Volet',
  Rfy: 'Volet'
};

/**
 * Détermine le QUOI auto-rempli pour un device détecté (fonctionnelles-rfxcom_specs §9.2).
 * L'utilisateur peut ensuite le modifier dans le fichier de configuration.
 */
export function determineQuoi(type: RfxComDeviceType, subType: string): string {
  if ((type === 'RFXSensor' || type === 'RFXMeter') && SUBTYPE_TO_QUOI[subType]) {
    return SUBTYPE_TO_QUOI[subType];
  }
  return TYPE_TO_QUOI[type] ?? subType;
}

/** Nom de protocole (minuscules) utilisé dans les identifiants techniques `<protocole>_<sensorId>`. */
export function getProtocole(type: RfxComDeviceType): string {
  switch (type) {
    case 'RFXSensor': return 'rfxsensor';
    case 'RFXMeter': return 'rfxmeter';
    case 'Lighting1': return 'lighting1';
    case 'Lighting2': return 'lighting2';
    case 'Lighting4': return 'lighting4';
    case 'Lighting5': return 'lighting5';
    case 'Lighting6': return 'lighting6';
    case 'Blinds1': return 'blinds1';
    case 'Rfy': return 'rfy';
    default: return String(type).toLowerCase();
  }
}

/**
 * Composant HA par défaut pour un device physique (fonctionnelles-rfxcom_specs §4/§7.1).
 * Tous les émetteurs Lighting sont des binary_sensor par défaut — la variation "récepteur
 * dimmable/switch/cover" est une notion de récepteur logique, pas du device physique lui-même.
 */
export function getDefaultComponent(type: RfxComDeviceType, subType: string): { component: string; deviceClass?: string } {
  switch (type) {
    case 'RFXSensor':
      if (subType === 'Temperature') return { component: 'sensor', deviceClass: 'temperature' };
      if (subType === 'Humidity') return { component: 'sensor', deviceClass: 'humidity' };
      if (subType === 'Motion') return { component: 'binary_sensor', deviceClass: 'motion' };
      if (subType === 'Contact') return { component: 'binary_sensor', deviceClass: 'door' };
      return { component: 'sensor' };
    case 'RFXMeter':
      if (subType === 'Current') return { component: 'sensor', deviceClass: 'current' };
      if (subType === 'Power') return { component: 'sensor', deviceClass: 'power' };
      return { component: 'sensor' };
    default:
      // Lighting1/2/4/5/6 : émetteurs physiques, binary_sensor par défaut (fonctionnelles-rfxcom_specs §4.3)
      return { component: 'binary_sensor' };
  }
}

/**
 * Encode le `deviceId` utilisé dans les topics d'état/commande d'un device physique
 * (recepteurs-emetteurs-rfxcom_specs §8.5.1) : `{protocole}_{sousProtocole}__{sensorId}_{unitCode}`.
 * Distinct de `uniqueId` (`<protocole>_<sensorId>`, utilisé dans le topic de découverte HA).
 */
export function buildStateDeviceId(protocole: string, subType: string, sensorId: string, unitCode?: number): string {
  const base = `${protocole}_${subType.toLowerCase()}__${sensorId.toLowerCase()}`;
  return unitCode !== undefined ? `${base}_${unitCode}` : base;
}

/** Unité de mesure par défaut, si applicable. */
export function getDefaultUnit(subType: string): string | undefined {
  switch (subType) {
    case 'Temperature': return '°C';
    case 'Humidity': return '%';
    case 'Current': return 'A';
    case 'Power': return 'W';
    default: return undefined;
  }
}
