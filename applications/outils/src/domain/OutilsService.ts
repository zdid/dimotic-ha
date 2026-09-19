/**
 * OutilsService — orchestrateur de l'application Outils (bibliothèque de scripts shell
 * paramétrables). Chargement/rechargement de la config, ajout par upload générique, suppression,
 * lecture d'un script (contenu + variables détectées). La génération/téléchargement elle-même se
 * fait entièrement côté navigateur — rien à orchestrer côté serveur pour ça.
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { outilsConfigSchema, type OutilsConfig, type OutilScriptConfig } from './config-schema';
import type { OutilsStatus, OutilScriptDetail, AddScriptResult, BundleResult } from './types';
import { readScriptContent, writeScriptContent, deleteScriptContent, detectVariables, detectVariableHints, detectBundlePaths } from './ScriptTemplate';
import { buildBundle } from './BundleBuilder';
import { readSavedValues, saveValues } from './ScriptValues';

const MODULE_NAME = 'outils';

interface UploadEventPayload {
  buffer: unknown;
  filename: string;
  mimetype: string;
  fields: Record<string, unknown>;
}

export interface IOutilsService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): OutilsStatus;
}

export class OutilsService implements IOutilsService {
  private config: OutilsConfig;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<OutilsConfig>
  ) {
    this.config = this.loadConfig();
  }

  private loadConfig(): OutilsConfig {
    const raw = this.configProvider.getAppConfig() as Partial<OutilsConfig>;
    return outilsConfigSchema.parse(raw);
  }

  async start(): Promise<void> {
    this.logger.info('OutilsService', 'Démarrage du service Outils...');
    this.setupSocketEventListeners();
    this.emitStatus();
    this.logger.info('OutilsService', 'Service Outils démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('OutilsService', 'Arrêt du service Outils...');
  }

  getStatus(): OutilsStatus {
    return {
      scripts: this.config.scripts.map((s) => ({
        id: s.id, title: s.title, description: s.description, filename: s.filename, requiresSudo: s.requiresSudo
      }))
    };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('outils:status', this.getStatus());
  }

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric('outils:status:get', () => this.emitStatus());

    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== MODULE_NAME || !event.success) return;
      this.configProvider.reload();
      this.config = this.loadConfig();
      this.emitStatus();
    });

    this.eventBus.onGeneric<{ id: string }>('outils:script:get', (data) => this.handleGetScript(data.id));
    this.eventBus.onGeneric<{ id: string }>('outils:script:delete', (data) => this.handleDeleteScript(data.id));
    this.eventBus.onGeneric<UploadEventPayload>('outils:internal:upload', (data) => this.handleUpload(data));
    this.eventBus.onGeneric<{ id: string; content: string }>('outils:bundle:build', (data) => this.handleBuildBundle(data.id, data.content));
    this.eventBus.onGeneric<{ id: string; values: Record<string, string> }>('outils:values:save', (data) => saveValues(data.id, data.values));
  }

  private handleGetScript(id: string): void {
    const script = this.config.scripts.find((s) => s.id === id);
    if (!script) {
      this.eventBus.emitGeneric('outils:error', { message: `Script introuvable: ${id}` });
      return;
    }
    try {
      const content = readScriptContent(id);
      const detail: OutilScriptDetail = {
        id: script.id,
        title: script.title,
        description: script.description,
        filename: script.filename,
        requiresSudo: script.requiresSudo,
        content,
        variables: detectVariables(content),
        variableHints: detectVariableHints(content),
        hasBundling: detectBundlePaths(content).length > 0,
        savedValues: readSavedValues(id)
      };
      this.eventBus.emitGeneric('outils:script:result', detail);
    } catch (error) {
      this.eventBus.emitGeneric('outils:error', {
        message: `Lecture du script échouée (${id}): ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  /**
   * ⭐ 18/09/2026 — construit l'archive auto-extractible pour un script `@outils:bundle` (voir
   * BundleBuilder.ts). `content` = le script déjà substitué par le navigateur (mêmes variables
   * qu'un téléchargement direct) ; les chemins à embarquer sont relus depuis le GABARIT du script
   * (pas `content`, qui ne contient plus les commentaires `# @outils:...` une fois substitué —
   * en réalité si, la substitution ne touche que les `__VAR__`, mais on relit le gabarit par
   * simplicité/robustesse plutôt que de faire confiance à un `content` fourni par le client).
   */
  private handleBuildBundle(id: string, content: string): void {
    const script = this.config.scripts.find((s) => s.id === id);
    if (!script) {
      this.emitBundleResult({ success: false, error: `Script introuvable: ${id}` });
      return;
    }
    try {
      const template = readScriptContent(id);
      const bundlePaths = detectBundlePaths(template);
      if (bundlePaths.length === 0) {
        this.emitBundleResult({ success: false, error: `Script sans dépendance @outils:bundle: ${id}` });
        return;
      }
      const { token, filename } = buildBundle(content, bundlePaths, script.filename);
      this.emitBundleResult({ success: true, token, filename });
    } catch (error) {
      this.emitBundleResult({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private emitBundleResult(result: BundleResult): void {
    this.eventBus.emitGeneric('outils:bundle:result', result);
  }

  private handleDeleteScript(id: string): void {
    const exists = this.config.scripts.some((s) => s.id === id);
    if (!exists) {
      this.eventBus.emitGeneric('outils:script:delete:result', { success: false, error: `Script introuvable: ${id}` });
      return;
    }
    this.config = { ...this.config, scripts: this.config.scripts.filter((s) => s.id !== id) };
    const saveResult = this.configProvider.savePartialConfig(this.config);
    if (!saveResult.success) {
      this.eventBus.emitGeneric('outils:script:delete:result', { success: false, error: saveResult.error });
      return;
    }
    deleteScriptContent(id);
    this.eventBus.emitGeneric('app:module:config:saved', { moduleId: MODULE_NAME, success: true });
    this.emitStatus();
    this.eventBus.emitGeneric('outils:script:delete:result', { success: true });
  }

  /** Même conversion que ScriptsHaService.toBuffer() — un Buffer réel en process unique, ou sa
   *  forme sérialisée `{ type: 'Buffer', data: number[] }` une fois traversé l'IPC inter-process. */
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
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Reçoit un script uploadé via la route générique POST /api/apps/outils/upload — voir
   * ScriptsHaService.handleUpload pour le même patron (buffer/filename/mimetype/fields).
   * `fields` attendu : title (requis), description (optionnel), requiresSudo ('true'/'false',
   * champ de formulaire HTML — jamais un booléen réel à travers multipart/form-data).
   */
  private handleUpload(data: UploadEventPayload): void {
    try {
      const title = typeof data.fields?.title === 'string' ? data.fields.title.trim() : '';
      const description = typeof data.fields?.description === 'string' ? data.fields.description.trim() : '';
      const requiresSudo = data.fields?.requiresSudo === 'true' || data.fields?.requiresSudo === true;

      if (!title) {
        this.emitAddResult({ success: false, error: 'Titre requis' });
        return;
      }

      const id = this.uniqueId(this.slugify(title));
      const content = this.toBuffer(data.buffer).toString('utf8');
      const filename = data.filename && data.filename.trim() ? data.filename.trim() : `${id}.sh`;

      const newScript: OutilScriptConfig = { id, title, description, filename, requiresSudo };
      this.config = { ...this.config, scripts: [...this.config.scripts, newScript] };
      const saveResult = this.configProvider.savePartialConfig(this.config);
      if (!saveResult.success) {
        this.emitAddResult({ success: false, error: saveResult.error });
        return;
      }
      writeScriptContent(id, content);

      this.eventBus.emitGeneric('app:module:config:saved', { moduleId: MODULE_NAME, success: true });
      this.emitStatus();
      this.emitAddResult({ success: true });
    } catch (error) {
      this.emitAddResult({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private emitAddResult(result: AddScriptResult): void {
    this.eventBus.emitGeneric('outils:script:add:result', result);
  }

  private uniqueId(base: string): string {
    const root = base || 'script';
    if (!this.config.scripts.some((s) => s.id === root)) return root;
    let i = 2;
    while (this.config.scripts.some((s) => s.id === `${root}-${i}`)) i++;
    return `${root}-${i}`;
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<OutilsConfig>
  ): OutilsService {
    return new OutilsService(eventBus, logger, configProvider);
  }
}
