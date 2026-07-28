/**
 * Schéma de validation Zod pour le fichier de configuration centralisé
 * config-evoo7-donnees-v1.0.yaml (43 données EVOO7).
 */

import { z } from 'zod';

export const evoo7ValeurPossibleSchema = z.object({
  code: z.string().min(1),
  libelle: z.string().min(1)
});

export const evoo7DataDefinitionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  min: z.number().optional(),
  max: z.number().optional(),
  valeursPossibles: z.array(evoo7ValeurPossibleSchema).optional(),

  updatable: z.boolean(),
  isConfigData: z.boolean(),

  consultation: z.boolean().default(false),
  miseAJour: z.boolean().default(false),
  topicSensor: z.string().min(1),
  formatMessageSensor: z.string().min(1),

  taxonomieQuoi: z.string().optional(),
  taxonomieLieuPrecis: z.string().optional(),
  taxonomieLieu: z.string().optional(),
  taxonomiePere: z.string().optional(),
  taxonomieGrandPere: z.string().optional(),

  deviceClass: z.string().optional(),
  unitOfMeasurement: z.string().optional(),

  forcedComponent: z.string().optional(),
  payloadOn: z.string().optional(),
  payloadOff: z.string().optional()
});

/** Entité `climate` composite (thermostat) — regroupe plusieurs données EVOO7 existantes. */
export const evoo7ThermostatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowCooling: z.boolean().default(false)
});

export const evoo7DonneesConfigSchema = z
  .object({
    evoo7_donnees: z.record(evoo7DataDefinitionSchema).default({}),
    thermostat: evoo7ThermostatConfigSchema.default({ enabled: false, allowCooling: false })
  })
  .refine(
    (config) => {
      const ids = Object.values(config.evoo7_donnees).map((d) => d.id);
      return new Set(ids).size === ids.length;
    },
    { message: 'Chaque donnée doit avoir un id unique', path: ['evoo7_donnees'] }
  );

export type Evoo7DataDefinitionEntry = z.infer<typeof evoo7DataDefinitionSchema>;
export type Evoo7ThermostatConfigEntry = z.infer<typeof evoo7ThermostatConfigSchema>;
export type Evoo7DonneesConfigFile = z.infer<typeof evoo7DonneesConfigSchema>;

export const DEFAULT_DONNEES_CONFIG: Evoo7DonneesConfigFile = {
  evoo7_donnees: {},
  thermostat: { enabled: false, allowCooling: false }
};
