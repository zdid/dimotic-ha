/**
 * Schéma de configuration Sauvegarde/Restauration — section `sauvegarde` de data/config.yaml.
 * Voir specs/current/fonctionnelles-sauvegarde_specs_v1.3.md §3bis/§4quater/§6/§6bis.
 */

import { z } from 'zod';

/**
 * ⭐ 17/09/2026 — chemin FIXE (plus configurable) du fichier secret sur une machine, qu'elle soit
 * la cible d'une poussée SSH (SecretPushService) ou la machine locale qui fait tourner cette
 * app elle-même. `/dimotic-secrets/` est un 3e parent dédié à la racine, au même niveau que
 * `/docker/` et `/dimotic-ha-addons/` (§4ter) — volontairement HORS des deux arborescences
 * sauvegardées, donc structurellement jamais inclus dans une sauvegarde (même principe déjà décrit
 * en §3bis, désormais appliqué avec un nom de dossier qui rejoint la convention du reste du projet
 * plutôt qu'un chemin arbitraire sous /docker/.secrets). Fixe partout : plus de champ éditable, un
 * seul comportement à documenter/attendre sur toutes les machines.
 */
export const SECRET_FILE_PATH = '/dimotic-secrets/nextcloud-backup';

const sauvegardeNextcloudSchema = z.object({
  // ⭐ 17/09/2026 — juste le domaine (ex. https://dimoticloud.duckdns.org), PAS le chemin WebDAV
  // complet : la remarque de l'utilisateur ("user ne sert à rien s'il n'est pas forcé dans
  // l'adresse") a fait remplacer l'ancien champ `baseUrl` (URL WebDAV complète, redondante avec
  // `user` et risquant l'incohérence entre les deux). Le chemin WebDAV complet
  // (`/remote.php/dav/files/<user>`) est reconstruit par NextcloudWebDavClient à partir de
  // `serverUrl` + `user`, jamais saisi à la main.
  serverUrl: z.string().default(''),
  user: z.string().default(''),
  // Sous-dossier optionnel sous la racine du compte, ex. "dimotic-backups" — préfixe avant
  // <site>/<machine>/<répertoire> (§4).
  rootPath: z.string().default('')
  // ⭐ 17/09/2026 — appPasswordFile retiré : chemin désormais fixe, voir SECRET_FILE_PATH ci-dessus.
});

/**
 * Une machine couverte par la sauvegarde (§4/§4quater) — ⭐ 17/09/2026, simplifié une TROISIÈME
 * fois sur demande explicite : une seule ligne par MACHINE, point. Le futur script hôte
 * (chantier A, différé — voir §5) sauvegarde les DEUX arborescences (`/docker` et
 * `/dimotic-ha-addons`) pour chaque machine couverte, et saute simplement celle qui n'existe pas
 * sur cette machine précise (`test -d`) — rien à déclarer ici pour distinguer les deux. Ce que
 * Nextcloud contient réellement (un sous-dossier par app, sous `docker/` et/ou
 * `dimotic-ha-addons/`, voir §4quater) se découvre en listant à la restauration (§6), jamais
 * pré-déclaré ici. La poussée du mot de passe par machine, ainsi que l'édition/ajout de cette
 * liste elle-même, vivent sur Paramètres Techniques (⭐ 17/09/2026, demande explicite — pas sur le
 * tableau de bord, revu beaucoup plus tard) : voir `secretDeployed` ci-dessous et le commentaire
 * de `SauvegardeService.handleSecretPush`.
 *
 * `id` : jamais saisi à la main — non affiché dans Paramètres Techniques (retiré des
 * `itemFields` de `SAUVEGARDE_UI_METADATA`), dérivé automatiquement de site+machine dès que ces
 * deux champs sont renseignés (voir `deriveTargetId` ci-dessous et le x-effect correspondant dans
 * `ModuleManager.generateArrayFieldHtml`, côté navigateur) — UNE FOIS seulement, jamais recalculé
 * ensuite même si site/machine changent par la suite, pour ne jamais faire diverger l'id d'une
 * ligne déjà persistée de celui que le navigateur recalculerait à l'affichage.
 *
 * `host` : pour les opérations SSH vers une machine DÉJÀ connue/gérée (ex. pousser le fichier
 * secret Nextcloud, §3bis) — jamais utilisé comme destination de restauration, qui reste un axe
 * indépendant choisi au moment de la restauration (§6bis), potentiellement une machine neuve
 * jamais représentée ici. Requis (⭐ 17/09/2026, demande explicite) : sans hôte, aucune poussée du
 * secret n'est possible pour cette ligne.
 *
 * `secretDeployed` (⭐ 17/09/2026) : tag persistant — vrai une fois que la poussée SSH du mot de
 * passe d'application vers `SECRET_FILE_PATH` sur cette machine a réussi. Affiché comme badge sur
 * Paramètres Techniques, à côté de chaque machine. Ne dit rien du CONTENU du secret (jamais lu ici,
 * jamais comparé) — juste "la dernière poussée tentée pour cette machine a réussi".
 */
const sauvegardeTargetSchema = z.object({
  id: z.string().min(1),
  site: z.string().min(1),
  machine: z.string().min(1),
  host: z.string().min(1),
  secretDeployed: z.boolean().default(false)
});

export const sauvegardeConfigSchema = z.object({
  nextcloud: sauvegardeNextcloudSchema.default({}),
  targets: z.array(sauvegardeTargetSchema).default([])
}).refine(
  (config) => new Set(config.targets.map((t) => t.id)).size === config.targets.length,
  { message: 'Chaque machine doit avoir un id unique', path: ['targets'] }
);

export type SauvegardeConfig = z.infer<typeof sauvegardeConfigSchema>;
export type SauvegardeTargetConfig = z.infer<typeof sauvegardeTargetSchema>;

/**
 * ⭐ 17/09/2026 — dérive l'id d'une machine à partir de site+machine ("à quoi sert la zone
 * identifiant ? ... il sera non visible et constitué de site+machine", demande explicite). Plus
 * de champ "Identifiant" éditable dans Paramètres Techniques (voir SAUVEGARDE_UI_METADATA côté
 * `domain/index.ts` — `id` retiré des `itemFields`) : ModuleManager.generateArrayFieldHtml
 * calcule le même id côté navigateur via un x-effect Alpine, UNIQUEMENT tant que `item.id` est
 * vide (ne réécrase jamais un id déjà persisté — évite de casser les lignes déjà en production,
 * dont l'id historique ne suit pas forcément cette convention). Cette fonction est le pendant
 * SERVEUR de ce même calcul (import gossip, `handleGossipImport`) — la formule DOIT rester
 * identique aux deux endroits, sans quoi un id généré ici ne correspondrait plus à ce qu'un
 * navigateur recalculerait pour la même paire site/machine.
 */
export function deriveTargetId(site: string, machine: string): string {
  const slug = (value: string): string =>
    value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug(site)}-${slug(machine)}`;
}

export const DEFAULT_SAUVEGARDE_CONFIG: SauvegardeConfig = {
  nextcloud: {
    serverUrl: '',
    user: '',
    rootPath: ''
  },
  targets: []
};
