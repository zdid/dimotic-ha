/**
 * Construction de l'arbre OÙ→QUOI→entités pour le sélecteur d'entité du tableau de bord (voir
 * plan de portage Phase 2). La hiérarchie OÙ ne vient PAS de HaStructureRegistry/des areas HA
 * (plates, aucune notion parent/enfant) mais de `attributs_taxonomie`, déjà porté par chaque
 * entité (publié par les intégrations MQTT du projet — RFXCOM/EVOO7/nommage). Même source que
 * `arbreouquoi` (voir ArbreouquoiService.ts::extractOuPathFromEntity), en plus simple : un seul
 * niveau OÙ (le lieu le plus précis disponible) au lieu de la hiérarchie complète à 4 niveaux —
 * suffisant pour un sélecteur, pas besoin de la richesse de l'arbre arbreouquoi.
 *
 * Construit directement la forme attendue par le composant client déjà porté tel quel
 * `components/EntitySelector.ts` ({id,name,devices:[{id,name,entities:{...}}]}, historiquement
 * Pièce→Appareil→Entités) — OÙ tient lieu de "Pièce", QUOI de "Appareil". Aucune modification de
 * ce fichier client nécessaire.
 */

import type { HaStructuredEntity } from '../../../core/src/exports';

interface EntityPickerEntity {
  entity_id: string;
  name: string;
}

interface EntityPickerDeviceNode {
  id: string;
  name: string;
  entities: Record<string, EntityPickerEntity>;
}

export interface EntityPickerAreaNode {
  id: string;
  name: string;
  devices: EntityPickerDeviceNode[];
}

interface AttributsTaxonomie {
  quoi?: string | null;
  slug_quoi?: string | null;
  lieu_principal?: string | null;
  slug_lieu?: string | null;
  lieu_precis?: string | null;
  slug_precis?: string | null;
  lieu_pere?: string | null;
  slug_pere?: string | null;
  lieu_grand_pere?: string | null;
  slug_grand_pere?: string | null;
}

const UNCLASSIFIED_ID = '__non_classe__';
const UNCLASSIFIED_NAME = 'Non classé';
const OTHER_QUOI_ID = '__autre__';
const OTHER_QUOI_NAME = 'Autre';

export function buildEntityPickerTree(entities: HaStructuredEntity[]): EntityPickerAreaNode[] {
  const areasById = new Map<string, { name: string; devicesById: Map<string, EntityPickerDeviceNode> }>();

  for (const entity of entities) {
    const taxonomie = (entity.attributes?.attributs_taxonomie ?? undefined) as AttributsTaxonomie | undefined;

    const areaId = taxonomie?.slug_precis || taxonomie?.slug_lieu || taxonomie?.slug_pere || taxonomie?.slug_grand_pere || UNCLASSIFIED_ID;
    const areaName = taxonomie?.lieu_precis || taxonomie?.lieu_principal || taxonomie?.lieu_pere || taxonomie?.lieu_grand_pere || UNCLASSIFIED_NAME;

    const quoiId = taxonomie?.slug_quoi || OTHER_QUOI_ID;
    const quoiName = taxonomie?.quoi || OTHER_QUOI_NAME;

    if (!areasById.has(areaId)) {
      areasById.set(areaId, { name: areaName, devicesById: new Map() });
    }
    const area = areasById.get(areaId)!;

    if (!area.devicesById.has(quoiId)) {
      area.devicesById.set(quoiId, { id: quoiId, name: quoiName, entities: {} });
    }
    const device = area.devicesById.get(quoiId)!;

    const friendlyName = typeof entity.friendly_name === 'string' && entity.friendly_name ? entity.friendly_name : entity.entity_id;
    device.entities[entity.entity_id] = { entity_id: entity.entity_id, name: friendlyName };
  }

  return Array.from(areasById.entries())
    .map(([id, area]) => ({
      id,
      name: area.name,
      devices: Array.from(area.devicesById.values())
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
