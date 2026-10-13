/**
 * Garde-fou « un seul agent actif » — fonctionnelles-esphome_specs v1.2 §7.
 *
 * Fonction pure : à partir de la présence d'un autre agent lue sur le même sujet (message conservé + testament),
 * décide si CET agent doit traiter les demandes. Ce n'est pas de la sécurité, c'est une protection contre
 * l'oubli (instance réelle 8087 ET instance de dev 8088 sur la même machine ESPHome).
 */

import type { Presence } from './messages';

export interface Identite {
  instance: string;
  port: number;
}

export type Decision = { actif: true } | { actif: false; raison: string };

/** `autre` : la présence conservée trouvée sur le sujet (null = aucune). */
export function decider(moi: Identite, autre: Presence | null): Decision {
  if (!autre || !autre.enLigne) return { actif: true };
  // Notre propre présence conservée d'un lancement précédent n'est pas « un autre agent ».
  if (autre.instance === moi.instance && autre.port === moi.port) return { actif: true };
  return { actif: false, raison: `un autre agent est déjà actif : instance ${autre.instance}, port ${autre.port}` };
}
