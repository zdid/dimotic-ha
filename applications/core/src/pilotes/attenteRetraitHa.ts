/**
 * Attente de la suppression d'entités dans HA (remplacement : suppression AVANT création, sinon HA suffixe `_2`).
 *
 * Côté application : `attendreRetraitHa(eventBus, appId, noms)` envoie la demande au cœur et attend sa réponse.
 * Côté cœur : `HaHelperBridge` sonde le registre HA jusqu'à ce qu'aucune entité ne porte plus ces noms.
 */

import type { IEventBus } from '../application/IEventBus';
import { PILOTES_EVENTS } from './types';

export interface PiloteRetraitDemande {
  appId: string;
  requestId: string;
  noms: string[];
  delaiMs?: number;
}

export interface PiloteRetraitResultat {
  appId: string;
  requestId: string;
  /** true = plus aucune entité à ce nom. */
  absent: boolean;
  /** false = aucune entité reconnue dès le départ (déjà partie, ou nom non reconnu). */
  vuAuDepart: boolean;
  attenteMs: number;
  restantes: string[];
}

function normaliser(texte: string): string {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Le nom de pilote (`quoi---lieu_précis--lieu--…`) correspond-il au nom d'entité de HA ? Toutes les parties du nom
 * doivent se retrouver dans le nom d'entité (insensible à la casse, aux accents et à la ponctuation).
 */
export function entiteCorrespond(nomPilote: string, nomEntite: string | undefined): boolean {
  if (!nomEntite) return false;
  const parties = nomPilote.split(/-{2,}/).map(normaliser).filter(Boolean);
  if (parties.length === 0) return false;
  const cible = normaliser(nomEntite);
  return parties.every((p) => cible.includes(p));
}

/** Demande au cœur d'attendre la disparition des entités ; ne lève jamais (délai dépassé = `absent: false`). */
export function attendreRetraitHa(
  eventBus: IEventBus,
  appId: string,
  noms: string[],
  delaiMs = 20000
): Promise<PiloteRetraitResultat> {
  if (noms.length === 0) {
    return Promise.resolve({ appId, requestId: '', absent: true, vuAuDepart: false, attenteMs: 0, restantes: [] });
  }
  const requestId = `${appId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const ecouteur = (r: PiloteRetraitResultat): void => {
      if (r?.requestId !== requestId) return;
      clearTimeout(garde);
      eventBus.offGeneric(PILOTES_EVENTS.HA_RETRAIT_RESULTAT, ecouteur);
      resolve(r);
    };
    const garde = setTimeout(() => {
      eventBus.offGeneric(PILOTES_EVENTS.HA_RETRAIT_RESULTAT, ecouteur);
      resolve({ appId, requestId, absent: false, vuAuDepart: false, attenteMs: delaiMs + 5000, restantes: [] });
    }, delaiMs + 5000);
    eventBus.onGeneric<PiloteRetraitResultat>(PILOTES_EVENTS.HA_RETRAIT_RESULTAT, ecouteur);
    eventBus.emitGeneric<PiloteRetraitDemande>(PILOTES_EVENTS.HA_RETRAIT_DEMANDE, { appId, requestId, noms, delaiMs });
  });
}

// ---------------------------------------------------------------------------
// Renommage d'entity_id après une modification de nom (HA garde l'ancien entity_id : l'entrée du registre survit à la
// suppression de la découverte MQTT et est reprise à la recréation).
// ---------------------------------------------------------------------------

export interface PiloteRenommerDemande { appId: string; requestId: string; nom: string; delaiMs?: number }

export interface PiloteRenommerResultat {
  appId: string;
  requestId: string;
  renommes: Array<{ de: string; vers: string }>;
  /** Entités déjà à la bonne valeur. */
  inchanges: string[];
  /** Impossible : identifiant visé déjà pris, ou erreur de HA. */
  bloques: Array<{ entityId: string; raison: string }>;
  /** Aucune entité reconnue (délai dépassé). */
  introuvable: boolean;
}

/** Slug d'identifiant HA : sans accents, minuscules, tout bloc non alphanumérique devient `_`. */
export function slugHa(texte: string): string {
  return texte.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Le nom d'entité de HA est-il celui de ce nom de pilote ? Nom affiché = quoi + lieu précis + lieu (lieu omis s'il répète
 * le précis ; lieux père et grand-père absents) : on compare au nom affiché reconstitué, ou à son début (plusieurs
 * entités par appareil : « Température salon » + « Humidité salon » ne sont pas concernées, « … batterie » oui).
 */
/**
 * Identifiant visé après renommage. HA fabrique `<domaine>.<pièce>_<nom affiché>` pour les appareils d'une pièce : si
 * l'identifiant actuel est de cette forme (il commence par le nom d'une pièce de HA), on garde la forme avec la pièce
 * ACTUELLE de l'appareil ; sinon (identifiant posé à la main ou par un `object_id`), `<domaine>.<nom affiché>` seul.
 */
export function entityIdVise(entityIdActuel: string, nomAffiche: string, piece: string | null, nomsPieces: string[]): string {
  const point = entityIdActuel.indexOf('.');
  const domaine = point < 0 ? entityIdActuel : entityIdActuel.slice(0, point);
  const objet = point < 0 ? '' : entityIdActuel.slice(point + 1);
  const slug = slugHa(nomAffiche);
  const prefixee = nomsPieces.map(slugHa).filter(Boolean).some((p) => objet.startsWith(`${p}_`));
  const prefixe = prefixee && piece ? slugHa(piece) : '';
  return prefixe ? `${domaine}.${prefixe}_${slug}` : `${domaine}.${slug}`;
}

export function entiteDeCeNom(nomPilote: string, nomEntite: string | undefined): boolean {
  if (!nomEntite) return false;
  const parties = nomPilote.split(/-{2,}/).map(normaliser).filter(Boolean).slice(0, 3);
  const affiche = parties.filter((p, i) => i === 0 || p !== parties[i - 1]).join('');
  if (!affiche) return false;
  const cible = normaliser(nomEntite);
  return cible === affiche || cible.startsWith(affiche);
}

export function renommerEntityIdHa(
  eventBus: IEventBus,
  appId: string,
  nom: string,
  delaiMs = 20000
): Promise<PiloteRenommerResultat> {
  const requestId = `${appId}-ren-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const ecouteur = (r: PiloteRenommerResultat): void => {
      if (r?.requestId !== requestId) return;
      clearTimeout(garde);
      eventBus.offGeneric(PILOTES_EVENTS.HA_RENOMMER_RESULTAT, ecouteur);
      resolve(r);
    };
    const garde = setTimeout(() => {
      eventBus.offGeneric(PILOTES_EVENTS.HA_RENOMMER_RESULTAT, ecouteur);
      resolve({ appId, requestId, renommes: [], inchanges: [], bloques: [], introuvable: true });
    }, delaiMs + 25000);
    eventBus.onGeneric<PiloteRenommerResultat>(PILOTES_EVENTS.HA_RENOMMER_RESULTAT, ecouteur);
    eventBus.emitGeneric<PiloteRenommerDemande>(PILOTES_EVENTS.HA_RENOMMER_DEMANDE, { appId, requestId, nom, delaiMs });
  });
}
