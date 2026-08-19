/**
 * ScriptsHaService — orchestrateur de l'application scriptsha.
 *
 * Gère des scripts Home Assistant (entité native `script.*`) déposés sous forme de fichier YAML :
 * stockage local (métadonnées + fichier de contenu), diffusion/retrait à la demande vers HA.
 *
 * Ce service tourne en process séparé (voir standalone.ts) — il n'a donc jamais d'accès direct à
 * HaWsClient (qui n'existe que dans le process `core`). Toute action HA passe par le pont générique
 * `HaRestBridge` (applications/core/src/ha/HaRestBridge.ts) : ce service émet `ha:rest:request`
 * (reçu automatiquement côté core, aucune déclaration nécessaire pour ce sens) et écoute
 * `scriptsha:ha:rest:result` (relayé explicitement vers cet enfant via `SCRIPTSHA_APP.bridgedEvents`,
 * voir domain/index.ts) pour connaître le résultat réel.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { scriptsConfigSchema, DEFAULT_SCRIPTS_CONFIG, type ScriptEntry, type ScriptsConfigFile, type ProvisioningConfig } from './storage-schema';
import { ConfigFileManager } from './yaml/ConfigFileManager';
import { SCRIPTSHA_SOCKET_EVENTS, SCRIPTSHA_CLIENT_EVENTS } from './socket-events';
import type { ScriptshaConfig } from './config-schema';

export interface IScriptsHaService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface UploadEventPayload {
  buffer: unknown;
  filename: string;
  mimetype: string;
  fields: Record<string, unknown>;
}

interface HaRestResultPayload {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface HaHelperResultPayload {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface HaEntityTaxonomyPayload {
  lieuPrecis?: string | null;
  lieuPrincipal?: string | null;
  lieuPere?: string | null;
  lieuGrandPere?: string | null;
}

interface HaEntitySummary {
  entity_id: string;
  name?: string;
  area_id?: string;
  quoiIds?: string[];
  taxonomy?: HaEntityTaxonomyPayload;
}

interface HaEntitiesListResultPayload {
  domain: string;
  entities: HaEntitySummary[];
}

interface HaEntityUpdatedPayload {
  entity_id: string;
  domain: string;
  action: 'create' | 'update' | 'delete';
}

const EXAMPLE_SCRIPT_ID = 'minuterie_automatique_des_lumieres';
const EXAMPLE_SCRIPT_TITLE = 'Minuterie automatique des lumières';
const EXAMPLE_SCRIPT_DESCRIPTION =
  "Démarre la minuterie d'une lumière dès qu'elle s'allume, l'annule dès qu'elle change d'état " +
  "autrement. Éteint automatiquement la lumière à l'expiration de sa minuterie. Délai par défaut " +
  '24h, réglable timer par timer (Paramètres > Appareils et services > Aides).';
// Automatisation (pas un script.* — voir échange avec l'utilisateur, 18/08/2026 : un script n'a
// aucun déclencheur propre, HA ne peut pas réagir seul à un changement d'état depuis un script).
// Nom du timer dérivé directement du suffixe d'entity_id de la lumière (ScriptsHaService::
// buildHelperName) — calcul Jinja symétrique ici, sans accès à la taxonomie interne de dimotic-ha.
//
// ⭐ 19/08/2026, correctif suite à incident réel (ha2, 18/08/2026, ~1h20 hors service) : le
// déclencheur était `event_type: state_changed` SANS filtre d'entité au niveau du déclencheur
// lui-même (le filtre `entity_id.split('.')[0] == 'light'` n'était qu'une condition évaluée APRÈS
// déclenchement) — l'automatisation se redéclenchait sur SON PROPRE changement d'état (chaque
// exécution modifie `current`/`last_triggered`, lui-même un `state_changed`), boucle infinie
// auto-entretenue. Remplacé par `platform: state` avec une liste explicite d'`entity_id` (les
// lumières réellement surveillées) — exclut par construction l'automatisation elle-même et toute
// entité non concernée, un filtre en condition après coup ne suffit pas. La liste est maintenue à
// jour par `syncExampleAutomationTrigger()`, appelée depuis la même réconciliation qui crée les
// timers manquants (voir reconcileEntityHelpers) — jamais codée en dur, jamais désynchronisée des
// timers eux-mêmes.
function buildTriggerEntityIdBlock(lightEntityIds: string[]): string {
  if (lightEntityIds.length === 0) return '    entity_id: []';
  return `    entity_id:\n${lightEntityIds.map((id) => `      - ${id}`).join('\n')}`;
}

function buildExampleAutomationYaml(lightEntityIds: string[]): string {
  return `alias: Minuterie automatique des lumières
description: >-
  Démarre la minuterie d'une lumière dès qu'elle s'allume, l'annule dès qu'elle change d'état
  autrement. Éteint automatiquement la lumière à l'expiration de sa minuterie. Délai par défaut
  24h, réglable timer par timer (Paramètres > Appareils et services > Aides).
mode: queued
max: 100
trigger:
  - platform: state
    id: light_changed
${buildTriggerEntityIdBlock(lightEntityIds)}
  - platform: event
    event_type: timer.finished
    id: timer_expired
condition: []
action:
  - choose:
      - conditions:
          - condition: trigger
            id: light_changed
          - condition: template
            value_template: >-
              {{ trigger.from_state is not none and trigger.to_state is not none
                 and trigger.from_state.state != trigger.to_state.state }}
        sequence:
          - variables:
              timer_id: "timer.minuterie_{{ trigger.entity_id.split('.')[1] }}"
          - condition: template
            value_template: "{{ states(timer_id) not in ['unknown', 'unavailable'] }}"
          - choose:
              - conditions:
                  - "{{ trigger.to_state.state == 'on' }}"
                sequence:
                  - service: timer.start
                    target:
                      entity_id: "{{ timer_id }}"
              - conditions:
                  - "{{ trigger.to_state.state != 'on' }}"
                sequence:
                  - service: timer.cancel
                    target:
                      entity_id: "{{ timer_id }}"
      - conditions:
          - condition: trigger
            id: timer_expired
          - condition: template
            value_template: "{{ trigger.event.data.entity_id.startswith('timer.minuterie_') }}"
        sequence:
          - variables:
              light_id: "light.{{ trigger.event.data.entity_id.split('.')[1].replace('minuterie_', '', 1) }}"
          - condition: template
            value_template: "{{ states(light_id) not in ['unknown', 'unavailable'] }}"
          - service: light.turn_off
            target:
              entity_id: "{{ light_id }}"
`;
}

export class ScriptsHaService implements IScriptsHaService {
  private readonly scriptsManager: ConfigFileManager<ScriptsConfigFile>;
  private readonly scriptsDir: string;
  private scripts: ScriptEntry[];
  /** Action en vol par id de script — permet à handleHaRestResult() de savoir si le résultat reçu
   *  correspond à un déploiement ou un retrait (HaRestBridge ne renvoie que {id, success, ...}). */
  private readonly pendingAction = new Map<string, 'deploy' | 'undeploy'>();
  /** Résolveurs des requêtes ha:helper:request en vol, corrélés par requestId (plusieurs peuvent
   *  être simultanées — une par lumière manquante lors d'une réconciliation). */
  private readonly pendingHelperRequests = new Map<string, (result: HaHelperResultPayload) => void>();
  /** Mutex simple — évite deux réconciliations concurrentes (déploiement + détection réactive
   *  d'une nouvelle entité survenant en même temps). */
  private reconcilingProvisioning = false;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<ScriptshaConfig>
  ) {
    // Chargée mais non utilisée activement au-delà de enabled — voir config-schema.ts.
    this.configProvider.getAppConfig();

    const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'scriptsha');
    this.scriptsDir = path.join(dataDir, 'scripts');
    this.scriptsManager = new ConfigFileManager<ScriptsConfigFile>(
      path.join(dataDir, 'scriptsha-scripts-v1.0.yaml'),
      scriptsConfigSchema,
      DEFAULT_SCRIPTS_CONFIG,
      this.logger,
      'scripts'
    );
    this.scripts = this.scriptsManager.load().scripts;

    this.setupEventListeners();
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<ScriptshaConfig>): ScriptsHaService {
    return new ScriptsHaService(eventBus, logger, configProvider);
  }

  async start(): Promise<void> {
    this.logger.info('ScriptsHaService', 'Démarrage du service scriptsha...');
    this.seedExampleIfEmpty();
    this.emitScripts();
    this.logger.info('ScriptsHaService', 'Service scriptsha démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('ScriptsHaService', 'Arrêt du service scriptsha');
  }

  private setupEventListeners(): void {
    this.eventBus.on(SCRIPTSHA_CLIENT_EVENTS.SCRIPTS_GET, () => this.emitScripts());
    this.eventBus.on(SCRIPTSHA_CLIENT_EVENTS.SCRIPT_DEPLOY, (data: unknown) => this.handleDeploy((data as { id: string }).id));
    this.eventBus.on(SCRIPTSHA_CLIENT_EVENTS.SCRIPT_UNDEPLOY, (data: unknown) => this.handleUndeploy((data as { id: string }).id));
    this.eventBus.on(SCRIPTSHA_CLIENT_EVENTS.SCRIPT_DELETE, (data: unknown) => this.handleDeleteRecord((data as { id: string }).id));
    this.eventBus.on(SCRIPTSHA_CLIENT_EVENTS.SCRIPT_GET_CONTENT, (data: unknown) => this.handleGetContent((data as { id: string }).id));

    // Événements internes core↔enfant (pas des événements Socket.io) — voir SCRIPTSHA_APP.bridgedEvents.
    this.eventBus.onGeneric<UploadEventPayload>('scriptsha:internal:upload', (data) => this.handleUpload(data));
    this.eventBus.onGeneric<HaRestResultPayload>('scriptsha:ha:rest:result', (data) => this.handleHaRestResult(data));
    this.eventBus.onGeneric<HaHelperResultPayload>('scriptsha:ha:helper:result', (data) => this.handleHaHelperResult(data));
    this.eventBus.onGeneric<HaEntitiesListResultPayload>('scriptsha:ha:entities:list:result', (data) => this.handleEntitiesListResult(data));
    this.eventBus.onGeneric<HaEntityUpdatedPayload>('ha:entity:updated', (data) => this.handleEntityUpdated(data));
  }

  // ==========================================================================
  // Amorçage de l'exemple
  // ==========================================================================

  private seedExampleIfEmpty(): void {
    if (this.scripts.length > 0) return;

    const now = new Date().toISOString();
    fs.mkdirSync(this.scriptsDir, { recursive: true });
    // Liste de lumières vide au départ (déclencheur inerte tant qu'aucune n'est détectée) — voir
    // syncExampleAutomationTrigger(), qui la maintient à jour dès la première diffusion.
    fs.writeFileSync(path.join(this.scriptsDir, `${EXAMPLE_SCRIPT_ID}.yaml`), buildExampleAutomationYaml([]), 'utf8');

    this.scripts.push({
      id: EXAMPLE_SCRIPT_ID,
      title: EXAMPLE_SCRIPT_TITLE,
      description: EXAMPLE_SCRIPT_DESCRIPTION,
      originalFilename: `${EXAMPLE_SCRIPT_ID}.yaml`,
      haDomain: 'automation',
      deployed: false,
      createdAt: now,
      provisioning: {
        watchDomain: 'light',
        helperDomain: 'timer',
        namePrefix: 'Minuterie',
        // 24h par défaut (demande utilisateur) — réglable ensuite timer par timer directement
        // dans HA (Paramètres > Appareils et services > Aides), jamais recalculé par ce service.
        helperData: { duration: '24:00:00' }
      }
    });
    this.scriptsManager.save({ scripts: this.scripts });
    this.logger.info('ScriptsHaService', `Script d'exemple "${EXAMPLE_SCRIPT_TITLE}" créé`);
  }

  // ==========================================================================
  // Upload
  // ==========================================================================

  /** Le canal IPC (process.send/process.on('message')) sérialise en JSON par défaut — un Buffer y
   *  perd son prototype et arrive sous la forme {type:'Buffer', data:[...]}. */
  private toBuffer(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>)) {
      return Buffer.from((value as { data: number[] }).data);
    }
    return Buffer.from(value as ArrayLike<number>);
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // retire les accents
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private generateId(title: string): string {
    const base = this.slugify(title) || 'script';
    const existing = new Set(this.scripts.map((s) => s.id));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }

  private handleUpload(data: UploadEventPayload): void {
    try {
      const title = typeof data.fields?.title === 'string' ? data.fields.title.trim() : '';
      const description = typeof data.fields?.description === 'string' ? data.fields.description.trim() : '';
      if (!title) {
        this.emitError('Titre requis');
        return;
      }

      const buffer = this.toBuffer(data.buffer);
      const text = buffer.toString('utf8');
      let parsed: unknown;
      try {
        parsed = yaml.load(text);
      } catch (error) {
        this.emitError(`Fichier YAML invalide: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        this.emitError('Le fichier doit contenir un script HA valide (objet YAML)');
        return;
      }

      const id = this.generateId(title);
      const now = new Date().toISOString();
      fs.mkdirSync(this.scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(this.scriptsDir, `${id}.yaml`), text, 'utf8');

      this.scripts.push({
        id,
        title,
        description,
        originalFilename: data.filename,
        haDomain: 'script',
        deployed: false,
        createdAt: now
      });
      const result = this.scriptsManager.save({ scripts: this.scripts });
      if (!result.success) {
        this.emitError(`Échec de sauvegarde: ${result.error}`);
        return;
      }

      this.logger.info('ScriptsHaService', `Script déposé: ${id} ("${title}")`);
      this.emitScripts();
    } catch (error) {
      this.emitError(`Erreur lors du dépôt du fichier: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ==========================================================================
  // Diffuser / retirer (pont HaRestBridge)
  // ==========================================================================

  private handleDeploy(id: string): void {
    const entry = this.scripts.find((s) => s.id === id);
    if (!entry) {
      this.emitError(`Script introuvable: ${id}`, id);
      return;
    }

    let config: unknown;
    try {
      const text = fs.readFileSync(path.join(this.scriptsDir, `${id}.yaml`), 'utf8');
      config = yaml.load(text);
    } catch (error) {
      this.emitError(`Impossible de lire le fichier du script: ${error instanceof Error ? error.message : String(error)}`, id);
      return;
    }

    this.pendingAction.set(id, 'deploy');
    this.emitScripts();
    this.eventBus.emitGeneric('ha:rest:request', {
      appId: 'scriptsha',
      method: 'set',
      domain: entry.haDomain,
      id,
      config
    });
  }

  private handleUndeploy(id: string): void {
    const entry = this.scripts.find((s) => s.id === id);
    if (!entry) {
      this.emitError(`Script introuvable: ${id}`, id);
      return;
    }

    this.pendingAction.set(id, 'undeploy');
    this.emitScripts();
    this.eventBus.emitGeneric('ha:rest:request', {
      appId: 'scriptsha',
      method: 'delete',
      domain: entry.haDomain,
      id
    });
  }

  private handleHaRestResult(data: HaRestResultPayload): void {
    const action = this.pendingAction.get(data.id);
    this.pendingAction.delete(data.id);
    if (!action) return; // résultat inattendu/périmé, ignoré

    const entry = this.scripts.find((s) => s.id === data.id);
    if (!entry) {
      this.emitScripts();
      return;
    }

    if (data.success) {
      entry.deployed = action === 'deploy';
      entry.deployedAt = action === 'deploy' ? new Date().toISOString() : undefined;
      entry.updatedAt = new Date().toISOString();
      this.scriptsManager.save({ scripts: this.scripts });
      this.logger.info('ScriptsHaService', `${action === 'deploy' ? 'Diffusé' : 'Retiré'}: ${data.id}`);

      // Provisionnement générique (voir §Provisionnement plus bas) : tout script diffusé portant
      // un `provisioning` déclenche la réconciliation, quel que soit son id.
      if (action === 'deploy' && entry.provisioning) {
        void this.reconcileEntityHelpers(entry.id, entry.provisioning);
      }
    } else {
      this.emitError(`Échec ${action === 'deploy' ? 'de la diffusion' : 'du retrait'}: ${data.error}`, data.id);
    }

    this.emitScripts();
  }

  // ==========================================================================
  // Supprimer l'enregistrement / voir le contenu
  // ==========================================================================

  private handleDeleteRecord(id: string): void {
    const entry = this.scripts.find((s) => s.id === id);
    if (!entry) {
      this.emitError(`Script introuvable: ${id}`, id);
      return;
    }
    if (entry.deployed) {
      this.emitError('Retirez le script de HA avant de le supprimer', id);
      return;
    }

    try {
      fs.unlinkSync(path.join(this.scriptsDir, `${id}.yaml`));
    } catch {
      // Non bloquant : fichier déjà absent.
    }
    this.scripts = this.scripts.filter((s) => s.id !== id);
    this.scriptsManager.save({ scripts: this.scripts });
    this.emitScripts();
  }

  private handleGetContent(id: string): void {
    const entry = this.scripts.find((s) => s.id === id);
    if (!entry) {
      this.emitError(`Script introuvable: ${id}`, id);
      return;
    }
    try {
      const content = fs.readFileSync(path.join(this.scriptsDir, `${id}.yaml`), 'utf8');
      this.eventBus.emit(SCRIPTSHA_SOCKET_EVENTS.SCRIPT_CONTENT, { id, content });
    } catch (error) {
      this.emitError(`Impossible de lire le contenu: ${error instanceof Error ? error.message : String(error)}`, id);
    }
  }

  // ==========================================================================
  // Provisionnement générique (voir storage-schema.ts::ProvisioningConfig, fonctionnelles-
  // scriptsha_specs §4bis) — le moteur ci-dessous ne connaît aucun script en particulier, seul le
  // champ `provisioning` d'une entrée active le mécanisme.
  // ==========================================================================

  /** Requête générique vers HaHelperBridge, corrélée par requestId (voir HaHelperBridge.ts). */
  private helperRequest(method: 'list' | 'create' | 'delete', domain: string, id?: string, data?: Record<string, unknown>): Promise<HaHelperResultPayload> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pendingHelperRequests.set(requestId, resolve);
      this.eventBus.emitGeneric('ha:helper:request', { appId: 'scriptsha', requestId, method, domain, id, data });
    });
  }

  private handleHaHelperResult(data: HaHelperResultPayload): void {
    const resolve = this.pendingHelperRequests.get(data.requestId);
    if (!resolve) return; // résultat inattendu/périmé, ignoré
    this.pendingHelperRequests.delete(data.requestId);
    resolve(data);
  }

  /** Requête ponctuelle des entités d'un domaine (photo initiale, voir HaHelperBridge.ts) — une
   *  seule réconciliation à la fois (mutex `reconcilingProvisioning`), pas besoin de corrélation. */
  private pendingEntitiesListResolve: ((result: HaEntitiesListResultPayload) => void) | null = null;

  private requestEntitiesList(domain: string): Promise<HaEntitiesListResultPayload> {
    return new Promise((resolve) => {
      this.pendingEntitiesListResolve = resolve;
      this.eventBus.emitGeneric('ha:entities:list:request', { appId: 'scriptsha', domain });
    });
  }

  private handleEntitiesListResult(data: HaEntitiesListResultPayload): void {
    if (!this.pendingEntitiesListResolve) return;
    const resolve = this.pendingEntitiesListResolve;
    this.pendingEntitiesListResolve = null;
    resolve(data);
  }

  /**
   * Condition d'appartenance au domaine surveillé — isolée à dessein dans sa propre méthode, car
   * c'est la partie la plus susceptible d'évoluer rapidement (aujourd'hui : simple égalité de
   * domaine ; demain, potentiellement : exclusion par quoi_ids, filtre sur l'area, etc. — voir
   * fonctionnelles-scriptsha_specs §4bis.5, 2 des 35 lumières réelles ne sont pas des lumières de
   * pièce). Un seul point à modifier si ce filtre doit un jour devenir plus riche.
   */
  private matchesWatchCondition(entity: { entity_id: string; quoiIds?: string[] }, entityDomain: string, provisioning: ProvisioningConfig): boolean {
    return entityDomain === provisioning.watchDomain;
  }

  /** Détection réactive d'une nouvelle entité — pour chaque script actuellement diffusé dont le
   *  `watchDomain` correspond, relance une réconciliation complète (volume négligeable, pas de
   *  logique ciblée séparée pour la seule entité détectée). */
  private handleEntityUpdated(data: HaEntityUpdatedPayload): void {
    if (data.action !== 'create') return;
    for (const entry of this.scripts) {
      if (!entry.deployed || !entry.provisioning) continue;
      if (!this.matchesWatchCondition({ entity_id: data.entity_id }, data.domain, entry.provisioning)) continue;
      this.logger.info('ScriptsHaService', `Nouvelle entité détectée (${data.entity_id}, domaine ${data.domain}) — réconciliation pour "${entry.title}"`);
      void this.reconcileEntityHelpers(entry.id, entry.provisioning);
    }
  }

  /**
   * Nom d'un helper pour une entité surveillée — dérivé directement et simplement du suffixe de
   * l'entity_id (`namePrefix` + suffixe), volontairement PAS de la taxonomie QUOI/OÙ pourtant déjà
   * disponible (`entity.taxonomy`, voir HaHelperBridge). Choix délibéré (demande utilisateur,
   * 18/08/2026) : une automatisation HA qui doit retrouver le helper d'une entité donnée ne parle
   * qu'en Jinja, sans accès à la taxonomie interne de dimotic-ha (jamais republiée dans les vrais
   * attributs HA) — seul un calcul simple et déterministe à partir de l'entity_id natif (que
   * l'automatisation connaît déjà) permet ce calcul des deux côtés indépendamment. La taxonomie
   * reste renvoyée par HaHelperBridge pour un futur besoin purement "affichage humain", sans
   * contrainte de recalcul côté HA. */
  private buildHelperName(entity: HaEntitySummary, provisioning: ProvisioningConfig): string {
    return `${provisioning.namePrefix} ${entity.entity_id.replace(/^[^.]+\./, '')}`;
  }

  /**
   * Maintient le déclencheur `platform: state` de l'automatisation minuterie synchronisé avec les
   * lumières réellement surveillées (voir le commentaire au-dessus de `buildExampleAutomationYaml`
   * pour le pourquoi — corrige l'incident du 18/08/2026). Idempotent par construction : compare la
   * liste calculée à celle déjà écrite sur disque, ne réécrit/ne redéploie QUE si elle a changé —
   * sans cette garde, le redéploiement lui-même déclencherait une nouvelle réconciliation
   * (handleHaRestResult), qui rappellerait cette méthode indéfiniment.
   */
  private syncExampleAutomationTrigger(lightEntityIds: string[]): void {
    const entry = this.scripts.find((s) => s.id === EXAMPLE_SCRIPT_ID);
    if (!entry || !entry.deployed) return;

    const filePath = path.join(this.scriptsDir, `${EXAMPLE_SCRIPT_ID}.yaml`);
    let currentEntityIds: string[] = [];
    try {
      const currentDoc = yaml.load(fs.readFileSync(filePath, 'utf8')) as {
        trigger?: Array<{ id?: string; entity_id?: string[] }>;
      };
      currentEntityIds = currentDoc?.trigger?.find((t) => t.id === 'light_changed')?.entity_id ?? [];
    } catch {
      // Fichier absent/illisible : on considère qu'il faut (re)générer.
    }

    const sortedNew = [...lightEntityIds].sort();
    const sortedCurrent = [...currentEntityIds].sort();
    if (JSON.stringify(sortedNew) === JSON.stringify(sortedCurrent)) return; // déjà à jour

    const yamlContent = buildExampleAutomationYaml(lightEntityIds);
    fs.writeFileSync(filePath, yamlContent, 'utf8');
    entry.updatedAt = new Date().toISOString();
    this.scriptsManager.save({ scripts: this.scripts });

    this.logger.info(
      'ScriptsHaService',
      `Minuterie : liste des lumières surveillées mise à jour (${lightEntityIds.length} lumière(s)), redéploiement`
    );
    this.pendingAction.set(EXAMPLE_SCRIPT_ID, 'deploy');
    this.emitScripts();
    this.eventBus.emitGeneric('ha:rest:request', {
      appId: 'scriptsha',
      method: 'set',
      domain: entry.haDomain,
      id: EXAMPLE_SCRIPT_ID,
      config: yaml.load(yamlContent)
    });
  }

  /**
   * "Détection de mise en œuvre" + installation demandées par l'utilisateur (18/08/2026) : pour
   * chaque entité du domaine surveillé sans helper correspondant, en crée un. Re-scanne l'état réel
   * de HA à chaque appel (pas d'état local séparé) — résilient à une perte du fichier local ou à un
   * ajout/suppression manuel côté HA. Déclenché après diffusion réussie d'un script portant un
   * `provisioning` (handleHaRestResult) et à chaque nouvelle entité détectée tant qu'il reste
   * diffusé (handleEntityUpdated).
   */
  private async reconcileEntityHelpers(scriptId: string, provisioning: ProvisioningConfig): Promise<void> {
    if (this.reconcilingProvisioning) {
      this.logger.debug('ScriptsHaService', 'Réconciliation déjà en cours, ignorée');
      return;
    }
    this.reconcilingProvisioning = true;

    try {
      const [entitiesResult, helpersResult] = await Promise.all([
        this.requestEntitiesList(provisioning.watchDomain),
        this.helperRequest('list', provisioning.helperDomain)
      ]);

      if (!helpersResult.success) {
        this.emitError(`Réconciliation : échec de la liste des helpers HA (${provisioning.helperDomain}): ${helpersResult.error}`);
        return;
      }

      const existingHelperIds = new Set(
        (helpersResult.result as Array<{ id: string }>).map((h) => h.id)
      );
      // Noms déjà attribués DURANT cette passe — anti-collision entre deux entités de cette même
      // réconciliation (voir buildHelperName : la taxonomie ne garantit pas une unicité absolue).
      const namesUsedThisPass = new Set<string>();

      const watched = entitiesResult.entities.filter((e) => this.matchesWatchCondition(e, entitiesResult.domain, provisioning));

      // Spécifique à la minuterie (pas généralisé, comme le reste de ses particularités — voir
      // buildExampleAutomationYaml) : garde le déclencheur `platform: state` de l'automatisation
      // synchronisé avec les lumières réellement surveillées, à chaque réconciliation.
      if (scriptId === EXAMPLE_SCRIPT_ID) {
        this.syncExampleAutomationTrigger(watched.map((e) => e.entity_id));
      }

      const toCreate: Array<{ entity: HaEntitySummary; name: string }> = [];
      for (const entity of watched) {
        const baseName = this.buildHelperName(entity, provisioning);
        let name = baseName;
        let expectedId = this.slugify(name);
        // Un nom déjà réclamé par UNE AUTRE entité DE CETTE MÊME PASSE prime sur la simple
        // présence côté HA — sinon une 2e entité colliderait silencieusement avec le helper de la
        // 1ère au lieu d'être désambiguïsée (voir le commentaire de buildHelperName : la taxonomie
        // ne garantit pas une unicité absolue).
        let n = 2;
        while (namesUsedThisPass.has(expectedId)) {
          name = `${baseName} ${n}`;
          expectedId = this.slugify(name);
          n++;
        }
        namesUsedThisPass.add(expectedId);
        if (!existingHelperIds.has(expectedId)) {
          toCreate.push({ entity, name });
        }
      }

      if (toCreate.length === 0) {
        this.logger.info('ScriptsHaService', 'Réconciliation : rien à installer');
        return;
      }

      this.logger.info('ScriptsHaService', `Réconciliation : ${toCreate.length} helper(s) manquant(s), création en cours`);
      const results = await Promise.all(
        toCreate.map(({ name }) =>
          this.helperRequest('create', provisioning.helperDomain, undefined, {
            name,
            ...(provisioning.helperData ?? {})
          })
        )
      );

      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        this.emitError(`Réconciliation : ${failures.length}/${toCreate.length} helper(s) en échec (${failures.map((f) => f.error).join('; ')})`);
      }
      this.logger.info('ScriptsHaService', `Réconciliation : ${toCreate.length - failures.length}/${toCreate.length} helper(s) créé(s)`);
    } finally {
      this.reconcilingProvisioning = false;
    }
  }

  // ==========================================================================
  // Émission des événements
  // ==========================================================================

  private emitScripts(): void {
    const enriched = this.scripts.map((s) => ({ ...s, pending: this.pendingAction.has(s.id) }));
    this.eventBus.emit(SCRIPTSHA_SOCKET_EVENTS.SCRIPTS_LIST, enriched);
  }

  private emitError(message: string, id?: string): void {
    this.logger.error('ScriptsHaService', message);
    this.eventBus.emit(SCRIPTSHA_SOCKET_EVENTS.ERROR, { message, id });
  }
}
