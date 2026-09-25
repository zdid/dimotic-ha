/**
 * SauvegardeService
 *
 * Orchestrateur de l'application Sauvegarde/Restauration. Pour l'instant (tranche 1 du plan
 * d'implémentation) : chargement/rechargement de la config, statut, poussée du secret
 * par SSH — rien de Nextcloud/restauration encore, voir specs/current/fonctionnelles-sauvegarde_specs_v1.5.md §6/§6bis.
 */

import type { IEventBus, Logger, IAppConfigProvider } from '../../../core/dist/exports';
import * as fs from 'node:fs';
import { runSsh, ensureGlobalSshKey, isRunningInDocker, getPrimaryIPv4Address } from '../../../core/dist/exports';
import { sauvegardeConfigSchema, sauvegardeNextcloudSchema, SECRET_FILE_PATH, deriveTargetId, type SauvegardeConfig, type SauvegardeTargetConfig } from './config-schema';
import type { SauvegardeStatus } from './types';
import { SecretPushService } from './SecretPushService';
import { ScriptPushService } from './ScriptPushService';
import { BACKUP_SCRIPT_REMOTE_PATH, BACKUP_DIR } from './BackupScript';
import { NextcloudWebDavClient, NextcloudHttpError, type NextcloudCredentials } from './NextcloudWebDavClient';
import { RestoreService } from './RestoreService';

/** Contrôle de la machine de destination (écran ④) — une ligne `clé=valeur` par point : nom,
 *  espace libre (octets) sur /docker ou / s'il n'existe pas encore (machine neuve), présence de
 *  docker / docker compose / curl / tar. */
const PROBE_COMMAND = [
  'P=/docker; [ -d "$P" ] || P=/',
  'echo "hostname=$(hostname)"',
  'echo "free=$(df -B1 --output=avail "$P" | tail -1 | tr -d \' \')"',
  'command -v docker >/dev/null 2>&1 && echo docker=1 || echo docker=0',
  'docker compose version >/dev/null 2>&1 && echo compose=1 || echo compose=0',
  'command -v curl >/dev/null 2>&1 && echo curl=1 || echo curl=0',
  'command -v tar >/dev/null 2>&1 && echo tar=1 || echo tar=0'
].join('; ');

export interface DestinationProbe {
  host: string;
  reachable: boolean;
  error?: string;
  hostname?: string;
  freeBytes?: number;
  docker?: boolean;
  compose?: boolean;
  curl?: boolean;
  tar?: boolean;
}

/** Une exécution manuelle (tar + push WebDAV) peut prendre largement plus que le timeout SSH par
 *  défaut (30s) selon la taille de /docker sur la machine — ⭐ 23/09/2026 : 15 minutes (5 minutes
 *  dépassées en test live sur ha2, /docker ≈ 2,9 Go → archive 1,6 Go, ~8 min au total). */
const BACKUP_RUN_TIMEOUT_MS = 900000;

const MODULE_NAME = 'sauvegarde';

/** Payload des actions par ligne envoyé par ModuleManager (secretPush/rowActions) : `targetId`
 *  toujours, plus — ⭐ 23/09/2026 — la ligne à l'écran (`item`) et la config du module à l'écran
 *  (`moduleConfig`), voir resolveTarget(). */
/** Requêtes de l'assistant de restauration — `requestId` pour que la page reconnaisse SA réponse
 *  (les résultats sont diffusés à tous les navigateurs). */
interface RestoreRequest {
  requestId: string;
  credentials: NextcloudCredentials;
}

interface RestoreManifestRequest extends RestoreRequest {
  /** IP de la machine de destination (SSH root) — ⭐ 23/09/2026 : choisie dans l'assistant,
   *  préremplie avec l'IP locale (remplace la décision 4 « destination locale seulement »). */
  destinationHost: string;
  backup: { site: string; machine: string; cadence: string; parent: string; date: string };
}

interface RestoreStartRequest extends RestoreManifestRequest {
  items: string[];
  archiveSize: number;
  /** Somme des tailles décompressées des éléments choisis, 0 si inconnue. */
  neededBytes: number;
}

interface RowActionPayload {
  targetId: string;
  item?: Partial<SauvegardeTargetConfig>;
  moduleConfig?: Partial<SauvegardeConfig>;
}

export interface ISauvegardeService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): SauvegardeStatus;
}

export class SauvegardeService implements ISauvegardeService {
  private config: SauvegardeConfig;
  private readonly secretPushService = new SecretPushService();
  private readonly scriptPushService = new ScriptPushService();
  private readonly restoreService: RestoreService;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<SauvegardeConfig>
  ) {
    this.config = this.loadConfig();
    this.restoreService = new RestoreService(eventBus, logger);
  }

  private loadConfig(): SauvegardeConfig {
    const raw = this.configProvider.getAppConfig() as Partial<SauvegardeConfig>;
    return sauvegardeConfigSchema.parse(raw);
  }

  async start(): Promise<void> {
    this.logger.info('SauvegardeService', 'Démarrage du service Sauvegarde/Restauration...');
    this.setupSocketEventListeners();

    this.emitStatus();
    this.logger.info('SauvegardeService', 'Service Sauvegarde/Restauration démarré');
  }

  async stop(): Promise<void> {
    this.logger.info('SauvegardeService', 'Arrêt du service Sauvegarde/Restauration...');
    this.restoreService.stopAll();
  }

  getStatus(): SauvegardeStatus {
    const { serverUrl, user } = this.config.nextcloud;
    return {
      nextcloudConfigured: Boolean(serverUrl && user),
      webdavUrl: serverUrl && user ? `${serverUrl.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(user)}` : '',
      targetsCount: this.config.targets.length
    };
  }

  private emitStatus(): void {
    this.eventBus.emitGeneric('sauvegarde:status', this.getStatus());
  }

  // ==========================================================================
  // ⭐ 25/09/2026 — état des sauvegardes pour la supervision (spec §5quater)
  // ==========================================================================

  /** Lit par SSH, sur chaque machine couverte, script/cron installés, status.json et marqueurs
   *  last-<dossier>-<cadence> — jamais Nextcloud (pas de mot de passe dans dimotic-ha). */
  private async handleSupervisionStatus(correlationId: string): Promise<void> {
    const sshKeyPath = ensureGlobalSshKey();
    const sep = '__DIMOTIC_SEP__';
    const command = [
      `test -x ${BACKUP_SCRIPT_REMOTE_PATH} && echo script || echo noscript`,
      `crontab -l 2>/dev/null | grep -qF ${BACKUP_SCRIPT_REMOTE_PATH} && echo cron || echo nocron`,
      `echo ${sep}`,
      `cat ${BACKUP_DIR}/status.json 2>/dev/null`,
      `echo ${sep}`,
      `for f in ${BACKUP_DIR}/last-*; do [ -f "$f" ] && echo "$(basename "$f") $(cat "$f")"; done; true`
    ].join('; ');

    const machines = await Promise.all(this.config.targets.map(async (t) => {
      const base = { id: t.id, site: t.site, machine: t.machine, host: t.host };
      const result = await runSsh({ host: t.host, sshKeyPath }, command, undefined, 20_000);
      if (!result.success) {
        return { ...base, reachable: false, error: result.error || result.output.trim().slice(-200), scriptInstalled: false, cronInstalled: false, status: null, lastSuccess: {} };
      }
      const [head = '', statusText = '', lastText = ''] = result.output.split(sep);
      let status: unknown = null;
      try { status = statusText.trim() ? JSON.parse(statusText) : null; } catch { status = null; }
      const lastSuccess: Record<string, Record<string, string>> = {};
      for (const line of lastText.split('\n')) {
        const m = /^last-(.+)-(journalier|hebdomadaire)\s+(\S+)/.exec(line.trim());
        if (m) (lastSuccess[m[1]] ??= {})[m[2]] = m[3];
      }
      return {
        ...base, reachable: true,
        scriptInstalled: /\bscript\b/.test(head), cronInstalled: /\bcron\b/.test(head),
        status, lastSuccess
      };
    }));
    this.eventBus.emitGeneric('sauvegarde:supervision:status:reply', { correlation_id: correlationId, success: true, machines });
  }

  private setupSocketEventListeners(): void {
    this.eventBus.onGeneric<{ correlation_id: string }>('sauvegarde:supervision:status', (req) => {
      this.handleSupervisionStatus(req.correlation_id).catch((error) => {
        this.eventBus.emitGeneric('sauvegarde:supervision:status:reply', {
          correlation_id: req.correlation_id, success: false, error: error instanceof Error ? error.message : String(error)
        });
      });
    });
    this.eventBus.onGeneric('sauvegarde:status:get', () => this.emitStatus());

    // Même correctif que teleinfo/rpigpio (pas la version d'arexx, qui omet ce reload()) : sans
    // lui, une config sauvegardée depuis l'UI n'est jamais relue ici, malgré une écriture disque
    // correcte — voir ArexxService.ts pour l'historique du bug.
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (event) => {
      if (event.moduleId !== MODULE_NAME || !event.success) return;
      this.configProvider.reload();
      this.config = this.loadConfig();
      this.emitStatus();
    });

    this.eventBus.onGeneric<RowActionPayload & { appPassword: string }>('sauvegarde:secret:push', (data) => {
      this.handleSecretPush(data).catch((error) => {
        this.logger.error('SauvegardeService', `Échec de la poussée du secret (${data.targetId}): ${error}`);
      });
    });

    // ⭐ 23/09/2026 — assistant de restauration, écrans ①-④ (lecture seule : rien n'est modifié sur
    // aucune machine) — voir la page presentation/sauvegarde/restauration.html.
    this.eventBus.onGeneric<{ requestId: string }>('sauvegarde:restore:context:get', (data) => {
      this.eventBus.emitGeneric('sauvegarde:restore:context', {
        requestId: data?.requestId,
        nextcloud: this.config.nextcloud,
        publicKey: SauvegardeService.readPublicKey(),
        localIp: getPrimaryIPv4Address() ?? '',
        runningInDocker: isRunningInDocker()
      });
    });

    this.eventBus.onGeneric<{ requestId: string; destinationHost: string }>('sauvegarde:restore:probe', (data) => {
      this.probeDestination(data.destinationHost).then((probe) => {
        this.eventBus.emitGeneric('sauvegarde:restore:probe:result', { requestId: data.requestId, probe });
      }).catch((error) => {
        this.logger.error('SauvegardeService', `Échec du contrôle de destination: ${error}`);
      });
    });

    // ⭐ 23/09/2026 — script de restauration (écrans ⑤/⑥).
    this.eventBus.onGeneric<RestoreStartRequest>('sauvegarde:restore:start', (data) => {
      this.handleRestoreStart(data).catch((error) => {
        this.logger.error('SauvegardeService', `Échec du lancement de la restauration: ${error}`);
      });
    });

    this.eventBus.onGeneric<{ requestId: string; destinationHost: string }>('sauvegarde:restore:start2', (data) => {
      const host = (data.destinationHost || '').trim();
      this.restoreService.startPhase2(host).then(() => {
        this.eventBus.emitGeneric('sauvegarde:restore:start2:result', { requestId: data.requestId, success: true });
      }).catch((error) => {
        this.eventBus.emitGeneric('sauvegarde:restore:start2:result', {
          requestId: data.requestId, success: false, error: error instanceof Error ? error.message : String(error)
        });
      });
    });

    // Rechargement de page / reconnexion : relit l'état sur la destination et reprend la surveillance
    // si le script tourne encore.
    this.eventBus.onGeneric<{ destinationHost: string }>('sauvegarde:restore:status:get', (data) => {
      const host = (data?.destinationHost || '').trim();
      if (!host) return;
      this.restoreService.readStatus(host).then((status) => {
        this.eventBus.emitGeneric('sauvegarde:restore:status', { host, status });
        if (status?.state === 'running') this.restoreService.watch(host);
      }).catch(() => {
        this.eventBus.emitGeneric('sauvegarde:restore:status', { host, status: null });
      });
    });

    this.eventBus.onGeneric<RestoreRequest>('sauvegarde:restore:list', (data) => {
      this.handleRestoreList(data).catch((error) => {
        this.logger.error('SauvegardeService', `Échec du listage des sauvegardes: ${error}`);
      });
    });

    this.eventBus.onGeneric<RestoreManifestRequest>('sauvegarde:restore:manifest', (data) => {
      this.handleRestoreManifest(data).catch((error) => {
        this.logger.error('SauvegardeService', `Échec de lecture du manifeste: ${error}`);
      });
    });

    this.eventBus.onGeneric<RowActionPayload>('sauvegarde:backup:run', (data) => {
      this.handleBackupRunNow(data).catch((error) => {
        this.logger.error('SauvegardeService', `Échec du déclenchement manuel (${data.targetId}): ${error}`);
      });
    });
  }

  /**
   * ⭐ 23/09/2026, demande explicite (test live) : « Pousser »/« Lancer maintenant » travaillent sur
   * la ligne TELLE QU'AFFICHÉE à l'écran (`item`, envoyé par ModuleManager avec la config du module
   * à l'écran, `moduleConfig`), plus sur le fichier — il n'était pas naturel de devoir cliquer
   * « Enregistrer » en bas de page avant. Retombe sur la config persistée (par `targetId`) pour un
   * navigateur qui n'enverrait pas `item`.
   */
  private resolveTarget(data: RowActionPayload): SauvegardeTargetConfig | undefined {
    const item = data.item;
    if (item && item.site && item.machine && item.host) {
      const site = String(item.site).trim();
      const machine = String(item.machine).trim();
      const host = String(item.host).trim();
      // ⭐ 23/09/2026 (2e bug live — une nouvelle ligne stfort envoyée avec l'id "-" de la ligne
      // ha2 a remplacé ha2 dans la config) : l'id reçu n'est gardé que s'il désigne une ligne
      // persistée de MÊME hôte ; sinon il est recalculé depuis site+machine. Une poussée ne peut
      // donc jamais écraser une autre machine.
      const sameRow = this.config.targets.find((t) => t.id === item.id && t.host === host);
      return {
        id: sameRow ? sameRow.id : deriveTargetId(site, machine),
        site,
        machine,
        host,
        secretDeployed: sameRow?.secretDeployed ?? false
      };
    }
    return this.config.targets.find((t) => t.id === data.targetId);
  }

  /** Section Nextcloud à l'écran si elle est complète et valide, sinon celle du fichier. */
  private resolveNextcloud(data: RowActionPayload): SauvegardeConfig['nextcloud'] {
    const parsed = sauvegardeNextcloudSchema.safeParse(data.moduleConfig?.nextcloud);
    return parsed.success && parsed.data.serverUrl && parsed.data.user ? parsed.data : this.config.nextcloud;
  }

  /**
   * Point d'entrée UI pour écrire le mot de passe d'application Nextcloud sur une machine, sans
   * passer par un terminal — voir SecretPushService. `appPassword` ne transite par aucune écriture
   * de config ici, seulement par SSH (stdin) vers `SECRET_FILE_PATH` sur la cible.
   *
   * ⭐ 18/09/2026, demande explicite : « Pousser » ne se limite plus au mot de passe — il pousse
   * aussi le script de sauvegarde (chantier A, BackupScript.ts) et pose son cron quotidien
   * (ScriptPushService), dans la foulée. Le tag persistant `secretDeployed` ne passe à vrai que si
   * les TROIS étapes réussissent (secret → script → cron). `result.step` (`'push'` pour le secret,
   * `'script'`/`'cron'` pour la suite) distingue laquelle des trois a échoué, affiché tel quel côté UI.
   *
   * ⭐ 23/09/2026 : en cas de succès, la ligne poussée (mise à jour par id, ou ajoutée si absente)
   * et la section Nextcloud utilisées sont ENREGISTRÉES — ce qui a été déployé sur la machine est
   * toujours ce que le fichier décrit, sans « Enregistrer » préalable.
   */
  private async handleSecretPush(data: RowActionPayload & { appPassword: string }): Promise<void> {
    const targetId = data.targetId;
    const target = this.resolveTarget(data);
    if (!target) {
      this.eventBus.emitGeneric('sauvegarde:secret:push:result', {
        targetId,
        success: false,
        error: `Machine incomplète (site, machine et hôte requis) ou introuvable: ${targetId}`
      });
      return;
    }
    const nextcloud = this.resolveNextcloud(data);

    try {
      const secretResult = await this.secretPushService.push(target, SECRET_FILE_PATH, data.appPassword);
      if (!secretResult.success) {
        this.eventBus.emitGeneric('sauvegarde:secret:push:result', { targetId, ...secretResult });
        return;
      }

      const scriptResult = await this.scriptPushService.push(target, {
        site: target.site,
        machine: target.machine,
        serverUrl: nextcloud.serverUrl,
        user: nextcloud.user,
        rootPath: nextcloud.rootPath,
        secretFilePath: SECRET_FILE_PATH
      });

      if (scriptResult.success) {
        const deployed = { ...target, secretDeployed: true };
        const exists = this.config.targets.some((t) => t.id === target.id);
        this.config = {
          ...this.config,
          nextcloud,
          targets: exists
            ? this.config.targets.map((t) => t.id === target.id ? deployed : t)
            : [...this.config.targets, deployed]
        };
        const saveResult = this.configProvider.savePartialConfig(this.config);
        if (saveResult.success) {
          this.eventBus.emitGeneric('app:module:config:saved', { moduleId: MODULE_NAME, success: true });
          this.emitStatus();
        } else {
          this.logger.error('SauvegardeService', `Script poussé mais machine non enregistrée (${target.id}): ${saveResult.error}`);
        }
      }
      // `id` : id réellement retenu (voir resolveTarget) — le navigateur l'adopte pour cette ligne.
      this.eventBus.emitGeneric('sauvegarde:secret:push:result', { targetId, id: target.id, ...scriptResult });
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:secret:push:result', {
        targetId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Exécute par SSH le script déjà déployé sur l'hôte de la ligne, tout de suite, sans attendre le
   * cron — ⭐ 18/09/2026, demande explicite ("je dois pouvoir déclencher une sauvegarde à la
   * demande"). Ne pousse rien de nouveau (secret/script/cron inchangés) : suppose que « Pousser » a
   * déjà été cliqué au moins une fois pour cette machine — sinon le script est simplement absent et
   * la commande échoue avec un message clair ("No such file or directory").
   */
  private async handleBackupRunNow(data: RowActionPayload): Promise<void> {
    const targetId = data.targetId;
    const target = this.resolveTarget(data);
    if (!target || !target.host) {
      this.eventBus.emitGeneric('sauvegarde:backup:run:result', {
        targetId,
        success: false,
        error: `Machine incomplète (hôte requis) ou introuvable: ${targetId}`
      });
      return;
    }

    try {
      const sshKeyPath = ensureGlobalSshKey();
      const result = await runSsh({ host: target.host, sshKeyPath }, BACKUP_SCRIPT_REMOTE_PATH, undefined, BACKUP_RUN_TIMEOUT_MS);
      this.eventBus.emitGeneric('sauvegarde:backup:run:result', {
        targetId,
        success: result.success,
        error: result.error
      });
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:backup:run:result', {
        targetId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private static errorMessage(error: unknown): string {
    if (error instanceof NextcloudHttpError) return error.message;
    const message = error instanceof Error ? error.message : String(error);
    return /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(message)
      ? `Nextcloud injoignable (${message}) — vérifier l'URL du serveur.`
      : message;
  }

  /** Écran ② — sauvegardes réellement présentes sur Nextcloud (décision point 2 : pas la config). */
  private async handleRestoreList(data: RestoreRequest): Promise<void> {
    try {
      const backups = await new NextcloudWebDavClient(data.credentials).listBackups();
      this.eventBus.emitGeneric('sauvegarde:restore:list:result', { requestId: data.requestId, success: true, backups });
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:restore:list:result', {
        requestId: data.requestId, success: false, error: SauvegardeService.errorMessage(error)
      });
    }
  }

  /**
   * Écran ③ — manifeste (éléments + tailles décompressées), espace libre sur la machine de
   * destination (SSH) et IP de la source si elle figure dans la config (avertissement non bloquant
   * si ≠ IP de destination, point 5).
   */
  private async handleRestoreManifest(data: RestoreManifestRequest): Promise<void> {
    const b = data.backup;
    try {
      const items = await new NextcloudWebDavClient(data.credentials).readManifest(b);
      const known = this.config.targets.find((t) => t.site === b.site && t.machine === b.machine);
      const destination = await this.probeDestination(data.destinationHost);
      this.eventBus.emitGeneric('sauvegarde:restore:manifest:result', {
        requestId: data.requestId,
        success: true,
        items,
        sourceIp: known?.host ?? '',
        destination
      });
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:restore:manifest:result', {
        requestId: data.requestId, success: false, error: SauvegardeService.errorMessage(error)
      });
    }
  }

  /**
   * Étape 1 de la restauration. Relocalisation de dimotic-ha (point 10) seulement si la
   * destination est la machine qui pilote, sous Docker, et que dimotic-ha est coché.
   */
  private async handleRestoreStart(data: RestoreStartRequest): Promise<void> {
    const host = (data.destinationHost || '').trim();
    try {
      const b = data.backup;
      const selfRelocate = isRunningInDocker() && host === getPrimaryIPv4Address()
        && b.parent === 'docker' && data.items.includes('dimotic-ha');
      await this.restoreService.startPhase1(host, data.credentials.password, {
        serverUrl: data.credentials.serverUrl,
        user: data.credentials.user,
        rootPath: data.credentials.rootPath,
        site: b.site,
        machine: b.machine,
        cadence: b.cadence,
        parent: b.parent,
        date: b.date,
        items: data.items,
        archiveSize: Number(data.archiveSize) || 0,
        neededBytes: Number(data.neededBytes) || 0,
        selfRelocate
      });
      this.eventBus.emitGeneric('sauvegarde:restore:start:result', { requestId: data.requestId, success: true, host });
    } catch (error) {
      this.eventBus.emitGeneric('sauvegarde:restore:start:result', {
        requestId: data.requestId, success: false, host, error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Clé publique de ce dimotic-ha, à autoriser pour root sur la destination (ssh-copy-id). */
  private static readPublicKey(): string {
    try {
      return fs.readFileSync(`${ensureGlobalSshKey()}.pub`, 'utf8').trim();
    } catch {
      return '';
    }
  }

  /**
   * Contrôle de la machine de destination, toujours par SSH root (⭐ 23/09/2026, demande
   * explicite : la restauration se pilote depuis n'importe quel dimotic-ha vers une machine juste
   * installée, avec ou sans dimotic-ha — seul prérequis, la clé autorisée pour root ; sous Docker,
   * la machine locale se joint aussi par SSH vers sa propre IP, le conteneur ne voyant pas /docker
   * de l'hôte). Docker/curl/tar absents ne bloquent pas : l'étape 1 les installera.
   */
  private async probeDestination(host: string): Promise<DestinationProbe> {
    host = (host || '').trim();
    if (!host) return { host, reachable: false, error: 'Machine de destination non renseignée.' };
    const result = await runSsh({ host, sshKeyPath: ensureGlobalSshKey() }, PROBE_COMMAND);
    if (!result.success) {
      const raw = (result.error ?? 'échec').trim();
      const error = /Permission denied/i.test(raw)
        ? `Clé de dimotic-ha non autorisée pour root@${host} — faire le ssh-copy-id (voir ci-dessus). (${raw})`
        : `SSH root@${host} impossible : ${raw}`;
      return { host, reachable: false, error };
    }
    const values = new Map<string, string>();
    for (const line of result.output.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) values.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    const free = Number(values.get('free'));
    return {
      host,
      reachable: true,
      hostname: values.get('hostname'),
      freeBytes: Number.isFinite(free) && values.get('free') !== '' ? free : undefined,
      docker: values.get('docker') === '1',
      compose: values.get('compose') === '1',
      curl: values.get('curl') === '1',
      tar: values.get('tar') === '1'
    };
  }

  static create(
    eventBus: IEventBus,
    logger: Logger,
    configProvider: IAppConfigProvider<SauvegardeConfig>
  ): SauvegardeService {
    return new SauvegardeService(eventBus, logger, configProvider);
  }
}
