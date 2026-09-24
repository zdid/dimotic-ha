/**
 * OutilsService — orchestrateur de l'application Outils (bibliothèque de scripts shell
 * paramétrables). Chargement de la liste des scripts (fusion intégrés + ajoutés, voir
 * ScriptTemplate.ts), ajout via 3 dépôts corrélés (yaml + wrapper + moteur optionnel),
 * suppression (scripts ajoutés uniquement), lecture d'un script (contenu + variables détectées).
 * La génération/téléchargement elle-même se fait entièrement côté navigateur — rien à orchestrer
 * côté serveur pour ça, sauf pour un script avec dépendances réelles (@outils:bundle, archive
 * auto-extractible ou .zip, voir BundleBuilder.ts).
 */

import AdmZip from 'adm-zip';
import * as yamlLib from 'js-yaml';
import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import { outilScriptSchema, isSafeId, isSafeFilename, type OutilsConfig, type OutilScriptConfig } from './config-schema';
import type { OutilsStatus, OutilScriptDetail, AddScriptResult, BundleResult, ZipResult } from './types';
import {
  builtinRoot, dataRoot, listYamlScripts, readWrapperContent, writeWrapperContent,
  writeYamlEntry, readYamlContent, deleteScriptFiles, writeEngineFile,
  detectVariables, detectVariableHints, detectBundlePaths
} from './ScriptTemplate';
import { buildBundle, buildZip } from './BundleBuilder';
import { readSavedValues, saveValues } from './ScriptValues';

const MODULE_NAME = 'outils';
const UPLOAD_BATCH_TTL_MS = 10 * 60 * 1000;

interface UploadEventPayload {
  buffer: unknown;
  filename: string;
  mimetype: string;
  fields: Record<string, unknown>;
}

interface PendingUploadBatch {
  createdAt: number;
  yamlContent?: string;
  wrapper?: { content: string };
  engine?: { content: Buffer; filename: string };
}

export interface IOutilsService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): OutilsStatus;
}

export class OutilsService implements IOutilsService {
  private readonly pendingUploads = new Map<string, PendingUploadBatch>();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    // ⭐ 20/09/2026 — plus utilisé pour les scripts (voir config-schema.ts), conservé pour la
    // signature standard de factory attendue par AppService.
    private readonly configProvider: IAppConfigProvider<OutilsConfig>
  ) {}

  async start(): Promise<void> {
    this.logger.info('OutilsService', 'Démarrage du service Outils...');
    this.setupSocketEventListeners();
    this.emitStatus();
    this.logger.info('OutilsService', 'Service Outils démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('OutilsService', 'Arrêt du service Outils...');
  }

  /** Fusionne scripts intégrés (applications/outils/reposcripts/, dans l'image Docker) et scripts
   *  ajoutés (data/outils/reposcripts/, propres à cette machine) — un id intégré prime toujours
   *  sur un id ajouté homonyme (ne devrait pas arriver, finalizeUpload() le bloque déjà en amont). */
  private loadMergedScripts(): Array<OutilScriptConfig & { root: string; builtin: boolean }> {
    const builtin = listYamlScripts(builtinRoot()).map((s) => ({ ...s, root: builtinRoot(), builtin: true }));
    const builtinIds = new Set(builtin.map((s) => s.id));
    const custom = listYamlScripts(dataRoot())
      .filter((s) => !builtinIds.has(s.id))
      .map((s) => ({ ...s, root: dataRoot(), builtin: false }));
    return [...builtin, ...custom];
  }

  getStatus(): OutilsStatus {
    return {
      scripts: this.loadMergedScripts().map((s) => ({
        id: s.id, title: s.title, description: s.description, filename: s.filename,
        requiresSudo: s.requiresSudo, builtin: s.builtin
      }))
    };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('outils:status', this.getStatus());
  }

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric('outils:status:get', () => this.emitStatus());

    this.eventBus.onGeneric<{ id: string }>('outils:script:get', (data) => this.handleGetScript(data.id));
    this.eventBus.onGeneric<{ id: string }>('outils:script:delete', (data) => this.handleDeleteScript(data.id));
    this.eventBus.onGeneric<UploadEventPayload>('outils:internal:upload', (data) => this.handleUpload(data));
    this.eventBus.onGeneric<{ id: string; content: string }>('outils:bundle:build', (data) => this.handleBuildBundle(data.id, data.content));
    this.eventBus.onGeneric<{ id: string; content: string }>('outils:zip:build', (data) => this.handleBuildZip(data.id, data.content));
    this.eventBus.onGeneric<{ id: string; values: Record<string, string> }>('outils:values:save', (data) => {
      // ⭐ 24/09/2026 — id contrôlé (chemin <id>.json) : seulement un script réellement connu.
      if (!isSafeId(data?.id) || !this.loadMergedScripts().some((s) => s.id === data.id)) {
        this.logger.warn('OutilsService', `Valeurs refusées pour un id de script inconnu ou invalide: ${JSON.stringify(data?.id)}`);
        return;
      }
      saveValues(data.id, data.values);
    });
  }

  private handleGetScript(id: string): void {
    const script = this.loadMergedScripts().find((s) => s.id === id);
    if (!script) {
      this.eventBus.emitGeneric('outils:error', { message: `Script introuvable: ${id}` });
      return;
    }
    try {
      const content = readWrapperContent(script.root, id);
      const detail: OutilScriptDetail = {
        id: script.id,
        title: script.title,
        description: script.description,
        filename: script.filename,
        requiresSudo: script.requiresSudo,
        builtin: script.builtin,
        content,
        variables: detectVariables(content),
        variableHints: detectVariableHints(content),
        hasBundling: detectBundlePaths(content).length > 0,
        savedValues: readSavedValues(id),
        yamlContent: readYamlContent(script.root, id)
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
    const script = this.loadMergedScripts().find((s) => s.id === id);
    if (!script) {
      this.emitBundleResult({ success: false, error: `Script introuvable: ${id}` });
      return;
    }
    try {
      const template = readWrapperContent(script.root, id);
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

  /** ⭐ 20/09/2026 — .zip contenant le wrapper substitué + son yaml, et les éventuelles dépendances
   *  @outils:bundle (mêmes fichiers que buildBundle(), simplement pas emballés en archive
   *  auto-extractible) — proposé pour tout script, avec ou sans dépendance déclarée. */
  private handleBuildZip(id: string, content: string): void {
    const script = this.loadMergedScripts().find((s) => s.id === id);
    if (!script) {
      this.emitZipResult({ success: false, error: `Script introuvable: ${id}` });
      return;
    }
    try {
      const template = readWrapperContent(script.root, id);
      const bundlePaths = detectBundlePaths(template);
      const yamlContent = readYamlContent(script.root, id);
      const zipFilename = script.filename.replace(/\.sh$/i, '') + '.zip';
      buildZip(content, script.filename, bundlePaths, { [`${id}.yaml`]: yamlContent }, zipFilename)
        .then(({ token, filename }) => this.emitZipResult({ success: true, token, filename }))
        .catch((error: unknown) => this.emitZipResult({ success: false, error: error instanceof Error ? error.message : String(error) }));
    } catch (error) {
      this.emitZipResult({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private emitZipResult(result: ZipResult): void {
    this.eventBus.emitGeneric('outils:zip:result', result);
  }

  private handleDeleteScript(id: string): void {
    const script = this.loadMergedScripts().find((s) => s.id === id);
    if (!script) {
      this.eventBus.emitGeneric('outils:script:delete:result', { success: false, error: `Script introuvable: ${id}` });
      return;
    }
    if (script.builtin) {
      this.eventBus.emitGeneric('outils:script:delete:result', { success: false, error: 'Un script intégré ne peut pas être retiré (livré avec dimotic-ha).' });
      return;
    }
    deleteScriptFiles(dataRoot(), id);
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

  /**
   * ⭐ 20/09/2026 — remplace l'ancien formulaire "titre/description + un seul fichier" : 3 dépôts
   * séparés (yaml + wrapper obligatoires, moteur optionnel), corrélés par `fields.batchId` (généré
   * côté navigateur), chacun envoyé par un appel séparé à la route générique
   * POST /api/apps/outils/upload (voir ScriptsHaService.handleUpload pour le même patron de
   * buffer/filename/mimetype/fields). Finalisé (écriture réelle) dès que yaml+wrapper sont tous les
   * deux arrivés pour un batchId donné — le moteur, s'il arrive après, est simplement ajouté au
   * pool partagé sans reconditionner le reste.
   */
  private handleUpload(data: UploadEventPayload): void {
    const role = typeof data.fields?.role === 'string' ? data.fields.role : '';

    // ⭐ 20/09/2026 — import zip (export d'un autre site) : autonome, pas de corrélation batchId
    // nécessaire, tout arrive dans un seul fichier.
    if (role === 'zip') {
      this.handleZipImport(this.toBuffer(data.buffer));
      return;
    }

    const batchId = typeof data.fields?.batchId === 'string' ? data.fields.batchId : '';
    if (!batchId || (role !== 'yaml' && role !== 'wrapper' && role !== 'engine')) {
      this.emitAddResult({ success: false, error: 'Dépôt invalide (batchId/role manquant).' });
      return;
    }
    this.pruneStaleUploads();

    const buffer = this.toBuffer(data.buffer);
    const batch: PendingUploadBatch = this.pendingUploads.get(batchId) ?? { createdAt: Date.now() };
    if (role === 'yaml') batch.yamlContent = buffer.toString('utf8');
    else if (role === 'wrapper') batch.wrapper = { content: buffer.toString('utf8') };
    else batch.engine = { content: buffer, filename: data.filename };
    this.pendingUploads.set(batchId, batch);

    if (batch.yamlContent && batch.wrapper) {
      this.finalizeUpload(batchId, batch);
    }
  }

  /**
   * ⭐ 20/09/2026, demande explicite — import d'un .zip précédemment exporté (voir
   * handleBuildZip/buildZip), pour partager un script custom entre sites sans repasser par les 3
   * dépôts séparés. Ne lit QUE le `.yaml` et le wrapper qu'il désigne (`filename`) — jamais
   * `zip.extractAllTo()` (vulnérabilité connue de suivi de symlink côté destination sur les
   * versions d'adm-zip <0.6.1, corrigée mais évitée par prudence : on ne construit jamais un
   * chemin disque à partir d'un nom d'entrée fourni par l'archive elle-même, uniquement depuis
   * `entry.id`/`entry.filename` validés par `outilScriptSchema`). Limitation assumée : les
   * dépendances `@outils:bundle` éventuelles d'un script custom (rare — les scripts intégrés,
   * seuls à avoir des dépendances aujourd'hui, en référencent déjà des copies déjà présentes dans
   * l'image sur la machine cible) ne sont PAS ré-importées — seuls yaml+wrapper le sont.
   */
  private handleZipImport(buffer: Buffer): void {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();

      const yamlEntry = entries.find((e) => !e.isDirectory && (e.entryName.endsWith('.yaml') || e.entryName.endsWith('.yml')));
      if (!yamlEntry) {
        this.emitAddResult({ success: false, error: 'Zip sans fichier .yaml — import impossible.' });
        return;
      }
      const entry = outilScriptSchema.parse(yamlLib.load(yamlEntry.getData().toString('utf8')));

      if (this.loadMergedScripts().some((s) => s.id === entry.id && s.builtin)) {
        this.emitAddResult({ success: false, error: `L'id "${entry.id}" est déjà utilisé par un script intégré.` });
        return;
      }

      const wrapperEntry = entries.find((e) => !e.isDirectory && e.entryName === entry.filename);
      if (!wrapperEntry) {
        this.emitAddResult({ success: false, error: `Zip : wrapper "${entry.filename}" introuvable dedans.` });
        return;
      }

      writeYamlEntry(dataRoot(), entry);
      writeWrapperContent(dataRoot(), entry.id, wrapperEntry.getData().toString('utf8'));

      this.emitStatus();
      this.emitAddResult({ success: true });
    } catch (error) {
      this.emitAddResult({ success: false, error: `Import zip échoué: ${describeError(error)}` });
    }
  }

  private finalizeUpload(batchId: string, batch: PendingUploadBatch): void {
    this.pendingUploads.delete(batchId);
    try {
      const parsed = yamlLib.load(batch.yamlContent!);
      const entry = outilScriptSchema.parse(parsed);

      if (this.loadMergedScripts().some((s) => s.id === entry.id && s.builtin)) {
        this.emitAddResult({ success: false, error: `L'id "${entry.id}" est déjà utilisé par un script intégré.` });
        return;
      }

      // ⭐ 24/09/2026 — nom du fichier moteur contrôlé (sert tel quel de chemin sur disque).
      if (batch.engine && !isSafeFilename(batch.engine.filename)) {
        this.emitAddResult({ success: false, error: `Nom de fichier moteur invalide: « ${batch.engine.filename} » (lettres, chiffres, « . », « - », « _ »).` });
        return;
      }

      writeYamlEntry(dataRoot(), entry);
      writeWrapperContent(dataRoot(), entry.id, batch.wrapper!.content);
      if (batch.engine) writeEngineFile(dataRoot(), batch.engine.filename, batch.engine.content);

      this.emitStatus();
      this.emitAddResult({ success: true });
    } catch (error) {
      this.emitAddResult({ success: false, error: `Yaml invalide: ${describeError(error)}` });
    }
  }

  private pruneStaleUploads(): void {
    const now = Date.now();
    for (const [id, batch] of this.pendingUploads) {
      if (now - batch.createdAt > UPLOAD_BATCH_TTL_MS) this.pendingUploads.delete(id);
    }
  }

  private emitAddResult(result: AddScriptResult): void {
    this.eventBus.emitGeneric('outils:script:add:result', result);
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<OutilsConfig>
  ): OutilsService {
    return new OutilsService(eventBus, logger, configProvider);
  }
}

/** Message lisible — une erreur de validation Zod donne « champ : motif » au lieu de son JSON brut. */
function describeError(error: unknown): string {
  const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> })?.issues;
  if (Array.isArray(issues)) return issues.map((i) => `${i.path.join('.') || 'racine'} : ${i.message}`).join(' ; ');
  return error instanceof Error ? error.message : String(error);
}
