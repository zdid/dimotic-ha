/**
 * Modèle de données du domaine planificateur — arbre de nœuds JSON échangé avec `ia`.
 * Port de ts-planner/src/types.ts (prototype), voir specs/current/fonctionnelles-planificateur_specs
 * §2. Différence majeure avec le prototype : `resolved_service_call` est ici un mécanisme actif
 * (peuplé par resolution.ts), pas un placeholder inactif.
 */

/** Appel de service HA résolu de manière déterministe par planificateur (voir resolution.ts). */
export interface ResolvedServiceCall {
  domain: string;               // ex: "light"
  service: string;              // ex: "turn_on"
  entity_id: string | string[];
  data?: Record<string, unknown>; // ex: { brightness_pct: 80 }
}

export interface ActionNode {
  type: 'action';
  order: string;
  verbe?: string;
  quoi?: string;
  lieux?: string[];
  valeur?: string | number;
  resolved_service_call?: ResolvedServiceCall;
}

export interface WaitNode {
  type: 'wait';
  duration: string;
  seconds?: number;
  seconds_min?: number;
  seconds_max?: number;
}

export interface ConditionNode {
  type: 'condition';
  if: string;
  then: DomoticNode;
  else?: DomoticNode;
}

export interface MacroRefNode {
  type: 'macro_ref';
  name: string;
}

export interface SequenceNode {
  type: 'sequence';
  steps: DomoticNode[];
}

export interface MacroDefinition {
  type: 'macro';
  name: string;
  steps: DomoticNode[];
}

export interface Trigger {
  type: string; // 'delay' | 'time' | 'date' | 'recurrence' | 'recurrence_complex' | 'window' | 'duration' | 'state_change'
  seconds?: number;
  seconds_min?: number;
  seconds_max?: number;
  at?: string;
  at_min?: string;
  at_max?: string;
  on?: string;
  every?: string;
  days?: string[];
  except_days?: string[];
  pattern?: string;
  from?: string;
  to?: string;
  description?: string;
  // Déclencheur 'state_change' — entity_id (entité précise) ou domain (règle par défaut sur tout
  // un domaine, ex: "light") : au moins l'un des deux, entity_id prioritaire sur domain quand les
  // deux pourraient s'appliquer à la même entité (voir StateWatcher). `to_state` nommé
  // différemment de `to` ci-dessus (déjà pris par le trigger 'window', autre sémantique) pour
  // éviter toute confusion, bien qu'aucune collision de schéma ne soit possible (les deux sont de
  // simples chaînes optionnelles).
  entity_id?: string;
  domain?: string;
  to_state?: string;
}

export interface PlanificationDefinition {
  type: 'planification';
  name: string;
  active: boolean;
  phrase_originale: string;
  trigger: Trigger;
  action: DomoticNode;
  // Reprise après coupure (voir SchedulerRuntime/StateWatcher) — jamais renseignés par ia/Mistral,
  // uniquement gérés par planificateur lui-même.
  // ⭐ Identifiant numérique stable, attribué à la création (CommandHandler.nextPlanificationId) —
  // demande utilisateur : écran principal en liste numérotée, et pouvoir dire "désactive la
  // planification 3" (voir CommandHandler.resolvePlan). Jamais réattribué tant que la planification
  // existe, y compris si elle est recréée sous le même nom (voir handleCommand, case 'planification').
  id?: number;
  next_fire_at?: string;           // ISO8601 — triggers temporels, un seul minuteur par plan
  pending?: Record<string, string>; // entity_id → ISO8601 — triggers state_change, un compte à
                                     // rebours indépendant par entité (une règle par défaut sur
                                     // tout un domaine en gère plusieurs en parallèle)
  missed?: boolean;                 // déclenchement manqué au-delà de la fenêtre de rattrapage,
                                     // effacé au prochain déclenchement réussi (triggers temporels
                                     // uniquement pour l'instant, voir plan)
}

export interface GestionNode {
  type: 'gestion';
  operation: 'lister' | 'activer' | 'desactiver' | 'supprimer' | 'modifier';
  cible: 'planification' | 'macro' | 'tout';
  name?: string;
  modifications?: Record<string, unknown>;
}

export interface ExecutionStep {
  step: number;
  type: 'action' | 'wait';
  order?: string;             // texte en langage naturel, conservé pour le repli processConversation
  verbe?: string;              // vocabulaire QUOI/OÙ structuré — nécessaire à resolution.ts pour
  quoi?: string;                // peupler resolved_service_call ; ia le fournit systématiquement
  lieux?: string[];              // pour chaque étape 'action' (specs planificateur §7)
  valeur?: string | number;
  resolved_service_call?: ResolvedServiceCall; // peuplé par planificateur, jamais par ia/Mistral
  seconds?: number;
  resolved_from?: string;
  delay_before_seconds: number;
}

export interface ExecutionPayload {
  type: 'execution';
  execution: {
    trigger_name: string;
    triggered_at: string;
    context_snapshot: Record<string, unknown>;
    steps: ExecutionStep[];
  };
}

export type DomoticNode =
  | ActionNode
  | WaitNode
  | ConditionNode
  | MacroRefNode
  | SequenceNode
  | MacroDefinition
  | PlanificationDefinition
  | GestionNode
  | ExecutionPayload;

/** Réponse corrélée générique pour les échanges internes ia<->planificateur (EventBus). */
export interface CorrelatedReponse {
  correlation_id: string;
  success: boolean;
  message: string;
  data?: unknown;
}

/** Paramètres de l'outil executer_action (specs ia §7) — même forme qu'un ActionNode simplifié. */
export interface ExecuterActionParams {
  verbe: string;
  quoi: string;
  lieux: string[];
  valeur?: string | number;
  phrase_originale?: string;
}

/** Contexte de déploiement envoyé à `ia` pour réinterprétation (specs planificateur §6). */
export interface DeployContext {
  trigger_name: string;
  phrase_originale: string;
  macros: MacroDefinition[];
  entities_snapshot: unknown[];
  timestamp: string;
  // Renseigné uniquement pour un déclenchement state_change — l'entité réellement à l'origine de
  // CE déclenchement précis, pour qu'une action sans lieu explicite ("éteins-la") sache quoi
  // cibler, en particulier pour une règle par défaut sur tout un domaine (voir StateWatcher).
  triggered_entity_id?: string;
}
