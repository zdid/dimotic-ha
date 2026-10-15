/**
 * Gestion des pilotes par l'agent IA — contrat commun (conception-gestion-pilotes_specs v1.1 §4, §5).
 *
 * Trois événements locaux relient une application « pilote » (process séparé) et le cœur :
 *   `pilotes:presence`          app → cœur : « mon pont existe » (le cœur le publie en MQTT, retenu)
 *   `pilotes:presence:demande`  cœur → app : « annonce-toi à nouveau » (démarrage ou reconnexion du cœur)
 *   `pilotes:requete`           cœur → app : une requête reçue en MQTT pour un de ses ponts
 *   `pilotes:reponse`           app → cœur : la réponse, publiée en MQTT par le cœur
 */

import { createHash, createHmac } from 'node:crypto';

export const PILOTES_EVENTS = {
  PRESENCE: 'pilotes:presence',
  PRESENCE_DEMANDE: 'pilotes:presence:demande',
  REQUETE: 'pilotes:requete',
  REPONSE: 'pilotes:reponse'
} as const;

/** Ordres qui ne modifient rien : permis sans signature. */
export const PILOTES_ORDRES_LECTURE = ['lister', 'decouverts'] as const;

/** Ordres qui modifient : aperçu d'abord, jeton, signature obligatoire (§5.2, §5.3, §11). */
export const PILOTES_ORDRES_MODIFIANTS = [
  'adopter',
  'creer',
  'modifier',
  'remplacer',
  'effacer',
  'ignorer',
  'supprimer',
  'redemarrer',
  'appairer'
] as const;

export const PILOTES_ORDRES = [...PILOTES_ORDRES_LECTURE, ...PILOTES_ORDRES_MODIFIANTS] as const;

export type PiloteOrdre = (typeof PILOTES_ORDRES)[number];

export function estOrdreModifiant(ordre: string): boolean {
  return (PILOTES_ORDRES_MODIFIANTS as readonly string[]).includes(ordre);
}

export function estOrdreConnu(ordre: string): boolean {
  return (PILOTES_ORDRES as readonly string[]).includes(ordre);
}

export type PiloteEtat = 'en_ligne' | 'hors_ligne';

/** Ce que l'application annonce (le cœur y ajoute `machine`, `appId`, `date`). */
export interface PilotePresence {
  /** Nom complet du pont (ex. `arexx_bridge_noisy`) : identifiant de l'instance du pilote. */
  pont: string;
  /** Type de pilote : arexx, rfxcom, gpio, zigbee2mqtt, test… */
  type: string;
  version?: string;
  /** Ordres que ce pont sait exécuter : l'agent n'en essaie pas d'autres. */
  capacites: string[];
  etat: PiloteEtat;
}

/** Présence telle que publiée en MQTT (retenue). */
export interface PilotePresencePubliee extends PilotePresence {
  machine: string;
  appId: string;
  date: string;
}

export interface PiloteRequete {
  /** Identifiant de corrélation choisi par l'émetteur ([A-Za-z0-9_-], 1 à 64 caractères). */
  id: string;
  pont: string;
  ordre: string;
  parametres?: Record<string, unknown>;
  /** Vrai = renvoyer l'aperçu sans rien modifier. */
  apercu?: boolean;
  /** Jeton renvoyé par l'aperçu : exigé pour appliquer (l'état n'a pas changé depuis). */
  jeton?: string;
  emetteur?: string;
  /** Horodatage ISO de l'émetteur (les requêtes de plus de 2 minutes sont refusées). */
  date?: string;
  /** HMAC-SHA256 (hex) de `messageASigner()` avec le secret partagé du site. */
  signature?: string;
}

export interface PiloteErreur {
  code: string;
  message: string;
}

export interface PiloteReponse {
  id: string;
  pont: string;
  ok: boolean;
  resultat?: unknown;
  erreur?: PiloteErreur;
  apercu?: unknown;
  jeton?: string;
  sauvegarde?: string;
}

/** Événement cœur → app. */
export interface PiloteRequeteEvenement {
  appId: string;
  requete: PiloteRequete;
}

/** Événement app → cœur. */
export interface PiloteReponseEvenement {
  reponse: PiloteReponse;
}

export interface PilotePresenceEvenement {
  appId: string;
  presence: PilotePresence;
}

export const PILOTE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
export const PILOTE_DUREE_VALIDITE_REQUETE_MS = 2 * 60 * 1000;

/** Un site sert de segment de topic : pas de `/`, `+`, `#` ni d'espace. */
export function segmentSite(site: string): string {
  return site.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function sujetsPilotes(site: string) {
  const racine = `dimotic/${segmentSite(site)}/pilotes`;
  return {
    racine,
    presence: (pont: string): string => `${racine}/${pont}/presence`,
    requete: (pont: string, id: string): string => `${racine}/${pont}/requete/${id}`,
    reponse: (pont: string, id: string): string => `${racine}/${pont}/reponse/${id}`,
    machine: (machineId: string): string => `${racine}/_machines/${machineId}`,
    abonnementRequetes: `${racine}/+/requete/+`,
    abonnementPresences: `${racine}/+/presence`
  };
}

/** JSON à clés triées : même texte des deux côtés, quel que soit l'ordre d'insertion. */
export function canonique(valeur: unknown): string {
  if (valeur === null || typeof valeur !== 'object') return JSON.stringify(valeur) ?? 'null';
  if (Array.isArray(valeur)) return `[${valeur.map(canonique).join(',')}]`;
  const objet = valeur as Record<string, unknown>;
  const cles = Object.keys(objet).filter((c) => objet[c] !== undefined).sort();
  return `{${cles.map((c) => `${JSON.stringify(c)}:${canonique(objet[c])}`).join(',')}}`;
}

export function messageASigner(requete: Pick<PiloteRequete, 'id' | 'pont' | 'ordre' | 'parametres' | 'apercu' | 'jeton' | 'date'>): string {
  return [
    requete.id,
    requete.pont,
    requete.ordre,
    canonique(requete.parametres ?? {}),
    requete.apercu ? '1' : '0',
    requete.jeton ?? '',
    requete.date ?? ''
  ].join('|');
}

export function signerRequete(secret: string, requete: Parameters<typeof messageASigner>[0]): string {
  return createHmac('sha256', secret).update(messageASigner(requete)).digest('hex');
}

/** Empreinte de ce qui va être fait sur l'état actuel : change dès que l'état change. */
export function jetonApercu(pont: string, ordre: string, parametres: Record<string, unknown>, etat: unknown): string {
  return createHash('sha256').update(canonique({ pont, ordre, parametres, etat })).digest('hex').slice(0, 16);
}
