/**
 * Schéma de validation Zod pour le fichier de configuration centralisé
 * config-rfxcom-devices-v1.0.yaml (devices physiques + récepteurs logiques).
 *
 * Conforme à recepteurs-emetteurs-rfxcom_specs_v5.1.md §5.3.
 */

import { z } from 'zod';

// ============================================================================
// Devices RFXCOM physiques
// ============================================================================

export const rfxComDeviceTypeSchema = z.enum([
  'RFXSensor',
  'RFXMeter',
  'Lighting1',
  'Lighting2',
  'Lighting4',
  'Lighting5',
  'Lighting6',
  'Blinds1'
]);

export const rfxComDeviceSchema = z.object({
  uniqueId: z.string().min(1),
  sensorId: z.string().min(1),
  type: rfxComDeviceTypeSchema,
  subType: z.string().min(1),
  protocole: z.string().min(1),
  name: z.string().min(1),
  defaultQuoi: z.string().min(1),
  transmitToHa: z.boolean().default(false),
  unitCode: z.number().int().optional(),
  lastSeen: z.string().optional()
});

// ============================================================================
// Émetteurs associés / appairages
// ============================================================================

export const associatedEmitterSchema = z.object({
  emitterId: z.string().min(1),
  action: z.enum(['toggle', 'on', 'off', 'set_level', 'open', 'close', 'stop']),
  value: z.number().min(0).max(100).optional()
});

export const sceneActionSchema = z.object({
  target: z.string().min(1),
  command: z.string().min(1),
  value: z.number().optional(),
  delayMs: z.number().int().nonnegative().optional()
});

// ============================================================================
// Récepteurs logiques (union discriminée par type)
// ============================================================================

const baseReceiverFields = {
  receiverId: z.string().min(1),
  name: z.string().min(1),
  primaryEmitter: z.string().min(1),
  emitters: z.array(associatedEmitterSchema).default([]),
  transmitToHa: z.boolean().default(false),
  icon: z.string().optional()
};

export const receiverSwitchSchema = z.object({
  type: z.literal('switch'),
  ...baseReceiverFields,
  // Sans ces deux champs, Zod les retire silencieusement au rechargement (clés inconnues
  // supprimées par défaut) — chaque récepteur repart alors avec un état interne "off" par
  // défaut, que RfxComService pousse vers le matériel réel : rafale de commandes OFF sur
  // tous les récepteurs à chaque redémarrage (voir recepteurs-emetteurs-rfxcom_specs §4.3,
  // constaté en conditions réelles le 07/08/2026 lors du déploiement sur l'OrangePi).
  lastOn: z.boolean().optional()
});

export const receiverLightSchema = z.object({
  type: z.literal('light'),
  ...baseReceiverFields,
  isDimmable: z.boolean().default(false),
  defaultLevel: z.number().min(0).max(100).optional(),
  lastOn: z.boolean().optional(),
  lastLevel: z.number().min(0).max(100).optional()
});

export const receiverCoverSchema = z.object({
  type: z.literal('cover'),
  ...baseReceiverFields,
  coverType: z.enum(['Curtain1', 'Curtain2', 'Curtain3', 'Blind1', 'Blind2', 'Blind3']),
  openTimeSec: z.number().positive(),
  closeTimeSec: z.number().positive()
});

export const receiverSceneSchema = z.object({
  type: z.literal('scene'),
  receiverId: z.string().min(1),
  name: z.string().min(1),
  transmitToHa: z.boolean().default(false),
  icon: z.string().optional(),
  description: z.string().optional(),
  sceneType: z.enum(['parallel', 'sequential']).default('sequential'),
  delayBetweenCommands: z.number().int().nonnegative().default(500),
  actions: z.array(sceneActionSchema).min(1)
});

export const receiverConfigSchema = z.discriminatedUnion('type', [
  receiverSwitchSchema,
  receiverLightSchema,
  receiverCoverSchema,
  receiverSceneSchema
]);

// ============================================================================
// Fichier complet
// ============================================================================

export const rfxComDevicesConfigSchema = z
  .object({
    rfxcom_devices: z.record(rfxComDeviceSchema).default({}),
    rfxcom_receivers: z.record(receiverConfigSchema).default({})
  })
  .refine(
    (config) => {
      const ids = Object.values(config.rfxcom_receivers).map((r) => r.receiverId);
      return new Set(ids).size === ids.length;
    },
    { message: 'Chaque récepteur doit avoir un receiverId unique', path: ['rfxcom_receivers'] }
  );

export type RfxComDeviceEntry = z.infer<typeof rfxComDeviceSchema>;
export type ReceiverConfigEntry = z.infer<typeof receiverConfigSchema>;
export type RfxComDevicesConfigFile = z.infer<typeof rfxComDevicesConfigSchema>;

export const DEFAULT_DEVICES_CONFIG: RfxComDevicesConfigFile = {
  rfxcom_devices: {},
  rfxcom_receivers: {}
};
