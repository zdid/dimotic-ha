/**
 * Types du domaine HAPLAN
 *
 * Portage de haplanserver (github.com/zdid/haplanserver) — plans de maison (images) avec des
 * icônes tactiles positionnées dessus, reliées à des entités HA existantes (lecture d'état +
 * envoi de commandes directement via HaWsClient, pas de découverte MQTT propre à cette app).
 */

/** Position d'une icône (entité) sur un plan — coordonnées normalisées 0-1, null tant que non placée. */
export interface HaplanPosition {
  entity_id: string;
  x: number | null;
  y: number | null;
}

/** Un plan (image de fond + icônes placées dessus). */
export interface HaplanFloorplan {
  filename: string;
  positions: HaplanPosition[];
}

export interface HaplanFloorplansFile {
  floorplans: Record<string, HaplanFloorplan>;
}

/** État courant d'une entité HA, tel que republié vers le client (sous-ensemble utile à l'affichage). */
export interface HaplanEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export interface HaplanStatus {
  haWsConnected: boolean;
  floorplansCount: number;
  entitiesCount: number;
}
