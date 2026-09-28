/**
 * Configuration et règles de TASMOTA (fonctionnelles-tasmota_specs §9).
 * config.yaml (section `tasmota`) + rules.yaml, dans data/tasmota/ — sans préfixe `machine_`, donc reproduits
 * sur toutes les machines quand la diffusion du core existera (D7, pas encore implémentée : locaux d'ici là).
 */

import { z } from 'zod';

export const tasmotaConfigSchema = z.object({
  /** Wi-Fi donné aux Tasmota neufs — mot de passe EN CLAIR (décision D6). */
  wifi: z.object({
    ssid: z.string().max(32).default('zdid2'),
    password: z.string().max(64).default('')
  }).default({}),
  /** Broker donné aux neufs et proposé dans la fiche. */
  mqtt: z.object({
    host: z.string().min(1).max(253).default('192.168.1.51'),
    port: z.coerce.number().int().min(1).max(65535).default(1883)
  }).default({}),
  /** Sites proposés : 2e niveau du FullTopic (%prefix%/<site>/%topic%/). */
  sites: z.array(z.string().regex(/^[a-z0-9_]{1,32}$/)).default(['maison', 'cuisine_ete', 'garage', 'exterieur']),
  latitude: z.coerce.number().min(-90).max(90).default(45.4609),
  longitude: z.coerce.number().min(-180).max(180).default(-0.718),
  /** Modes proposés (entité select dans HA). */
  modes: z.array(z.string().min(1).max(32)).min(1).default(['présence', 'absence', 'confort', 'éco']),
  /** Publication des découvertes HA. */
  publishToHa: z.boolean().default(true)
});

export type TasmotaConfig = z.infer<typeof tasmotaConfigSchema>;

export const ruleInstanceSchema = z.object({
  slot: z.coerce.number().int().min(1).max(3),
  template: z.string().min(1).max(32),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** Modes où la règle est active ; vide = tous. */
  modes: z.array(z.string()).default([]),
  enabled: z.boolean().default(true)
});

export type RuleInstance = z.infer<typeof ruleInstanceSchema>;

/** rules.yaml : règles par MAC (12 hexadécimaux majuscules). */
export const rulesFileSchema = z.record(z.string().regex(/^[0-9A-F]{12}$/), z.array(ruleInstanceSchema)).default({});

export type RulesFile = z.infer<typeof rulesFileSchema>;
