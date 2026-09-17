// ======================================================================
// Types partagés pour l'application UI
// ======================================================================

import type { Socket } from 'socket.io-client';

export interface Module {
  id: string;
  name: string;
  icon: string;
  status: 'configured' | 'partial' | 'missing' | 'error';
  configUi?: ModuleUiMetadata;
  menu?: ApplicationMenuConfig;
}

export interface MenuEntry {
  id?: string;
  label: string;
  icon?: string;
  path: string;
  order: number;
  badge?: string;
  parentId?: string;
}

export interface ApplicationMenuConfig {
  category: string;
  section: string;
  entry: MenuEntry;
  pages?: MenuEntry[];
}

export interface ModuleUiMetadata {
  title: string;
  description: string;
  // ⭐ Supporte les champs plats OU des groupes (title/description/fields) — miroir de
  // applications/core/src/types/config.ts, jusqu'ici absent côté navigateur (cause du bug
  // "undefined undefined" : ModuleManager traitait chaque groupe comme un champ unique).
  fields: ConfigField[] | ConfigFieldGroup[];
  icon?: string;
}

/** Groupe de champs de configuration (ex: "MQTT", "Logging") — miroir de core/src/types/config.ts. */
export interface ConfigFieldGroup {
  title?: string;
  description?: string;
  icon?: string;
  fields: ConfigField[];
}

export interface ConfigField {
  name: string;
  label: string;
  type: 'text' | 'string' | 'number' | 'boolean' | 'select' | 'password' | 'array' | 'button';
  default?: any;
  placeholder?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  // Uniquement pour type: 'button' — voir types/config.ts (copie côté navigateur, même
  // convention `${action}:result`).
  action?: string;
  confirm?: string;
  options?: { value: string; label: string }[] | string[];
  hint?: string;
  autocomplete?: string;
  // Uniquement pour type: 'array' — liste avec ajout/suppression dynamique (ex: sources MQTT
  // multiples de nommage), rendue par Alpine (x-for/x-model) dans ModuleManager. itemFields
  // décrit la forme d'un élément (peut inclure des chemins pointés type "mqtt.host", résolus par
  // le même mécanisme que les champs plats). Le tableau lui-même ne peut pas être imbriqué
  // (itemFields ne supporte pas de sous-champ de type 'array').
  itemFields?: ConfigField[];
  itemLabel?: string;
  minItems?: number;
}

/** Vrai si l'élément est un groupe de champs plutôt qu'un champ isolé. */
export function isConfigFieldGroup(item: ConfigField | ConfigFieldGroup): item is ConfigFieldGroup {
  return 'fields' in item;
}

export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  message: string;
}

export type { Socket };
