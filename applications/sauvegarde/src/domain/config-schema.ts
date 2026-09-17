/**
 * Schéma de configuration Sauvegarde/Restauration — section `sauvegarde` de data/config.yaml.
 * Voir specs/current/fonctionnelles-sauvegarde_specs_v1.0.md §3bis/§4ter/§6/§6bis.
 */

import { z } from 'zod';

const sauvegardeNextcloudSchema = z.object({
  // ⭐ 17/09/2026 — juste le domaine (ex. https://dimoticloud.duckdns.org), PAS le chemin WebDAV
  // complet : le remarque de l'utilisateur ("user ne sert à rien s'il n'est pas forcé dans
  // l'adresse") a fait remplacer l'ancien champ `baseUrl` (URL WebDAV complète, redondante avec
  // `user` et risquant l'incohérence entre les deux). Le chemin WebDAV complet
  // (`/remote.php/dav/files/<user>`) est reconstruit par NextcloudWebDavClient à partir de
  // `serverUrl` + `user`, jamais saisi à la main.
  serverUrl: z.string().default(''),
  user: z.string().default(''),
  // Sous-dossier optionnel sous la racine du compte, ex. "dimotic-backups" — préfixe avant
  // <site>/<machine>/<répertoire> (§4).
  rootPath: z.string().default(''),
  // ⭐ §3bis — RÉFÉRENCE seulement, jamais la valeur : chemin HOST vers le fichier contenant le
  // mot de passe d'application Nextcloud. Volontairement hors de data/sauvegarde/ (qui serait
  // lui-même sauvegardé) — lu à l'exécution, jamais persisté ailleurs, jamais renvoyé au client.
  appPasswordFile: z.string().default('/docker/.secrets/nextcloud-backup')
});

/**
 * Un répertoire de déploiement couvert (§4/§4ter) : sert à la fois à localiser ce qui existe sur
 * Nextcloud pour lister les sauvegardes disponibles (site/machine/deploymentDir) et à savoir
 * comment arrêter/redémarrer le service lors d'une restauration sur une destination (unitName/
 * deploymentType/destinationPath). La machine de DESTINATION d'une restauration n'est volontairement
 * pas déduite d'ici — c'est un axe indépendant choisi au moment de la restauration (§6bis),
 * potentiellement une machine neuve jamais représentée dans `targets[]`.
 *
 * `host` (⭐ 17/09/2026, ajouté après coup) : uniquement pour les opérations SSH vers une machine
 * DÉJÀ connue/gérée (ex. pousser le fichier secret Nextcloud, §3bis) — jamais utilisé comme
 * destination de restauration (voir ci-dessus). Si une machine a plusieurs répertoires listés ici,
 * `host` est simplement répété sur chaque ligne — même limitation acceptée que sur les autres apps
 * (arexx/teleinfo/rpigpio), pas de déduplication.
 */
const sauvegardeTargetSchema = z.object({
  id: z.string().min(1),
  site: z.string().min(1),
  machine: z.string().min(1),
  host: z.string().default(''),
  deploymentDir: z.string().min(1),
  deploymentType: z.enum(['docker', 'raw']).default('docker'),
  unitName: z.string().min(1),
  destinationPath: z.string().min(1)
});

export const sauvegardeConfigSchema = z.object({
  nextcloud: sauvegardeNextcloudSchema.default({}),
  targets: z.array(sauvegardeTargetSchema).default([])
}).refine(
  (config) => new Set(config.targets.map((t) => t.id)).size === config.targets.length,
  { message: 'Chaque répertoire doit avoir un id unique', path: ['targets'] }
);

export type SauvegardeConfig = z.infer<typeof sauvegardeConfigSchema>;
export type SauvegardeTargetConfig = z.infer<typeof sauvegardeTargetSchema>;

export const DEFAULT_SAUVEGARDE_CONFIG: SauvegardeConfig = {
  nextcloud: {
    serverUrl: '',
    user: '',
    rootPath: '',
    appPasswordFile: '/docker/.secrets/nextcloud-backup'
  },
  targets: []
};
