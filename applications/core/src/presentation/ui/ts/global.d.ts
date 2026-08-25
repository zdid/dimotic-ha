// ======================================================================
// Déclarations de types globaux pour l'application UI
// ======================================================================

import { Socket } from 'socket.io-client';

// Déclarer Socket.io comme variable globale
declare const io: (
  url: string,
  options?: {
    reconnection?: boolean;
    reconnectionDelay?: number;
    reconnectionDelayMax?: number;
    timeout?: number;
    transports?: string[];
  }
) => Socket;

// Étendre Window avec l'application
declare global {
  interface Window {
    app: {
      socketService: any;
      configManager: any;
      moduleManager: any;
      appManager: any;
      eventBus: any;
    };
    Alpine: any;
  }
  
  // Permettre les custom events
  interface WindowEventMap {
    // Socket events
    'socket:connected': CustomEvent;
    'socket:disconnected': CustomEvent;
    'socket:error': CustomEvent<{ message: string }>;
    'socket:reconnected': CustomEvent;
    
    // Config events
    'config:updated': CustomEvent<{ config: any }>;
    'config:validation:updated': CustomEvent<any>;
    // Résultat réel de config:save:result (sections statiques) — nom sans ':' (contrairement à
    // l'événement socket.io homonyme) pour rester utilisable tel quel dans un sélecteur Alpine
    // x-on:config-save-result.window, qui ne supporte pas les ':' au milieu d'un nom d'événement.
    'config-save-result': CustomEvent<{ success: boolean; message?: string }>;

    // Module events
    'app-modules-loaded': CustomEvent<{ modules: any[] }>;
    'module:activated': CustomEvent<{ moduleId: string; module?: any }>;
    'module:config:loaded': CustomEvent<{ moduleId: string; config: any }>;
    'module:field:updated': CustomEvent<{ moduleId: string; fieldName: string; value: any }>;
    'module:content:loaded': CustomEvent<{ moduleId: string }>;
    // Résultat réel de app:module:config:saved — même raison que config-save-result ci-dessus.
    'module-config-save-result': CustomEvent<{ moduleId: string; success: boolean; error?: string }>;
    
    // Application events
    'applications:loaded': CustomEvent<{ activated: string[]; disabled: string[] }>;
    'applications:enabling': CustomEvent<{ appId: string }>;
    'applications:disabling': CustomEvent<{ appId: string }>;
    'applications:error': CustomEvent<{ message: string }>;
    
    // HA events
    'ha:status:changed': CustomEvent<{ isConnected: boolean }>;
    'mqtt:status:changed': CustomEvent<{ isConnected: boolean }>;
    'app:started': CustomEvent<{ uptime: number; version?: string }>;
    'app:machine-id': CustomEvent<{ machineId: string; address?: string }>;
    
    // Other events
    'logs:new': CustomEvent<any>;
    'logs:batch': CustomEvent<{ logs: any[] }>;
    'scroll-to-section': CustomEvent<{ sectionId: string }>;
  }
}

// Interface pour les modules
declare interface Module {
  id: string;
  name: string;
  icon: string;
  status: 'configured' | 'partial' | 'missing' | 'error';
  configUi?: ModuleUiMetadata;
}

declare interface ModuleUiMetadata {
  title: string;
  description: string;
  fields: ConfigField[];
  icon?: string;
}

declare interface ConfigField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'password';
  default?: any;
  placeholder?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  hint?: string;
  autocomplete?: string;
}

// Interface pour les événements
declare interface AppEventDetail {
  [key: string]: any;
}
