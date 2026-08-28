/**
 * HaplanService
 *
 * Orchestrateur principal de l'application HAPLAN — portage de haplanserver
 * (github.com/zdid/haplanserver, voir le plan de portage). Phase 1 : affichage des plans déjà
 * définis (positions importées), état en direct et commandes sur les entités déjà placées.
 *
 * Contrairement à RFXCOM/EVOO7, cette application ne publie AUCUNE découverte MQTT : elle
 * lit/écrit directement des entités HA déjà existantes via HaBridgeClient (⭐ 24/08/2026, façade
 * générique vers `core`, voir HaBridgeClient.ts — remplace HaStructureRegistry/HaWsClient en
 * direct, non transportables hors du process de `core`) — getAllEntities() pour l'instantané
 * initial des états, sendCommand()/onStateChanged() pour piloter et recevoir les changements en
 * direct.
 *
 * Couche : Domaine (Métier) — orchestration uniquement, délègue à ConfigFileManager.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { IEventBus, Logger, IAppConfigProvider, HaBridgeClient, HaRawEntity } from '../../../core/dist/exports';
import { createHaplanError } from '../../../core/dist/exports';
import { haplanConfigSchema, type HaplanConfig } from './config-schema';
import { DEFAULT_FLOORPLANS_CONFIG, type HaplanFloorplansConfigFile } from './floorplans-config-schema';
import type { HaplanStatus } from './types';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { HAPLAN_SOCKET_EVENTS, HAPLAN_CLIENT_EVENTS, HAPLAN_ALL_EVENTS, HAPLAN_PERSISTENT_EVENTS } from './socket-events';
import { buildEntityPickerTree } from './taxonomy-tree';
import type { HaplanPositionEntry } from './floorplans-config-schema';
import { buildLovelaceDashboardYaml } from './lovelace-generator';
import { flattenPngOntoDarkBackground } from './image-flatten';
import { readImageDimensions, type ImageDimensions } from './image-dimensions';

const MODULE_NAME = 'haplan';

/** Doit rester synchronisé avec la liste blanche `fileFilter` de la route d'upload
 *  (PresentationServer.ts, POST /api/haplan/floorplans/upload). */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
};

/** Même logique que `sanitizeFloorplanBaseName` du haplanserver original (routes.ts) —
 *  alphanumérique/tiret/underscore uniquement, jamais vide. */
function sanitizeFloorplanFilename(id: string): string {
  const trimmed = id.trim();
  const sanitized = trimmed.replace(/[^a-zA-Z0-9-_]/g, '_').replace(/_+/g, '_');
  return sanitized.length > 0 ? sanitized : 'plan';
}

export interface IHaplanService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): HaplanStatus;
}

interface EntityCommandPayload {
  entity_id: string;
  domain: string;
  service: string;
  serviceData?: Record<string, unknown>;
}

export class HaplanService implements IHaplanService {
  private config: HaplanConfig;
  private floorplansConfig: HaplanFloorplansConfigFile = DEFAULT_FLOORPLANS_CONFIG;
  private configFileManager: ConfigFileManager;
  /** entity_id de toutes les entités présentes sur au moins un plan — seules celles-ci sont
   *  republiées/commandables (pas de firehose de tout HA). Recalculé à chaque chargement. */
  private trackedEntityIds: Set<string> = new Set();
  /** Un seul déploiement écran à la fois — même conteneur Docker esphome côté ESPDISPLAY, pas de
   *  file d'attente pour l'instant (voir specs/current/fonctionnelles-espdisplay_specs_v1.0.md). */
  private deployInProgress = false;
  /** Verrou séparé du précédent : cible (HA) et mécanisme (SSH direct depuis core, pas de
   *  relais vers une autre application) totalement indépendants — pas de raison de bloquer
   *  l'un pendant que l'autre tourne. */
  private lovelaceDeployInProgress = false;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<HaplanConfig>,
    private readonly haBridgeClient: HaBridgeClient
  ) {
    this.config = this.loadConfig();
    this.configFileManager = new ConfigFileManager(this.resolveFloorplansConfigPath(), this.logger);
  }

  private resolveFloorplansConfigPath(): string {
    return path.join(this.resolveDataDir(), this.config.floorplansConfigFile);
  }

  private resolveDataDir(): string {
    return path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'haplan');
  }

  private resolveImagesDir(): string {
    return path.join(this.resolveDataDir(), 'images');
  }

  private loadConfig(): HaplanConfig {
    return haplanConfigSchema.parse(this.configProvider.getAppConfig());
  }

  // ==========================================================================
  // Cycle de vie
  // ==========================================================================

  async start(): Promise<void> {
    this.logger.info('HaplanService', 'Démarrage du service HAPLAN...');

    await this.haBridgeClient.start();
    this.floorplansConfig = this.configFileManager.load();
    this.recomputeTrackedEntityIds();

    this.setupSocketEventListeners();
    this.registerSocketEvents();

    // Signal interne (PresentationServer.ts, route POST /api/haplan/floorplans/upload) — jamais
    // exposé à un client Socket.io, volontairement absent de HAPLAN_ALL_EVENTS.
    this.eventBus.onGeneric<{ floorplanId: string; imageBuffer: Buffer; imageMimeType: string }>(
      'haplan:internal:floorplan:create',
      (data) => this.handleFloorplanCreate(data)
    );

    // Résultat de déploiement écran, republié par ESPDISPLAY (voir handleFloorplanDeploy
    // ci-dessus) — écouteur unique pour toute la durée de vie du service, pas par requête.
    this.eventBus.onGeneric<{ floorplanId?: string; ok: boolean; message: string; durationMs: number }>(
      'espdisplay:deploy-result',
      (result) => {
        this.deployInProgress = false;
        if (result.ok) {
          this.logger.info('HaplanService', `Déploiement réussi (${result.floorplanId}, ${result.durationMs}ms)`);
        } else {
          this.logger.error('HaplanService', `Échec du déploiement (${result.floorplanId}, ${result.durationMs}ms): ${result.message}`);
        }
        this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.FLOORPLAN_DEPLOY_RESULT, result);
      }
    );

    // Résultat de dépôt de la carte Plan Lovelace, émis par HaplanLovelaceDeployService côté core
    // (voir handleLovelaceDeploy ci-dessous) — écouteur unique pour toute la durée de vie du
    // service, pas par requête.
    this.eventBus.onGeneric<{ success: boolean; error?: string }>(
      'core:haplan-lovelace:deploy:result',
      (result) => {
        this.lovelaceDeployInProgress = false;
        if (result.success) {
          this.logger.info('HaplanService', 'Dépôt de la carte Plan Lovelace réussi');
        } else {
          this.logger.error('HaplanService', `Échec du dépôt de la carte Plan Lovelace: ${result.error}`);
        }
        this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.LOVELACE_DEPLOY_RESULT, result);
      }
    );

    if (this.haBridgeClient.isAvailable()) {
      this.haBridgeClient.onStateChanged((entity) => this.handleHaStateChanged(entity));
    } else {
      this.logger.warn('HaplanService',
        'Référentiel HA indisponible (ha.ws_enable=false ?) — aucun état/commande en direct possible.');
    }

    this.emitStatus();
    this.emitTaxonomyTree();
    this.logger.info('HaplanService', 'Service HAPLAN démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('HaplanService', 'Arrêt du service HAPLAN...');
  }

  // ==========================================================================
  // Statut
  // ==========================================================================

  getStatus(): HaplanStatus {
    return {
      haWsConnected: this.haBridgeClient.isAvailable(),
      floorplansCount: Object.keys(this.floorplansConfig.floorplans).length,
      entitiesCount: this.trackedEntityIds.size
    };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.STATUS, this.getStatus());
  }

  private recomputeTrackedEntityIds(): void {
    this.trackedEntityIds = new Set();
    for (const floorplan of Object.values(this.floorplansConfig.floorplans)) {
      for (const position of floorplan.positions) {
        this.trackedEntityIds.add(position.entity_id);
      }
    }
  }

  // ==========================================================================
  // États HA en direct
  // ==========================================================================

  private handleHaStateChanged(entity: HaRawEntity): void {
    if (!this.trackedEntityIds.has(entity.entity_id)) return;
    this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.ENTITY_STATE, {
      entity_id: entity.entity_id,
      state: entity.state,
      attributes: entity.attributes
    });
  }

  /** Instantané initial des états, filtré aux seules entités présentes sur un plan — depuis le
   *  cache local de HaBridgeClient (peuplé au démarrage, pas de requête réseau redondante). */
  private emitEntitiesStateBulk(): void {
    if (!this.haBridgeClient.isAvailable()) {
      this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.ENTITIES_STATE_BULK, { states: [] });
      return;
    }
    const states = this.haBridgeClient.getAllEntities()
      .filter((entity) => this.trackedEntityIds.has(entity.entity_id))
      .map((entity) => ({ entity_id: entity.entity_id, state: entity.state, attributes: entity.attributes }));
    this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.ENTITIES_STATE_BULK, { states });
  }

  // ==========================================================================
  // Commandes → HA
  // ==========================================================================

  private async handleEntityCommand(payload: EntityCommandPayload): Promise<void> {
    if (!this.haBridgeClient.isAvailable()) {
      this.logger.warn('HaplanService', `Commande reçue pour ${payload.entity_id} mais référentiel HA indisponible`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_HA_UNAVAILABLE', 'Connexion Home Assistant indisponible', 'haplan:command', { entityId: payload.entity_id }));
      return;
    }

    // Défense en profondeur : n'accepte que les entités effectivement présentes sur un plan,
    // jamais une commande arbitraire vers une entité HA quelconque envoyée par un client malveillant.
    if (!this.trackedEntityIds.has(payload.entity_id)) {
      this.logger.warn('HaplanService', `Commande reçue pour une entité non présente sur un plan: ${payload.entity_id}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_UNKNOWN_ENTITY', `Entité non présente sur un plan: ${payload.entity_id}`, 'haplan:command', { entityId: payload.entity_id }));
      return;
    }

    try {
      await this.haBridgeClient.sendCommand(payload.domain, payload.service, { entity_id: payload.entity_id }, payload.serviceData);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('HaplanService', `Échec de la commande ${payload.domain}.${payload.service} sur ${payload.entity_id}: ${message}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_COMMAND_FAILED', message, 'haplan:command', { entityId: payload.entity_id }));
    }
  }

  // ==========================================================================
  // Socket.io (via SocketBridge, EventBus générique)
  // ==========================================================================

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric(HAPLAN_CLIENT_EVENTS.GET_STATUS, () => this.emitStatus());

    this.eventBus.onGeneric(HAPLAN_CLIENT_EVENTS.GET_FLOORPLANS, () => {
      this.emitFloorplansList();
      this.emitEntitiesStateBulk();
    });

    this.eventBus.onGeneric<EntityCommandPayload>(HAPLAN_CLIENT_EVENTS.ENTITY_COMMAND, (data) => this.handleEntityCommand(data));

    this.eventBus.onGeneric(HAPLAN_CLIENT_EVENTS.GET_TAXONOMY_TREE, () => this.emitTaxonomyTree());

    this.eventBus.onGeneric<{ floorplanId: string; positions: HaplanPositionEntry[] }>(
      HAPLAN_CLIENT_EVENTS.FLOORPLAN_POSITIONS_UPDATE,
      (data) => this.handleFloorplanPositionsUpdate(data)
    );

    this.eventBus.onGeneric<{ floorplanId: string }>(
      HAPLAN_CLIENT_EVENTS.FLOORPLAN_DELETE,
      (data) => this.handleFloorplanDelete(data)
    );

    this.eventBus.onGeneric<{ floorplanId: string }>(
      HAPLAN_CLIENT_EVENTS.FLOORPLAN_DEPLOY,
      (data) => this.handleFloorplanDeploy(data)
    );

    this.eventBus.onGeneric(HAPLAN_CLIENT_EVENTS.LOVELACE_DEPLOY, () => this.handleLovelaceDeploy());
  }

  private emitFloorplansList(): void {
    this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.FLOORPLANS_LIST, { floorplans: this.floorplansConfig.floorplans });
  }

  /** Sélecteur d'entité (voir plan de portage Phase 2, taxonomy-tree.ts) — construit depuis
   *  attributs_taxonomie de chaque entité, pas depuis les areas HA (plates, sans hiérarchie). */
  private emitTaxonomyTree(): void {
    const entities = this.haBridgeClient.getAllEntities();
    this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.TAXONOMY_TREE, { areas: buildEntityPickerTree(entities) });
  }

  /**
   * Ajout/déplacement/suppression d'icône — un seul point d'entrée pour les trois cas (voir
   * PositionManager.ts côté client, qui envoie toujours la liste COMPLÈTE des positions du plan,
   * jamais un delta). Remplace entièrement les positions du plan concerné.
   */
  private handleFloorplanPositionsUpdate(data: { floorplanId: string; positions: HaplanPositionEntry[] }): void {
    const floorplan = this.floorplansConfig.floorplans[data.floorplanId];
    if (!floorplan) {
      this.logger.warn('HaplanService', `Positions reçues pour un plan inconnu: ${data.floorplanId}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_UNKNOWN_ENTITY', `Plan inconnu: ${data.floorplanId}`, 'haplan:floorplan'));
      return;
    }

    const previousPositions = floorplan.positions;
    floorplan.positions = data.positions;

    const result = this.configFileManager.save(this.floorplansConfig);
    if (!result.success) {
      floorplan.positions = previousPositions;
      this.logger.error('HaplanService', `Échec de sauvegarde des positions pour ${data.floorplanId}: ${result.error}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_SAVE_FAILED', `Échec de sauvegarde: ${result.error}`, 'haplan:floorplan'));
      this.emitFloorplansList();
      return;
    }

    // Une entité tout juste ajoutée doit devenir suivie (état/commandes) — voir handleEntityCommand.
    this.recomputeTrackedEntityIds();
    this.emitFloorplansList();
    this.emitEntitiesStateBulk();
  }

  /**
   * Création d'un nouveau plan — déclenchée par la route REST d'upload (voir PresentationServer.ts
   * et le commentaire sur handleFloorplanPositionsUpdate pour le choix Socket.io vs REST). Écrit
   * l'image sur disque puis ajoute l'entrée ; si la sauvegarde YAML échoue, supprime le fichier
   * déjà écrit pour ne pas laisser une image orpheline.
   */
  private handleFloorplanCreate(data: { floorplanId: string; imageBuffer: Buffer; imageMimeType: string }): void {
    if (this.floorplansConfig.floorplans[data.floorplanId]) {
      this.logger.warn('HaplanService', `Création refusée, plan déjà existant: ${data.floorplanId}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_SAVE_FAILED', `Un plan "${data.floorplanId}" existe déjà`, 'haplan:floorplan'));
      return;
    }

    const extension = EXTENSION_BY_MIME[data.imageMimeType];
    if (!extension) {
      this.logger.warn('HaplanService', `Type d'image non supporté: ${data.imageMimeType}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_SAVE_FAILED', `Type d'image non supporté: ${data.imageMimeType}`, 'haplan:floorplan'));
      return;
    }

    const filename = `${sanitizeFloorplanFilename(data.floorplanId)}${extension}`;
    const imagePath = path.join(this.resolveImagesDir(), filename);

    try {
      fs.mkdirSync(this.resolveImagesDir(), { recursive: true });
      fs.writeFileSync(imagePath, data.imageBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('HaplanService', `Échec d'écriture de l'image pour ${data.floorplanId}: ${message}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_SAVE_FAILED', `Échec d'écriture de l'image: ${message}`, 'haplan:floorplan'));
      return;
    }

    this.floorplansConfig.floorplans[data.floorplanId] = { filename, positions: [] };

    const result = this.configFileManager.save(this.floorplansConfig);
    if (!result.success) {
      delete this.floorplansConfig.floorplans[data.floorplanId];
      try { fs.unlinkSync(imagePath); } catch { /* best-effort */ }
      this.logger.error('HaplanService', `Échec de sauvegarde du nouveau plan ${data.floorplanId}: ${result.error}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_SAVE_FAILED', `Échec de sauvegarde: ${result.error}`, 'haplan:floorplan'));
      return;
    }

    this.logger.info('HaplanService', `Plan créé: ${data.floorplanId} (${filename})`);
    this.emitFloorplansList();
  }

  /** Suppression d'un plan — retire l'entrée puis supprime l'image (best-effort, ne bloque pas
   *  si le fichier est déjà absent ou verrouillé). */
  private handleFloorplanDelete(data: { floorplanId: string }): void {
    const floorplan = this.floorplansConfig.floorplans[data.floorplanId];
    if (!floorplan) {
      this.logger.warn('HaplanService', `Suppression demandée pour un plan inconnu: ${data.floorplanId}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_UNKNOWN_ENTITY', `Plan inconnu: ${data.floorplanId}`, 'haplan:floorplan'));
      return;
    }

    delete this.floorplansConfig.floorplans[data.floorplanId];

    const result = this.configFileManager.save(this.floorplansConfig);
    if (!result.success) {
      this.floorplansConfig.floorplans[data.floorplanId] = floorplan;
      this.logger.error('HaplanService', `Échec de suppression du plan ${data.floorplanId}: ${result.error}`);
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_SAVE_FAILED', `Échec de suppression: ${result.error}`, 'haplan:floorplan'));
      return;
    }

    try {
      fs.unlinkSync(path.join(this.resolveImagesDir(), floorplan.filename));
    } catch (error) {
      this.logger.warn('HaplanService', `Image non supprimée pour ${data.floorplanId}: ${error instanceof Error ? error.message : error}`);
    }

    this.recomputeTrackedEntityIds();
    this.logger.info('HaplanService', `Plan supprimé: ${data.floorplanId}`);
    this.emitFloorplansList();
  }

  /**
   * Déploiement du plan affiché sur l'écran ESP physique — délègue entièrement à ESPDISPLAY via
   * l'EventBus partagé (même pattern que ArexxService/Evoo7Service -> IntegrationBridge :
   * `emitGeneric`/`onGeneric` sur un nom d'événement convenu, aucune dépendance de compilation
   * vers applications/espdisplay). Le résultat arrive de façon asynchrone (15-65s selon le cache
   * de compilation ESPHome) via le listener enregistré une seule fois dans start().
   */
  private handleFloorplanDeploy(data: { floorplanId: string }): void {
    if (this.deployInProgress) {
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_DEPLOY_BUSY', 'Un déploiement est déjà en cours, réessaie dans un instant', 'haplan:floorplan:deploy', { floorplanId: data.floorplanId }));
      return;
    }
    if (!this.floorplansConfig.floorplans[data.floorplanId]) {
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_UNKNOWN_ENTITY', `Plan inconnu: ${data.floorplanId}`, 'haplan:floorplan:deploy'));
      return;
    }

    this.deployInProgress = true;
    this.logger.info('HaplanService', `Déploiement demandé pour le plan ${data.floorplanId}`);
    this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.FLOORPLAN_DEPLOY_STARTED, { floorplanId: data.floorplanId });
    this.eventBus.emitGeneric('espdisplay:deploy-floorplan', { floorplanId: data.floorplanId });
  }

/**
   * Dépôt de la carte Plan Lovelace sur HA — TOUS les plans connus, une vue HA par plan (voir
   * lovelace-generator.ts) dans un seul tableau de bord, navigables par les onglets natifs de HA
   * (balayage déjà géré nativement sur mobile). Contrairement à handleFloorplanDeploy ci-dessus,
   * pas de relais vers une autre application : la génération du YAML (§17 de la spec) reste ici
   * (connaissance HAPLAN — icônes, positions), seul le dépôt SSH lui-même est délégué à core
   * (HaplanLovelaceDeployService, seul à connaître haStackTargets et les primitives SSH).
   */
  private handleLovelaceDeploy(): void {
    if (this.lovelaceDeployInProgress) {
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_LOVELACE_DEPLOY_BUSY', 'Un dépôt est déjà en cours, réessaie dans un instant', 'haplan:lovelace:deploy'));
      return;
    }
    const floorplanIds = Object.keys(this.floorplansConfig.floorplans);
    if (floorplanIds.length === 0) {
      this.eventBus.emitGeneric('haplan:error',
        createHaplanError('HAPLAN_UNKNOWN_ENTITY', 'Aucun plan à déployer', 'haplan:lovelace:deploy'));
      return;
    }

    this.lovelaceDeployInProgress = true;
    this.logger.info('HaplanService', `Dépôt de la carte Plan Lovelace demandé pour ${floorplanIds.length} plan(s)`);
    this.eventBus.emitGeneric(HAPLAN_SOCKET_EVENTS.LOVELACE_DEPLOY_STARTED, {});

    const cacheBust = Date.now();
    // Dimensions réelles de chaque image — nécessaires pour graver le bon ratio (aspect-ratio) dans
    // le CSS de chaque vue (voir lovelace-generator.ts) : sans ça, les icônes superposées se
    // décalent du plan dès que son ratio diffère de celui de l'écran (retour réel, 28/08/2026). Un
    // plan dont l'image est illisible est juste omis de `dimensions` plutôt que de bloquer tout le
    // dépôt — buildLovelaceDashboardYaml gère l'absence d'entrée.
    const dimensions: Record<string, ImageDimensions> = {};
    for (const [floorplanId, floorplan] of Object.entries(this.floorplansConfig.floorplans)) {
      try {
        dimensions[floorplanId] = readImageDimensions(path.join(this.resolveImagesDir(), floorplan.filename));
      } catch (error) {
        this.logger.warn('HaplanService', `Dimensions illisibles pour le plan "${floorplanId}" (${floorplan.filename}) : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const yamlContent = buildLovelaceDashboardYaml(this.floorplansConfig.floorplans, dimensions, cacheBust);
    // Fusionné sur le fond sombre HAPLAN avant envoi (voir image-flatten.ts) — l'original reste
    // inchangé (toujours utilisé par HAPLAN lui-même, sur son propre fond déjà sombre). Seul le
    // PNG peut avoir un fond transparent problématique ici (JPEG n'a pas de canal alpha — pas de
    // fond blanc-sur-blanc possible) ; WEBP transparent non couvert (pngjs ne le décode pas),
    // limitation connue plutôt qu'un décodeur supplémentaire pour un cas non rencontré à ce jour.
    // Sous-dossier dédié (pas de préfixe sur le nom de fichier lui-même) : le dépôt SSH copie
    // toutes les images en une seule fois vers un répertoire distant (scp source multiple ->
    // répertoire, voir HaplanLovelaceDeployService.ts), qui préserve le nom de fichier LOCAL tel
    // quel — il doit donc déjà être le nom final attendu par le YAML (/local/<filename>).
    const flattenedDir = path.join(this.resolveImagesDir(), '.lovelace-tmp');
    fs.mkdirSync(flattenedDir, { recursive: true });
    const images = Object.values(this.floorplansConfig.floorplans).map((floorplan) => {
      const sourceImagePath = path.join(this.resolveImagesDir(), floorplan.filename);
      let localPath = sourceImagePath;
      if (floorplan.filename.toLowerCase().endsWith('.png')) {
        const flattenedImagePath = path.join(flattenedDir, floorplan.filename);
        flattenPngOntoDarkBackground(sourceImagePath, flattenedImagePath);
        localPath = flattenedImagePath;
      }
      return { localPath, filename: floorplan.filename };
    });

    this.eventBus.emitGeneric('core:haplan-lovelace:deploy', { yaml: yamlContent, images });
  }

  private registerSocketEvents(): void {
    // HAPLAN_ALL_EVENTS (pas seulement les événements serveur→client) : SocketBridge ne relaie
    // les événements client→serveur que pour ceux listés ici — voir le bug déjà rencontré côté
    // RFXCOM cette session (événement non enregistré = silencieusement ignoré).
    this.eventBus.emitGeneric('app:socket-events:registered', {
      appId: MODULE_NAME,
      socketEvents: HAPLAN_ALL_EVENTS,
      persistentEvents: HAPLAN_PERSISTENT_EVENTS
    });
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<HaplanConfig>,
    haBridgeClient: HaBridgeClient
  ): HaplanService {
    return new HaplanService(eventBus, logger, configProvider, haBridgeClient);
  }
}
