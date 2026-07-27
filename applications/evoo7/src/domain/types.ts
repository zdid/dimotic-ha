/**
 * Types du domaine EVOO7
 *
 * Conforme au plan d'implémentation EVOO7 (voir CLAUDE.md / decisions validées avec l'utilisateur).
 */

// ============================================================================
// Composant HA déterminé automatiquement pour une donnée
// ============================================================================

export type Evoo7Component = 'number' | 'select' | 'sensor' | 'text' | 'binary_sensor';

// ============================================================================
// Valeur possible d'une donnée énumérée — code réel attendu par EVOO7 sur le fil
// MQTT (PAS toujours l'index de la liste, voir consigne_active: 202/206)
// ============================================================================

export interface Evoo7ValeurPossible {
  code: string;
  libelle: string;
}

// ============================================================================
// Définition d'une donnée EVOO7 (config-evoo7-donnees-v1.0.yaml)
// ============================================================================

/**
 * Une donnée EVOO7 telle que persistée dans notre fichier de configuration centralisé.
 * Champs figés = capacité intrinsèque de la donnée sur EVOO7 (dérivés une fois du JSON
 * source, jamais modifiés par l'UI). Champs modifiables = sélection utilisateur, persistée.
 */
export interface Evoo7DataDefinition {
  // ---- Identité et description (figés, informatifs) ----
  id: string;
  description: string;
  min?: number;
  max?: number;
  valeursPossibles?: Evoo7ValeurPossible[];

  // ---- Champs figés (capacité) ----
  /** true si la case "Mise à jour" existe sur EVOO7 pour cette donnée (mise_a_jour !== null dans le JSON source). */
  updatable: boolean;
  /**
   * true si cette donnée était D'ORIGINE en "Consultation" cochée sur EVOO7 (mesure/état, PAS
   * une donnée de config) — pilote l'absence d'entity_category "config" dans la découverte HA.
   * Les données NON isConfigData (8 sur 43) sont les seules "non-config" au sens HA.
   */
  isConfigData: boolean;

  // ---- Champs modifiables par l'utilisateur (persistés, valeur initiale = JSON source) ----
  consultation: boolean;
  /** N'a de sens que si updatable=true — ignoré sinon. */
  miseAJour: boolean;
  topicSensor: string;
  formatMessageSensor: string;

  // ---- Taxonomie QUOI/OÙ (persistée, saisie manuelle — description est un texte libre figé,
  // jamais parseable en quoi---lieu, voir TODO.md "aucune saisie réelle de la taxonomie"). Non
  // renseigné tant que l'utilisateur n'a rien saisi (repli sur description dans ce cas).
  taxonomieQuoi?: string;
  taxonomieLieuPrecis?: string;
  taxonomieLieu?: string;
  taxonomiePere?: string;
  taxonomieGrandPere?: string;

  // ---- Classe HA / unité (persistée, saisie manuelle) — force le device_class HA (ex:
  // "temperature") pour un affichage correct côté HA (unité, icône), le composant seul
  // (number/sensor/text, voir classification.ts) n'en dit rien. Non renseigné = HA n'affiche
  // aucune unité ni icône spécifique.
  deviceClass?: string;
  unitOfMeasurement?: string;

  // ---- Type HA forcé (persisté, saisie manuelle) — outrepasse determineComponent() pour publier
  // en binary_sensor plutôt qu'en sensor générique (ex: etat_force_on/etat_pac/etat_appoint...).
  // payloadOn/payloadOff = valeur brute EVOO7 exacte qui signifie ON/OFF pour CETTE donnée (pas
  // uniforme d'une donnée à l'autre, voir classification.ts sur la fiabilité des codes EVOO7).
  forcedComponent?: string;
  payloadOn?: string;
  payloadOff?: string;
}

// ============================================================================
// Fichier de configuration centralisé (config-evoo7-donnees-v1.0.yaml)
// ============================================================================

export interface Evoo7DonneesConfig {
  evoo7_donnees: Record<string, Evoo7DataDefinition>;
}

// ============================================================================
// Statut / commandes exposés à l'UI et au socle
// ============================================================================

export interface Evoo7Status {
  /** Connexion au broker MQTT propre à EVOO7 (Evoo7MqttClient). */
  evoo7Connected: boolean;
  /** Connexion du bridge socle vers le broker HA (IntegrationBridge). */
  bridgeConnected: boolean;
  donneesCount: number;
  consultationCount: number;
  miseAJourCount: number;
  lastMessageAt: string | null;
}
