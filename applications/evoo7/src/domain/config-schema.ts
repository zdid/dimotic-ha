/**
 * Schéma de configuration EVOO7 — section `evoo7` de data/config.yaml.
 * Paramètres généraux uniquement (connexion directe Socket.IO au boîtier EVOO7, bridge socle) —
 * les 43 données sont dans config-evoo7-donnees-v1.0.yaml (voir donnees-config-schema.ts).
 *
 * ⭐ 16/08/2026 — connexion directe en Socket.IO au boîtier lui-même (son protocole natif),
 * remplace l'ancien passage par un broker MQTT dédié + traducteur externe (`mqtt`/`topicCommand`/
 * `formatMessageCommand`, retirés) — voir Evoo7SocketIoClient.ts. Vérifié en conditions réelles
 * avant ce changement : `socket.io-client` doit être en v2.x précisément, la v4 ne se connecte pas
 * au boîtier (erreur de poignée de main Engine.IO, le firmware est trop ancien pour EIO4).
 */

import { z } from 'zod';

const evoo7BoxConfigSchema = z.object({
  // Défauts = adresse/identifiants réels du boîtier de ce déploiement (même convention que le
  // port série par défaut de RFXCOM) — confirmés en conditions réelles le 16/08/2026.
  address: z.string().default('192.168.1.55'),
  port: z.number().min(1).max(65535).default(80),
  user: z.string().default('domotique'),
  // Le boîtier attend le mot de passe encodé en MD5 (voir Evoo7SocketIoClient.ts) — stocké ici en
  // clair comme les autres secrets de ce projet (ex: token HA), le hachage se fait à l'envoi.
  password: z.string().default('')
});

export const evoo7ConfigSchema = z.object({
  enabled: z.boolean().default(true),

  // bridge_instance utilisé pour la connexion MQTT au socle (techniques-socle-ha-mqtt_specs §8.5.1).
  // Ce défaut fixe n'est en pratique jamais appliqué : Evoo7Service.loadConfig() génère et persiste
  // un tirage aléatoire au premier démarrage (voir fonctionnelles-supervisor_specs v2.3 §9.2).
  bridgeInstance: z.string().min(1).default('evoo7_bridge_0001'),

  // Connexion directe Socket.IO au boîtier EVOO7 (protocole natif — indépendante du broker HA du
  // socle, voir Evoo7SocketIoClient.ts).
  box: evoo7BoxConfigSchema.default({}),

  // Fichier de configuration centralisé (données), relatif à la racine du projet
  donneesConfigFile: z.string().min(1).default('config-evoo7-donnees-v1.0.yaml')
});

export type Evoo7Config = z.infer<typeof evoo7ConfigSchema>;
export type Evoo7BoxConfig = z.infer<typeof evoo7BoxConfigSchema>;

export const DEFAULT_EVOO7_CONFIG: Evoo7Config = {
  enabled: true,
  bridgeInstance: 'evoo7_bridge_0001',
  box: {
    address: '192.168.1.55',
    port: 80,
    user: 'domotique',
    password: ''
  },
  donneesConfigFile: 'config-evoo7-donnees-v1.0.yaml'
};
