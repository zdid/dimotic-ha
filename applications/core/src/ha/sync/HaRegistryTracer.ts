import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { Logger } from '../../infrastructure/logger/index';
import { HaStructuredRegistry } from '../types/ha-structure';

// =============================================================================
// HaRegistryTracer - Traces de debug pour le référentiel structuré HA
//
// Deux fichiers dans data/, actifs uniquement en mode debug (logging.level: debug) :
// - machine_ha-structure-debug.yaml (⭐ 29/09/2026, préfixe machine_ : jamais reproduit) : instantané complet de l'arbre (réécrit à chaque changement)
// - machine_ha-structure-changes.yaml : journal des ajouts/suppressions/mises à jour d'entités,
//   lieux (areas) et devices — jamais les changements d'état — vidé à chaque démarrage.
// =============================================================================

export interface HaRegistryChangeEntry {
  type: 'area' | 'device' | 'entity';
  action: 'create' | 'update' | 'delete';
  id: string;
  name?: string;
}

export class HaRegistryTracer {
  private readonly dataDir: string;
  private readonly snapshotPath: string;
  private readonly changeLogPath: string;

  constructor(
    private readonly logger: Logger,
    dataDir?: string
  ) {
    this.dataDir = dataDir || path.dirname(process.env.CONFIG_PATH || '/app/data/core/config.yaml');
    this.snapshotPath = path.join(this.dataDir, 'machine_ha-structure-debug.yaml');
    this.changeLogPath = path.join(this.dataDir, 'machine_ha-structure-changes.yaml');
  }

  private isDebugActive(): boolean {
    return this.logger.getLevel() === 'debug';
  }

  /**
   * (Re)crée le journal des changements vide — à appeler une fois au démarrage.
   */
  resetChangeLog(): void {
    if (!this.isDebugActive()) return;

    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.changeLogPath, '', 'utf-8');
      this.logger.debug('ha:registry_tracer', `Journal des changements réinitialisé: ${this.changeLogPath}`);
    } catch (error) {
      this.logger.error('ha:registry_tracer', `Échec de réinitialisation du journal des changements: ${error}`);
    }
  }

  /**
   * Ajoute une entrée au journal des changements (area/device/entity, jamais un état).
   */
  logChange(entry: HaRegistryChangeEntry): void {
    if (!this.isDebugActive()) return;

    try {
      const doc = yaml.dump(
        { timestamp: new Date().toISOString(), ...entry },
        { indent: 2 }
      );
      fs.appendFileSync(this.changeLogPath, `---\n${doc}`, 'utf-8');
    } catch (error) {
      this.logger.error('ha:registry_tracer', `Échec d'écriture du journal des changements: ${error}`);
    }
  }

  /**
   * Réécrit l'instantané complet de l'arbre structuré (area → QUOI → entités).
   * Projection volontairement acyclique : les Map ne se sérialisent pas telles quelles, et les
   * références croisées (entity.area/entity.device, quoi.entities) créeraient des cycles —
   * les entités ne référencent leur area/device que par id, jamais par objet complet.
   */
  writeSnapshot(registry: HaStructuredRegistry): void {
    if (!this.isDebugActive()) return;

    try {
      const projectArea = (area: HaStructuredRegistry['unassigned']) => {
        if (!area) return undefined;
        return {
          area_id: area.area_id,
          name: area.name,
          quoi: Array.from(area.quoiMap.values()).map((quoi) => ({
            quoi_id: quoi.quoi_id,
            label: quoi.label,
            entities: quoi.entities.map((e) => ({
              entity_id: e.entity_id,
              friendly_name: e.friendly_name,
              domain: e.domain,
              device_id: e.device_id,
            })),
          })),
        };
      };

      const snapshot = {
        lastFullSync: registry.lastFullSync.toISOString(),
        entityCount: registry.entityCount,
        areaCount: registry.areaCount,
        deviceCount: registry.deviceCount,
        areas: Array.from(registry.areas.values()).map((area) => projectArea(area)),
        unassigned: projectArea(registry.unassigned),
        devices: Array.from(registry.devices.values()).map((device) => ({
          device_id: device.device_id,
          name: device.name,
          area_id: device.area_id,
          manufacturer: device.manufacturer,
          model: device.model,
          entity_ids: device.entities.map((e) => e.entity_id),
        })),
      };

      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.snapshotPath, yaml.dump(snapshot, { indent: 2 }), 'utf-8');
    } catch (error) {
      this.logger.error('ha:registry_tracer', `Échec d'écriture de l'instantané du référentiel: ${error}`);
    }
  }
}
