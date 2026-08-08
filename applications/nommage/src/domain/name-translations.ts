/**
 * name-translations.ts
 *
 * Dictionnaire anglais → français pour les noms d'entité relayés en Passthrough MQTT
 * (fonctionnelles-nommage_specs §3.4). HA ne traduit automatiquement que les noms qu'il calcule
 * lui-même depuis device_class (entité sans `name` propre) — un `name` explicite comme ceux que
 * zigbee2mqtt publie ("Linkquality", "Child lock", "Power outage memory"...) traverse HA tel
 * quel, jamais traduit. Constitué le 08/08/2026 à partir des noms réellement observés sur les
 * messages de découverte de ce réseau (mosquitto_sub sur homeassist/#) — pas une liste
 * générique : à enrichir au fil de l'eau quand un nouveau terme anglais apparaît.
 *
 * Ne couvre volontairement pas les codes techniques (ex: TIC Linky "PREF", "VTIC") : ceux-ci ne
 * sont pas des mots anglais à traduire, déjà renommés au cas par cas côté zigbee2mqtt
 * (devices.<id>.homeassistant.<propriété>.name).
 */

const TRANSLATIONS: Record<string, string> = {
  'Linkquality': 'Qualité de liaison',
  'Indicator mode': 'Mode indicateur',
  'Power outage memory': 'Mémoire coupure secteur',
  'Child lock': 'Verrouillage enfant',
  'Power-on behavior': 'Comportement à la mise sous tension',
  'Switch type': "Type d'interrupteur",
  'Countdown': 'Compte à rebours',
  'PI heating demand': 'Demande de chauffe PI',
  'Error': 'Erreur',
  'Scale protection': 'Protection anti-tartre',
  'Frost protection': 'Protection hors-gel',
  'Schedule monday': 'Programme lundi',
  'Schedule tuesday': 'Programme mardi',
  'Schedule wednesday': 'Programme mercredi',
  'Schedule thursday': 'Programme jeudi',
  'Schedule friday': 'Programme vendredi',
  'Schedule saturday': 'Programme samedi',
  'Schedule sunday': 'Programme dimanche',
  'Learned ir code': 'Code IR appris',
  'Sensitivity': 'Sensibilité',
  'Keep time': 'Durée de maintien',
  'Learn ir code': 'Apprendre code IR',
  'Ir code to send': 'Code IR à envoyer',
  'Coordinator version': 'Version coordinateur',
  'Network map': 'Carte réseau',
  'Connection state': 'État de connexion',
  'Restart required': 'Redémarrage requis',
  'Restart': 'Redémarrer',
  'Log level': 'Niveau de journalisation',
  'Effect': 'Effet',
  'Color power on behavior': 'Comportement couleur à la mise sous tension',
  'Force': 'Forcer',
  'Week': 'Semaine',
  'Permit join': "Autoriser l'appairage",
  'Temperature breaker': 'Disjoncteur température',
  'Power breaker': 'Disjoncteur puissance',
  'Over current breaker': 'Disjoncteur surintensité',
  'Over voltage breaker': 'Disjoncteur surtension',
  'Under voltage breaker': 'Disjoncteur sous-tension',
  'Do not disturb': 'Ne pas déranger',
  'Window detection': 'Détection fenêtre ouverte',
  'Valve detection': 'Détection de vanne',
  'Auto lock': 'Verrouillage automatique',
  'Away mode': 'Mode absence',
  'Temperature threshold': 'Seuil de température',
  'Power threshold': 'Seuil de puissance',
  'Over current threshold': 'Seuil de surintensité',
  'Over voltage threshold': 'Seuil de surtension',
  'Under voltage threshold': 'Seuil de sous-tension',
  'Away preset days': 'Jours du préréglage absence',
  'Boost time': 'Durée boost',
  'Comfort temperature': 'Température confort',
  'Eco temperature': 'Température éco',
  'Max temperature': 'Température max',
  'Min temperature': 'Température min',
  'Away preset temperature': 'Température préréglage absence',
  'Illuminance interval': 'Intervalle de luminosité',
  'Workdays schedule': 'Programme jours ouvrés',
  'Holidays schedule': 'Programme jours fériés'
};

/** Traduit un nom d'entité connu ; renvoie la valeur d'origine si absente du dictionnaire. */
export function translateEntityName(name: string): string {
  return TRANSLATIONS[name] ?? name;
}
