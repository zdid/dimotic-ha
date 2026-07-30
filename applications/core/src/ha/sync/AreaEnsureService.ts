// src/ha/sync/AreaEnsureService.ts
// Garantit l'existence d'une area HA à partir d'un nom de "lieu" de taxonomie — appelé par
// IntegrationBridge avant de publier une découverte MQTT portant device.suggested_area.
//
// Contexte : suggested_area s'est révélé être une simple suggestion pour l'UI HA, jamais
// auto-appliquée silencieusement (vérifié en conditions réelles — suppression + redécouverte
// complète d'une entité, puis redémarrage complet de HA : area_id reste null dans les deux cas).
// Ce service crée donc l'area nous-mêmes via l'API WebSocket de HA (déterministe), plutôt que de
// dépendre de ce comportement opaque.

import type { HaWsClient } from './HaWsClient';
import type { HaStructureRegistry } from './HaStructureRegistry';
import type { IEventBus } from '../../application/IEventBus';
import type { Logger } from '../../infrastructure/logger/index';

const ENSURE_TIMEOUT_MS = 8000;

export class AreaEnsureService {
  /**
   * Résolue une fois pour toutes dès que le référentiel HA (areas comprises) est chargé — voir
   * waitUntilRegistryReady. Attendre seulement l'authentification WS ne suffit pas : le
   * chargement du référentiel (AppService.loadHaRegistry, qui peuple HaStructureRegistry) est
   * lui-même asynchrone et déclenché séparément sur le même événement de connexion — sans
   * attendre `ha:ready`, findByName tournait à vide sur un registre encore incomplet et
   * déclenchait des créations en double, rejetées par HA ("name already in use") — constaté en
   * conditions réelles.
   */
  private registryReady = false;
  private registryReadyPromise?: Promise<void>;

  /**
   * Demandes de création en cours, par nom capitalisé — au démarrage, de nombreuses entités
   * partageant le même lieu (ex: 8 données EVOO7 sous "Pompe à chaleur") appellent ensureArea
   * quasi simultanément ; sans ce partage, chacune passe le contrôle findByName (aucune n'a encore
   * eu le temps de mettre à jour le cache) et déclenche sa propre création concurrente — constaté
   * en conditions réelles (une seule création WS gagnante par nom, les autres rejetées).
   */
  private pendingCreations: Map<string, Promise<string | undefined>> = new Map();

  constructor(
    private readonly haWsClient: HaWsClient,
    private readonly haStructureRegistry: HaStructureRegistry,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger
  ) {}

  /**
   * Garantit qu'une area du nom donné existe (la crée si nécessaire), et retourne son area_id.
   * Best-effort : timeout interne, ne lève jamais — un échec/dépassement retourne `undefined`,
   * l'appelant publie la découverte sans area, comme si suggested_area n'avait pas été fourni.
   */
  async ensureArea(rawName: string): Promise<string | undefined> {
    const name = this.capitalize(rawName);
    if (!name) return undefined;

    const pending = this.pendingCreations.get(name);
    if (pending) return pending;

    const creation = this.resolveOrCreate(name).finally(() => this.pendingCreations.delete(name));
    this.pendingCreations.set(name, creation);
    return creation;
  }

  private async resolveOrCreate(name: string): Promise<string | undefined> {
    try {
      return await this.withTimeout(this.waitThenResolveOrCreate(name), ENSURE_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.warn('ha:area_ensure', `Échec de la garantie d'area "${name}": ${message}`);
      return undefined;
    }
  }

  private async waitThenResolveOrCreate(name: string): Promise<string> {
    await this.waitUntilRegistryReady();

    const existing = this.findByName(name);
    if (existing) return existing.area_id;

    const created = await this.haWsClient.createArea(name);
    // Mis à jour immédiatement (pas seulement via l'événement area_registry_updated poussé de
    // façon asynchrone par HA) — sinon une deuxième demande concurrente pour un nom légèrement
    // différent mais convergent ne le verrait pas encore.
    this.haStructureRegistry.addArea(created);
    this.logger.info('ha:area_ensure', `Area créée: ${created.area_id} (${created.name})`);
    return created.area_id;
  }

  private waitUntilRegistryReady(): Promise<void> {
    if (this.registryReady) return Promise.resolve();
    if (!this.registryReadyPromise) {
      this.registryReadyPromise = new Promise((resolve) => {
        this.eventBus.onGeneric('ha:ready', () => {
          this.registryReady = true;
          resolve();
        });
      });
    }
    return this.registryReadyPromise;
  }

  private findByName(name: string): { area_id: string } | undefined {
    const lower = name.toLowerCase();
    return this.haStructureRegistry.getAllAreas().find((area) => area.name.toLowerCase() === lower);
  }

  private capitalize(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '';
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout après ${ms}ms`)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }
}
