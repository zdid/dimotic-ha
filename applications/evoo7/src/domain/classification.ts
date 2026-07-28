/**
 * Détermination du composant HA et construction des templates Jinja pour une donnée EVOO7.
 *
 * Conforme au plan d'implémentation EVOO7 : le composant dépend de la forme de la donnée
 * (min/max, valeursPossibles, ou ni l'un ni l'autre) croisée avec `updatable`.
 *
 * ⚠️ Énumérations (valeursPossibles) : les codes numériques documentés dans la page de
 * configuration d'EVOO7 (commentaires HTML `<!-- N: -->`) ne correspondent PAS aux valeurs
 * réellement observées sur le fil MQTT — vérifié en conditions réelles : `etat_fonctionnement`
 * documenté 0/1/2 (Arrêt/Chauffage/Raffraichissement) publie en réalité le mot littéral `"on"`.
 * Traduire ces codes aurait exposé un risque réel d'envoyer une commande incorrecte à EVOO7
 * (ex: sélectionner "Chauffage" → traduction vers "1" → valeur potentiellement sans effet ou
 * erronée sur le système réel). Décision (validée avec l'utilisateur) : les données à liste de
 * valeurs sont TOUJOURS exposées en lecture seule, passthrough brut, sans aucune traduction ni
 * commande — voir `determineComponent`.
 *
 * Design des templates (voir techniques-socle-ha-mqtt_specs §8.5.4 pour le format des topics
 * état/commande du socle) :
 * - Notre topic d'état porte toujours une enveloppe JSON `{"state": <valeur brute EVOO7>,
 *   "attributes": {...}}` (HaMqttStateMessage) — `value_template` doit donc TOUJOURS lire
 *   `value_json.state`, jamais `value` nu.
 * - `command_template` doit produire un JSON valide sur le topic de commande (notre socle exige
 *   du JSON — `parseIncomingCommand` fait un `JSON.parse` strict, alors que HA publie par défaut
 *   du texte brut non-JSON pour number/text). Le template encapsule toujours la valeur dans
 *   `{"value": ...}`.
 */

import type { Evoo7Component, Evoo7DataDefinition } from './types';

/**
 * Composant HA :
 * - forcedComponent='binary_sensor' → toujours binary_sensor, outrepasse tout le reste (saisie
 *   manuelle, voir types.ts) — nécessite payloadOn/payloadOff pour être exploitable.
 * - sinon, déterminé automatiquement :
 *   - min/max (nombre)          → number (updatable) / sensor (lecture seule)
 *   - valeursPossibles (énum)   → TOUJOURS sensor (lecture seule, passthrough brut — voir note ci-dessus)
 *   - ni l'un ni l'autre        → text (updatable) / sensor (lecture seule)
 */
export function determineComponent(donnee: Evoo7DataDefinition): Evoo7Component {
  if (donnee.forcedComponent === 'binary_sensor') return 'binary_sensor';

  const hasRange = donnee.min !== undefined || donnee.max !== undefined;
  const hasEnum = !!donnee.valeursPossibles && donnee.valeursPossibles.length > 0;

  if (hasEnum) return 'sensor';
  if (hasRange) return donnee.updatable ? 'number' : 'sensor';
  return donnee.updatable ? 'text' : 'sensor';
}

/** step HA pour un composant number — 0.1 si min ou max n'est pas entier, sinon 1. */
export function determineNumberStep(donnee: Evoo7DataDefinition): number {
  const values = [donnee.min, donnee.max].filter((v): v is number => v !== undefined);
  const hasDecimal = values.some((v) => !Number.isInteger(v));
  return hasDecimal ? 0.1 : 1;
}

/**
 * value_template Jinja, appliqué au topic d'état (JSON `{"state": ..., "attributes": {...}}`).
 * Passthrough brut de `value_json.state` — aucune traduction de code (voir note en tête de fichier).
 */
export function buildValueTemplate(): string {
  return '{{ value_json.state }}';
}

/**
 * command_template Jinja, appliqué à la valeur brute publiée par HA sur le topic de commande.
 * Encapsule toujours dans `{"value": ...}` (JSON requis par le socle). N'est utilisé que pour
 * number/text — jamais pour les énumérations (voir determineComponent, toujours 'sensor').
 */
export function buildCommandTemplate(component: Evoo7Component): string {
  if (component === 'number') {
    return '{"value": {{ value }} }';
  }
  return '{"value": "{{ value }}"}';
}

/**
 * value_template Jinja pour `mode_state_topic` de l'entité climate composite (thermostat),
 * dérivé de `etat_fonctionnement`. Tolère volontairement DEUX encodages : les codes documentés
 * (0/1/2 = Arrêt/Chauffage/Refroidissement) ET l'encodage réellement observé aujourd'hui sur le
 * fil (un script externe côté utilisateur simplifie temporairement en "on"/"off" — voir la note
 * en tête de fichier). Repli sûr sur `off` pour toute valeur non reconnue.
 */
export function buildModeStateTemplate(): string {
  return (
    "{% set v = value_json.state %}" +
    "{% if v in ['1','on','Chauffage'] %}heat" +
    "{% elif v in ['2','Refroidissement','Raffraichissement'] %}cool" +
    "{% else %}off{% endif %}"
  );
}

/**
 * value_template Jinja pour `preset_mode_state_topic` de l'entité climate composite, dérivé de
 * `etat_eco` (0=Active/1=Inactive documenté, jamais vérifié fiable — même prudence que ci-dessus).
 * `''` (chaîne vide) = pas de preset actif, seule valeur valide pour "pas eco" côté HA.
 */
export function buildPresetModeStateTemplate(): string {
  return "{% set v = value_json.state %}{% if v in ['0','on','Active'] %}eco{% else %}{% endif %}";
}

/** Table libellé→code — informatif pour l'UI (affichage de la table de correspondance documentée). */
export function buildLabelToCodeMap(donnee: Evoo7DataDefinition): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of donnee.valeursPossibles ?? []) {
    map[v.libelle] = v.code;
  }
  return map;
}

/** Table code→libellé — informatif pour l'UI (affichage de la table de correspondance documentée). */
export function buildCodeToLabelMap(donnee: Evoo7DataDefinition): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of donnee.valeursPossibles ?? []) {
    map[v.code] = v.libelle;
  }
  return map;
}
