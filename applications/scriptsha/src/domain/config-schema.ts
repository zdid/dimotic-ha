/**
 * Schéma de configuration pour l'application scriptsha — minimal, aucun réglage de connexion
 * propre (l'app ne parle jamais HA/MQTT directement, seulement via le pont générique HaRestBridge
 * du core, voir domain/index.ts).
 */

import { z } from 'zod';

// ⭐ 06/09/2026 — plus de champ `enabled` : jamais lu nulle part (l'activation réelle passe par
// `core.disabledApps`), voir le commentaire équivalent dans arbreouquoi/config-schema.ts. Objet vide
// conservé (pas de réglage propre à scriptsha) plutôt que de supprimer tout le fichier — garde le
// même patron que les autres apps (export nommé, type inféré) si un vrai réglage apparaît plus tard.
export const scriptshaConfigSchema = z.object({});

export type ScriptshaConfig = z.infer<typeof scriptshaConfigSchema>;

export const DEFAULT_SCRIPTSHA_CONFIG: ScriptshaConfig = {};
