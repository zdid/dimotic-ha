/**
 * name-translations.ts
 *
 * Dictionnaire de noms d'entité (anglais→français, ou codes techniques→libellé lisible) appliqué
 * en Passthrough MQTT (fonctionnelles-nommage_specs §3.4), AVANT relais vers HA. HA ne traduit
 * automatiquement que les noms qu'il calcule lui-même depuis device_class (entité sans `name`
 * propre) — un `name` explicite fourni par la source (ex: zigbee2mqtt "Linkquality", "Child
 * lock"), ou une entité sans `name` du tout mais nécessitant un libellé distinctif (ex: les
 * champs Linky EAST/EASF01/EASF02..., qui partagent tous device_class "energy" et seraient sinon
 * indiscernables dans HA), ne sont jamais traduits/complétés par HA lui-même.
 *
 * Clé = object_id du topic de découverte (dernier segment avant `config`, ex: "linkquality" dans
 * homeassist/sensor/<device>/linkquality/config, ou "EAST" dans .../0x00158.../EAST/config) —
 * PAS le `name` d'origine : certaines entités (Linky EAST, EAIT, EASF01/02, EASD01, IRMS1,
 * CCASN, CCAIN...) n'ont aucun `name` propre côté source, seul object_id est toujours présent et
 * stable. Point d'entrée unique pour toute traduction/renommage de nom d'entité relayée par
 * NOMMAGE — remplace les surcharges ponctuelles côté zigbee2mqtt (devices.<id>.homeassistant.*),
 * retirées le 08/08/2026 pour n'avoir qu'un seul endroit à maintenir (demande utilisateur).
 *
 * Constitué à partir des noms/object_id réellement observés sur ce réseau (mosquitto_sub sur
 * homeassist/#) — pas une liste générique : à enrichir au fil de l'eau. Les entrées sans
 * correspondance connue (ex: Linky PCOUP, ERQ1-4, UMOY1, RELAIS — absentes du tableau TIC fourni
 * le 08/08/2026) sont volontairement omises : object_id/name d'origine reste affiché tel quel.
 */

const TRANSLATIONS: Record<string, string> = {
  // Générique zigbee2mqtt (diagnostic/config commun à de nombreux appareils)
  linkquality: 'Qualité de liaison',
  indicator_mode: 'Mode indicateur',
  power_outage_memory: 'Mémoire coupure secteur',
  switch_child_lock: 'Verrouillage enfant',
  power_on_behavior: 'Comportement à la mise sous tension',
  color_power_on_behavior: 'Comportement couleur à la mise sous tension',
  switch_type: "Type d'interrupteur",
  countdown: 'Compte à rebours',
  pi_heating_demand: 'Demande de chauffe PI',
  error: 'Erreur',
  switch_scale_protection: 'Protection anti-tartre',
  switch_frost_protection: 'Protection hors-gel',
  schedule_monday: 'Programme lundi',
  schedule_tuesday: 'Programme mardi',
  schedule_wednesday: 'Programme mercredi',
  schedule_thursday: 'Programme jeudi',
  schedule_friday: 'Programme vendredi',
  schedule_saturday: 'Programme samedi',
  schedule_sunday: 'Programme dimanche',
  workdays_schedule: 'Programme jours ouvrés',
  holidays_schedule: 'Programme jours fériés',
  learned_ir_code: 'Code IR appris',
  learn_ir_code: 'Apprendre code IR',
  ir_code_to_send: 'Code IR à envoyer',
  sensitivity: 'Sensibilité',
  keep_time: 'Durée de maintien',
  coordinator_version: 'Version coordinateur',
  network_map: 'Carte réseau',
  connection_state: 'État de connexion',
  restart_required: 'Redémarrage requis',
  restart: 'Redémarrer',
  log_level: 'Niveau de journalisation',
  effect: 'Effet',
  force: 'Forcer',
  week: 'Semaine',
  permit_join: "Autoriser l'appairage",
  switch_temperature_breaker: 'Disjoncteur température',
  switch_power_breaker: 'Disjoncteur puissance',
  switch_over_current_breaker: 'Disjoncteur surintensité',
  switch_over_voltage_breaker: 'Disjoncteur surtension',
  switch_under_voltage_breaker: 'Disjoncteur sous-tension',
  switch_do_not_disturb: 'Ne pas déranger',
  window_detection: 'Détection fenêtre ouverte',
  valve_detection: 'Détection de vanne',
  auto_lock: 'Verrouillage automatique',
  away_mode: 'Mode absence',
  temperature_threshold: 'Seuil de température',
  power_threshold: 'Seuil de puissance',
  over_current_threshold: 'Seuil de surintensité',
  over_voltage_threshold: 'Seuil de surtension',
  under_voltage_threshold: 'Seuil de sous-tension',
  away_preset_days: 'Jours du préréglage absence',
  boost_time: 'Durée boost',
  comfort_temperature: 'Température confort',
  eco_temperature: 'Température éco',
  max_temperature: 'Température max',
  min_temperature: 'Température min',
  away_preset_temperature: 'Température préréglage absence',
  illuminance_interval: 'Intervalle de luminosité',

  // Linky (TIC standard — donnees_linky_standard_completes.txt, 08/08/2026)
  EAST: 'Conso totale',
  EAIT: 'Injection totale',
  EASF01: 'Conso index 01',
  EASF02: 'Conso index 02',
  EASD01: 'Conso Dist. 01',
  site_id: 'Numéro PRM',
  VTIC: 'Version TIC',
  SINSTI: 'Injection inst.',
  SMAXIN: 'Injection max jour',
  'SMAXIN-1': 'Injection max veille',
  message1: 'Message 1',
  message2: 'Message 2',
  status_register: "Registre d'état",
  NTARF: 'Index actif',
  current_price: 'Option active',
  current_tarif: 'Tarif souscrit',
  current_date: 'Horodatage',
  SMAXSN: 'Puiss. max jour',
  'SMAXSN-1': 'Puiss. max veille',
  SINSTS: 'Puissance inst.',
  URMS1: 'Tension P1',
  IRMS1: 'Courant P1',
  PREF: 'Puiss. souscrite'
};

/**
 * Traduit le nom d'une entité à partir de son object_id (voir en-tête) ; renvoie `undefined` si
 * l'object_id n'a pas d'entrée dans le dictionnaire — l'appelant ne doit alors PAS toucher au
 * payload d'origine (un `name` absent chez zigbee2mqtt n'est pas équivalent à `name: null`,
 * voir NommageService.ts::emitPassthroughDiscovery).
 */
export function translateEntityName(objectId: string): string | undefined {
  return TRANSLATIONS[objectId];
}
