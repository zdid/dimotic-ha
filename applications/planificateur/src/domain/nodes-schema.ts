/**
 * Schémas Zod des nœuds du domaine (miroir de types.ts), utilisés pour valider le contenu des
 * fichiers YAML de stockage (macros, planifications) — pas pour valider les messages EventBus
 * reçus de `ia`, volontairement moins stricts côté réception (voir handler.ts) pour ne pas
 * rejeter un JSON par ailleurs exploitable sur un champ optionnel manquant.
 */

import { z } from 'zod';
import type {
  DomoticNode,
  ActionNode,
  ConditionNode,
  SequenceNode,
  MacroDefinition,
  PlanificationDefinition
} from './types';

export const resolvedServiceCallSchema = z.object({
  domain: z.string().min(1),
  service: z.string().min(1),
  entity_id: z.union([z.string(), z.array(z.string())]),
  data: z.record(z.unknown()).optional()
});

export const actionNodeSchema: z.ZodType<ActionNode> = z.lazy(() =>
  z.object({
    type: z.literal('action'),
    order: z.string(),
    verbe: z.string().optional(),
    quoi: z.string().optional(),
    lieux: z.array(z.string()).optional(),
    valeur: z.union([z.string(), z.number()]).optional(),
    resolved_service_call: resolvedServiceCallSchema.optional()
  })
);

export const waitNodeSchema = z.object({
  type: z.literal('wait'),
  duration: z.string(),
  seconds: z.number().optional(),
  seconds_min: z.number().optional(),
  seconds_max: z.number().optional()
});

// z.lazy nécessaire : condition/sequence/macro s'imbriquent librement (DomoticNode récursif).
export const domoticNodeSchema: z.ZodType<DomoticNode> = z.lazy(() =>
  z.union([
    actionNodeSchema,
    waitNodeSchema,
    conditionNodeSchema,
    macroRefNodeSchema,
    sequenceNodeSchema,
    macroDefinitionSchema,
    planificationDefinitionSchema,
    gestionNodeSchema,
    executionPayloadSchema
  ]) as unknown as z.ZodType<DomoticNode>
);

export const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.object({
    type: z.literal('condition'),
    if: z.string(),
    then: domoticNodeSchema,
    else: domoticNodeSchema.optional()
  })
);

export const macroRefNodeSchema = z.object({
  type: z.literal('macro_ref'),
  name: z.string().min(1)
});

export const sequenceNodeSchema: z.ZodType<SequenceNode> = z.lazy(() =>
  z.object({
    type: z.literal('sequence'),
    steps: z.array(domoticNodeSchema)
  })
);

export const macroDefinitionSchema: z.ZodType<MacroDefinition> = z.lazy(() =>
  z.object({
    type: z.literal('macro'),
    name: z.string().min(1),
    steps: z.array(domoticNodeSchema)
  })
);

export const triggerSchema = z.object({
  type: z.string(),
  seconds: z.number().optional(),
  seconds_min: z.number().optional(),
  seconds_max: z.number().optional(),
  at: z.string().optional(),
  at_min: z.string().optional(),
  at_max: z.string().optional(),
  on: z.string().optional(),
  every: z.string().optional(),
  days: z.array(z.string()).optional(),
  except_days: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  description: z.string().optional(),
  entity_id: z.string().optional(),
  domain: z.string().optional(),
  to_state: z.string().optional()
});

export const planificationDefinitionSchema: z.ZodType<PlanificationDefinition> = z.lazy(() =>
  z.object({
    type: z.literal('planification'),
    name: z.string().min(1),
    active: z.boolean(),
    phrase_originale: z.string().min(1),
    trigger: triggerSchema,
    action: domoticNodeSchema,
    id: z.number().optional(),
    next_fire_at: z.string().optional(),
    pending: z.record(z.string()).optional(),
    missed: z.boolean().optional(),
    anomalie: z.object({ message: z.string(), at: z.string() }).optional(),
    completed_at: z.string().optional()
  })
);

export const gestionNodeSchema = z.object({
  type: z.literal('gestion'),
  operation: z.enum(['lister', 'activer', 'desactiver', 'supprimer', 'modifier']),
  cible: z.enum(['planification', 'macro', 'tout']),
  name: z.string().optional(),
  modifications: z.record(z.unknown()).optional()
});

export const executionStepSchema = z.object({
  step: z.number(),
  type: z.enum(['action', 'wait']),
  order: z.string().optional(),
  verbe: z.string().optional(),
  quoi: z.string().optional(),
  lieux: z.array(z.string()).optional(),
  valeur: z.union([z.string(), z.number()]).optional(),
  resolved_service_call: resolvedServiceCallSchema.optional(),
  seconds: z.number().optional(),
  resolved_from: z.string().optional(),
  delay_before_seconds: z.number()
});

export const executionPayloadSchema = z.object({
  type: z.literal('execution'),
  execution: z.object({
    trigger_name: z.string(),
    triggered_at: z.string(),
    context_snapshot: z.record(z.unknown()),
    steps: z.array(executionStepSchema)
  })
});
