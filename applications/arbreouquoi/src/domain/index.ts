import type { ApplicationModule } from '../../../core/dist/types/config';
import { ARBREOUQUOI_SOCKET_EVENTS } from './socket-events';

// ⚠️ ARBREOUQUOI n'a aucun réglage persisté : filterByArea/filterByQuoi/showOnlyActive étaient
// déclarés ici comme configUi (donc affichés à tort sous "Paramètres Techniques"), alors que ce
// sont des filtres de vue transitoires. showOnlyActive est désormais un vrai contrôle dans la
// barre d'outils de la fenêtre ARBREOUQUOI elle-même (voir presentation/index.html + ts/app.ts),
// câblé sur l'événement arbreouquoi:filter:set déjà géré côté serveur. filterByArea/filterByQuoi
// n'ont pas d'équivalent backend réel (FilterOptions ne porte que showOnlyActive/sortBy/sortOrder)
// et ne sont donc pas repris — les construire serait une nouvelle fonctionnalité, pas un correctif.

// Déclaration du module
export const ARBREOUQUOI_APP: ApplicationModule = {
  id: 'arbreouquoi',
  name: 'Arbre Où Quoi',
  description: 'Application de visualisation du référentiel Home Assistant organisé par Area → QUOI → Entités',
  icon: '🌳',
  type: 'standalone',
  audience: 'inspection',
  configurable: true,
  requiredMqtt: false,
  requiredHaWs: true,
  socketEvents: ARBREOUQUOI_SOCKET_EVENTS,
  configSection: 'arbreouquoi'
};

// Factories
export * from './ArbreouquoiService';
export * from './socket-events';
export * from './config-schema';
export * from './types';
