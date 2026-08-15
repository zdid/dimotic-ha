/**
 * Schéma de configuration RFXCOM — section `rfxcom` de data/config.yaml.
 * Paramètres généraux uniquement (port série, MQTT via le socle, fichier de devices) —
 * les devices/récepteurs/scènes sont dans config-rfxcom-devices-v1.0.yaml
 * (voir devices-config-schema.ts), conforme à fonctionnelles-rfxcom_specs_v5.6.md §8.1.
 */

import { z } from 'zod';

export const rfxcomConfigSchema = z.object({
  enabled: z.boolean().default(true),

  // Port série du transceiver RFXtrx433
  port: z.string().min(1).default('/dev/ttyUSB0'),
  baudRate: z.number().int().positive().default(38400),

  // bridge_instance utilisé pour la connexion MQTT au socle (techniques-socle-ha-mqtt_specs §8.5.1).
  // Ce défaut fixe n'est en pratique jamais appliqué : RfxComService.loadConfig() génère et
  // persiste un tirage aléatoire au premier démarrage avant que ce schéma ne soit parsé (voir
  // fonctionnelles-supervisor_specs v2.3 §9.2) — conservé ici comme filet, pas comme vrai défaut.
  bridgeInstance: z.string().min(1).default('rfx_bridge_0001'),

  // Fichier de configuration centralisé (devices/récepteurs/scènes), relatif à la racine du projet
  devicesConfigFile: z.string().min(1).default('config-rfxcom-devices-v1.0.yaml'),

  // Détection continue des nouveaux devices RF433 (fonctionnelles-rfxcom_specs §11.2)
  autoDiscovery: z.boolean().default(true),

  // Protocoles matériel RFXtrx433 (granularité X10/ARC/AC/OREGON/..., voir
  // node_modules/rfxcom/lib/index.js::protocols_RFXtrx433) à pousser AU MATÉRIEL, en une seule
  // fois via le bouton dédié de l'onglet Protocoles — pour la session en cours uniquement (RAM),
  // jamais écrit en EEPROM du RFXtrx433. Liste vide = tous les protocoles gérables par ce
  // récepteur sont poussés par défaut. Seul mécanisme de filtrage de protocoles restant (un filtre
  // logiciel après décodage existait ici auparavant — retiré le 2026-07-26).
  enabledHardwareProtocols: z.array(z.string()).default([]),

  // Si activé (par défaut) : aucune découverte MQTT n'est publiée tant que le référentiel HA
  // (WS) n'est pas synchronisé — garantit que suggested_area peut réellement créer/assigner
  // l'area dès la création de l'entité (HA n'applique suggested_area qu'une seule fois, jamais
  // rétroactivement). Sans ça, des entités créées avant que l'area existe restent SANS area de
  // façon définitive — réaffectation manuelle requise, coûteuse à grande échelle (350+ récepteurs
  // RFXCOM). Désactiver accepte ce risque en échange d'un démarrage qui ne dépend pas de HA WS.
  waitForHaWsBeforeDiscovery: z.boolean().default(true)
});

export type RfxComConfig = z.infer<typeof rfxcomConfigSchema>;

export const DEFAULT_RFXCOM_CONFIG: RfxComConfig = {
  enabled: true,
  port: '/dev/ttyUSB0',
  baudRate: 38400,
  bridgeInstance: 'rfx_bridge_0001',
  devicesConfigFile: 'config-rfxcom-devices-v1.0.yaml',
  autoDiscovery: true,
  enabledHardwareProtocols: [],
  waitForHaWsBeforeDiscovery: true
};
