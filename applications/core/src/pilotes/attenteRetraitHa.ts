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
