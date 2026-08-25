/**
 * Point d'entrée de l'application UI
 * Initialise les services, managers et composants
 */

import { SocketService } from './services/SocketService';
import { TechnicalConfigManager } from './config/TechnicalConfigManager';
import { ModuleManager } from './config/ModuleManager';
import { ApplicationManager } from './config/ApplicationManager';
import { EventBus } from './services/EventBus';

// Import des composants pour déclencher leur registration
import './components/Sidebar';
import './components/ConfigForm';
import './components/ModuleContainer';
import './components/ApplicationsManager';
import './components/DeploymentManager';
import './components/PostInstallManager';
import './components/LogsModal';

// Étendre l'interface Window
declare global {
  interface Window {
    app: {
      socketService: SocketService;
      configManager: TechnicalConfigManager;
      moduleManager: ModuleManager;
      appManager: ApplicationManager;
      eventBus: EventBus;
      /** ⭐ fonctionnelles-supervisor_specs v2.6 — identité de la machine visitée (core.machineId),
       *  reçue une fois via 'app:machine-id' (événement persistant, voir AppService.registerCoreSocketEvents).
       *  undefined jusqu'à réception — chaque écran d'application qui veut l'afficher doit tolérer
       *  cette absence initiale. */
      machineId?: string;
    };
  }
}

// Initialiser le socket
const socketService = new SocketService();
const socket = socketService.connect();

// Initialiser les managers
const configManager = new TechnicalConfigManager(socket);
const moduleManager = new ModuleManager(socket);
const appManager = new ApplicationManager(socket);

// Initialiser EventBus
const eventBus = EventBus.getInstance();

// Exposer les instances globalement (pour les composants qui en ont besoin)
window.app = {
  socketService,
  configManager,
  moduleManager,
  appManager,
  eventBus
};

// ======================================================================
// ÉCOUTEURS GLOBAUX
// ======================================================================

// Écouter le chargement du DOM
window.addEventListener('DOMContentLoaded', () => {
  console.log('[App] DOM chargé, application initialisée');
  
  // Les Web Components s'initialisent automatiquement
  // via customElements.define() dans leurs fichiers respectifs
});

// ⭐ fonctionnelles-supervisor_specs v2.6 — identité de la machine, persistant (rejoué à la
// reconnexion, voir AppService.registerCoreSocketEvents). `address` ajoutée le 24/08/2026 pour
// l'affichage version+hôte de Sidebar.ts — dispatché en CustomEvent (même patron que app:started/
// uptime, TechnicalConfigManager.ts) pour que Sidebar puisse réagir sans ordre de chargement figé.
socket.on('app:machine-id', (data: { machineId: string; address?: string }) => {
  window.app.machineId = data.machineId;
  window.dispatchEvent(new CustomEvent('app:machine-id', { detail: data }));
});

// Écouter les erreurs Socket.io
socket.on('connect_error', (error: Error) => {
  console.error('[Socket] Erreur de connexion:', error.message);
  window.dispatchEvent(new CustomEvent('socket:error', {
    detail: { message: error.message }
  }));
});

// Écouter la connexion réussie
socket.on('connect', () => {
  console.log('[Socket] Connecté au serveur');
  window.dispatchEvent(new CustomEvent('socket:connected'));
});

// Écouter la déconnexion
socket.on('disconnect', () => {
  console.log('[Socket] Déconnecté du serveur');
  window.dispatchEvent(new CustomEvent('socket:disconnected'));
});

// Écouter la liste des modules
socket.on('app:modules:list', (data: { modules: any[] }) => {
  console.log('[App] Modules reçus:', data.modules.length);
});

// ======================================================================
// EXPORT POUR TESTS
// ======================================================================

export {
  socketService,
  configManager,
  moduleManager,
  appManager,
  eventBus
};
