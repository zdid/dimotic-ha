/**
 * Configuration de l'application ESPS-ASSEMBLE (assembleur de sources ESPHome, ex-« espdisplay » — renommée le 14/10/2026).
 *
 * L'assembleur ne compile rien et ne connaît pas la machine ESPHome : il fabrique des paquets, les dépose dans son dossier partagé
 * (route de lecture du cœur) et publie une demande conservée sur le broker MQTT de SON site ; l'application `esphome` (usine, puis
 * poseur) fait le reste. Aucun secret ici hormis le mot de passe MQTT éventuel (champ masqué du formulaire).
 */

import { z } from 'zod';

const brokerSchema = z.object({
  hote: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(1883),
  utilisateur: z.string().default(''),
  motDePasse: z.string().default('')
});

export const assembleurConfigSchema = z.object({
  /** Site de cette machine : figure dans les sujets MQTT (sites étanches). */
  site: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('stfort'),
  /** Adresse de cette instance vue de l'USINE (ex. 192.168.1.51:8087) ; vide = adresse locale + port web. */
  adresseJoignable: z.string().default(''),
  mqtt: brokerSchema.default({}),
  /** Révisions de paquets conservées par appareil. */
  revisionsGardees: z.number().int().min(1).max(50).default(5)
});

export type AssembleurConfig = z.infer<typeof assembleurConfigSchema>;
export const DEFAULT_ASSEMBLEUR_CONFIG: AssembleurConfig = assembleurConfigSchema.parse({});
