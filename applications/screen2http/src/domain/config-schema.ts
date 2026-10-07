/**
 * Schéma de configuration de l'application SCREEN2HTTP (section `screen2http` de
 * data/screen2http/config.yaml), édité dans Paramètres Techniques.
 *
 * Connexion SSH avec la clé de l'utilisateur qui lance l'application (~/.ssh/id_ed25519, id_ecdsa,
 * id_rsa, ou son agent ssh) — `privateKeyPath` ne sert qu'à imposer une autre clé pour une cible.
 */

import { z } from 'zod';

const targetConfigSchema = z.object({
  /** Identifiant libre, unique — utilisé dans le protocole Socket.io. */
  id: z.string().min(1),
  /** Nom affiché dans le sélecteur de la page (défaut : id). */
  label: z.string().default(''),
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).default('root'),
  /** Nom de la session screen à rejoindre (`screen -xS <nom>`) ; vide = `screen -x` sans nom. */
  screenName: z.string().default(''),
  /** Clé privée spécifique ; vide = clé de l'utilisateur qui lance l'application. */
  privateKeyPath: z.string().default('')
});

export const screen2httpConfigSchema = z.object({
  targets: z.array(targetConfigSchema).default([]),
  /** Intervalle de keepalive SSH (ms). */
  keepaliveInterval: z.number().int().min(1000).default(10000),
  /** Délai de connexion SSH (ms). */
  readyTimeout: z.number().int().min(1000).default(20000),
  /** Une session sans battement de cœur du navigateur depuis ce délai (s) est fermée (onglet fermé, plantage). */
  sessionTimeoutSeconds: z.number().int().min(15).default(60)
})
  .refine(
    (config) => new Set(config.targets.map((t) => t.id)).size === config.targets.length,
    { message: 'Chaque cible doit avoir un id unique', path: ['targets'] }
  );

export type Screen2HttpConfig = z.infer<typeof screen2httpConfigSchema>;
export type Screen2HttpTargetConfig = z.infer<typeof targetConfigSchema>;

export const DEFAULT_SCREEN2HTTP_CONFIG: Screen2HttpConfig = {
  targets: [],
  keepaliveInterval: 10000,
  readyTimeout: 20000,
  sessionTimeoutSeconds: 60
};
