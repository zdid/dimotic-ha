import type { HaStructuredEntity } from '../../../core/dist/ha/types/ha-entity';
import type { HaArea, HaDevice, HaQuoiDefinition } from '../../../core/dist/ha/types/ha-structure';

// Types spécifiques à l'application ArbreOuquoi
// Basés sur la hiérarchie OÙ : Grand-Père → Père → Lieu → Lieu Précis

// Niveau de la hiérarchie OÙ
export type OuLevel = 'grand_pere' | 'pere' | 'lieu' | 'lieu_precis';

// Noeud de la hiérarchie OÙ (un seul niveau)
export interface OuNode {
  id: string;
  name: string;
  level: OuLevel;
  children: OuNode[];
  entities: HaStructuredEntity[];
  entityCount: number;
  parentId: string | null;
}

// Structure pour un OÙ avec ses QUOI
export interface OuWithQuoiNode {
  ou: OuNode;
  children: QuoiGroup[];
  entityCount: number;
}

// Structure pour le mode OÙ-first (hiérarchie OÙ → QUOI → Entités)
export interface OuFirstTree {
  levels: OuWithQuoiNode[]; // Niveau racine (grand-pere, pere, lieu, lieu_precis)
  unassigned: EntityInfo[];
  totalEntities: number;
  totalOuNodes: number;
  totalQuoiTypes: number;
}

// Structure pour le mode QUOI-first (QUOI → hiérarchie OÙ → Entités)
export interface QuoiFirstTree {
  quoiGroups: QuiGroupWithOu[];
  unassigned: EntityInfo[];
  totalEntities: number;
  totalQuoiTypes: number;
  totalOuNodes: number;
}

// Groupe QUOI avec hiérarchie OÙ
export interface QuiGroupWithOu {
  quoi: HaQuoiDefinition;
  entityCount: number;
  ouHierarchy: OuNode[]; // La hiérarchie OÙ pour ce QUOI
  // Record, pas Map : cette structure part sur le fil (Socket.io) — un Map se sérialise en objet
  // vide ({}) côté client (pas de support natif dans socket.io-parser/JSON), ce qui faisait
  // planter le rendu client (`entitiesByOu.get is not a function`) dès que ce champ contenait
  // vraiment des entités (jamais arrivé avant le classifieur QUOI réel de cette session).
  entitiesByOu: Record<string, HaStructuredEntity[]>; // OÙ ID → Entités
}

// Groupe QUOI classique
export interface QuoiGroup {
  quoi: HaQuoiDefinition;
  entities: HaStructuredEntity[];
  count: number;
}

// Informations sur une entité
export interface EntityInfo {
  entity: HaStructuredEntity;
  ouPath: string[]; // Chemin complet dans la hiérarchie OÙ
  quoiIds: string[];
  device: HaDevice | null;
  area: HaArea | null;
}

// Structure pour le catalogue QUOI avec compteurs
export interface QuoiCatalogWithCounts {
  quoi: HaQuoiDefinition;
  entityCount: number;
  ouPaths: string[]; // Chemins OÙ où ce QUOI apparaît
}

// Filtrage et tri
export interface FilterOptions {
  showOnlyActive?: boolean;
  sortBy?: 'name' | 'entityCount';
  sortOrder?: 'asc' | 'desc';
}

// Paysload pour les événements Socket.io
export interface ArbreOuQuoiTreePayload {
  // Selon le mode, soit ouFirstTree soit quoiFirstTree
  tree: OuFirstTree | QuoiFirstTree;
  viewMode: 'ou-first' | 'quoi-first';
  catalog: QuoiCatalogWithCounts[];
  timestamp: string;
}

export interface ArbreOuQuoiEntityDetailsPayload {
  entity: HaStructuredEntity;
  // Chaque segment porte son niveau réel (pas déduit côté client de sa position — voir le
  // correctif du 08/08/2026 sur ArbreouquoiService.extractOuSegments, même raison).
  ouPath: Array<{ name: string; level: 'grand_pere' | 'pere' | 'lieu' | 'lieu_precis' }>;
  area: HaArea | null;
  device: HaDevice | null;
  quiIds: string[];
  relatedEntities: EntityInfo[];
}

// Configuration de l'affichage
export interface DisplayConfig {
  expandAll: boolean;
  showEntityIds: boolean;
  showQuoiIcons: boolean;
  theme: 'light' | 'dark' | 'auto';
  viewMode: 'ou-first' | 'quoi-first';
}
