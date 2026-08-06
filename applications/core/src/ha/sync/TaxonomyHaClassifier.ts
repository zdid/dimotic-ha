// =============================================================================
// TaxonomyHaClassifier - Classification réelle des entités en catégories QUOI
//
// Remplace DefaultHaClassifier (qui ne classe jamais rien) — nécessaire pour que
// HaStructureRegistry.getEntitiesByQuoi()/getEntitiesByAreaAndQuoi() (utilisés par
// ArbreOùQuoi, et par les outils de l'application `ia`/la résolution de `planificateur`)
// trouvent effectivement des entités.
//
// Deux niveaux de résolution, dans cet ordre :
//   1. Taxonomie déjà posée par une application métier (RFXCOM, AREXX, EVOO7, Nommage) —
//      toutes publient un attribut `attributs_taxonomie` dans l'état MQTT de chaque entité
//      (buildAttributsTaxonomie(), même forme dans les 4 apps). Si présent, on l'utilise
//      tel quel : la taxonomie a déjà été calculée à la source, aucune déduction à refaire.
//   2. Repli sur les données brutes HA (domain, device_class) pour toute entité qui n'a
//      jamais transité par l'une de ces 4 apps — la majorité des entités HA natives. Une
//      taxonomie "virtuelle" (même forme que attributs_taxonomie, marquée `virtuel: true`)
//      est alors écrite sur l'entité, pour que tout consommateur en aval (UI, autres apps)
//      voie une structure cohérente, réelle ou déduite.
// =============================================================================

import type { HaStructuredEntity } from '../types/ha-entity';
import type { IHaClassifier, HaQuoiDefinition } from '../types/ha-structure';

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
  virtuel?: boolean;
}

interface QuoiFallback {
  quoi_id: string;
  label: string;
}

// Vocabulaire aligné sur regles_mistral.txt §0.1 (table verbe→quoi) quand un équivalent existe,
// complété pour couvrir les domaines/device_class HA usuels non mentionnés dans cette table.
const DEVICE_CLASS_QUOI_MAP: Record<string, QuoiFallback> = {
  temperature: { quoi_id: 'temperature', label: 'Température' },
  humidity: { quoi_id: 'humidite', label: 'Humidité' },
  power: { quoi_id: 'puissance', label: 'Puissance' },
  current: { quoi_id: 'amperage', label: 'Ampérage' },
  energy: { quoi_id: 'energie', label: 'Énergie' },
  voltage: { quoi_id: 'tension', label: 'Tension' },
  illuminance: { quoi_id: 'luminosite', label: 'Luminosité' },
  motion: { quoi_id: 'presence', label: 'Présence' },
  occupancy: { quoi_id: 'presence', label: 'Présence' },
  presence: { quoi_id: 'presence', label: 'Présence' },
  door: { quoi_id: 'ouverture', label: 'Ouverture' },
  window: { quoi_id: 'ouverture', label: 'Ouverture' },
  opening: { quoi_id: 'ouverture', label: 'Ouverture' },
  garage_door: { quoi_id: 'portail', label: 'Portail' },
  smoke: { quoi_id: 'fumee', label: 'Fumée' },
  moisture: { quoi_id: 'humidite', label: 'Humidité' },
  battery: { quoi_id: 'batterie', label: 'Batterie' },
  connectivity: { quoi_id: 'connectivite', label: 'Connectivité' }
};

const DOMAIN_QUOI_MAP: Record<string, QuoiFallback> = {
  light: { quoi_id: 'lumiere', label: 'Lumière' },
  climate: { quoi_id: 'temperature', label: 'Température' },
  water_heater: { quoi_id: 'ballon', label: 'Ballon' },
  lock: { quoi_id: 'serrure', label: 'Serrure' },
  fan: { quoi_id: 'ventilateur', label: 'Ventilateur' },
  humidifier: { quoi_id: 'humidite', label: 'Humidité' },
  dehumidifier: { quoi_id: 'humidite', label: 'Humidité' },
  media_player: { quoi_id: 'media', label: 'Média' },
  vacuum: { quoi_id: 'aspirateur', label: 'Aspirateur' }
  // Volontairement absents : "switch"/"cover"/"sensor"/"binary_sensor" — trop génériques au
  // niveau domain seul, mieux résolus par device_class (voir DEVICE_CLASS_QUOI_MAP) ; sans
  // device_class exploitable, l'entité reste non classée plutôt que mal classée.
};

// Lieu par défaut pour une entité sans zone HA assignée (taxonomie virtuelle uniquement).
const DEFAULT_LIEU = 'maison';

export class TaxonomyHaClassifier implements IHaClassifier {
  private readonly catalog = new Map<string, HaQuoiDefinition>();

  classify(entity: HaStructuredEntity): string[] {
    const existing = entity.attributes?.attributs_taxonomie as AttributsTaxonomie | undefined;
    if (existing?.slug_quoi) {
      this.registerQuoi(existing.slug_quoi, existing.quoi || existing.slug_quoi);
      return [existing.slug_quoi];
    }

    const fallback = this.resolveFallback(entity);
    if (!fallback) return [];

    this.registerQuoi(fallback.quoi_id, fallback.label);

    if (!entity.attributes?.attributs_taxonomie) {
      // Pas de zone HA assignée : "maison" plutôt que null — une entité reste rattachée à un
      // lieu par défaut plutôt que de sortir de toute hiérarchie OÙ. Nom d'affichage de l'area
      // (entity.area?.name, ex: "Chambre de Jo") plutôt que son area_id brut (ex: "chambre_de_jo")
      // quand disponible — corrige un titre affichant le slug non mis en forme (06/08/2026).
      const lieu = entity.area?.name || entity.area_id || DEFAULT_LIEU;
      const lieuPrecis = this.deriveLieuPrecis(entity);
      const virtualTaxonomy: AttributsTaxonomie = {
        quoi: fallback.label,
        slug_quoi: fallback.quoi_id,
        lieu_principal: lieu,
        slug_lieu: entity.area_id || lieu,
        lieu_precis: lieuPrecis,
        slug_precis: lieuPrecis,
        lieu_pere: null,
        slug_pere: null,
        lieu_grand_pere: null,
        slug_grand_pere: null,
        virtuel: true
      };
      // Nouvel objet (pas de mutation en place) : entity.attributes référence encore
      // rawEntity.attributes à ce stade (createStructuredEntity ne copie pas) — muter en
      // place propagerait le changement vers l'entité brute HA, non désiré.
      entity.attributes = { ...entity.attributes, attributs_taxonomie: virtualTaxonomy };
    }

    return [fallback.quoi_id];
  }

  getQuoiCatalog(): HaQuoiDefinition[] {
    return [...this.catalog.values()];
  }

  private registerQuoi(quoiId: string, label: string): void {
    if (!this.catalog.has(quoiId)) {
      this.catalog.set(quoiId, { quoi_id: quoiId, label });
    }
  }

  /**
   * Dérive un qualificatif de précision (lieu_precis) à partir du nom du device HA — ex: pour
   * une entité "has_entity_name" (norme récente HA/MQTT), `friendly_name` est calculé par HA
   * comme `{device.name} {nom propre de l'entité}` (ex: "-chevets" + " " + "L2" = "-chevets L2",
   * observé en direct sur une entité Zigbee2MQTT le 06/08/2026 — device.name lui-même hérité
   * d'un renommage en masse antérieur, d'où le tiret de tête à nettoyer). On reconstitue ce
   * qualificatif en nettoyant device.name plutôt qu'en le lisant du registre HA (non transmis
   * jusqu'ici par HaStructuredEntity) — repli sur `null` si le schéma ne correspond pas
   * (entité sans device, ou friendly_name qui ne commence pas par device.name).
   */
  private deriveLieuPrecis(entity: HaStructuredEntity): string | null {
    const deviceName = entity.device?.name?.trim();
    if (!deviceName) return null;

    const cleanedDeviceName = deviceName.replace(/^[-_\s]+/, '').trim();
    if (!cleanedDeviceName) return null;

    const friendlyName = entity.friendly_name?.trim();
    if (friendlyName && friendlyName.startsWith(deviceName)) {
      const remainder = friendlyName.slice(deviceName.length).trim();
      if (remainder) return `${cleanedDeviceName} ${remainder}`;
    }

    return cleanedDeviceName;
  }

  private resolveFallback(entity: HaStructuredEntity): QuoiFallback | undefined {
    if (entity.device_class && DEVICE_CLASS_QUOI_MAP[entity.device_class]) {
      return DEVICE_CLASS_QUOI_MAP[entity.device_class];
    }
    if (entity.domain && DOMAIN_QUOI_MAP[entity.domain]) {
      return DOMAIN_QUOI_MAP[entity.domain];
    }
    return undefined;
  }
}
