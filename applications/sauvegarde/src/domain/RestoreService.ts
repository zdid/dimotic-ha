/**
 * Pilotage d'une restauration sur une machine de destination (⭐ 23/09/2026) — dépôt du script
 * généré (RestoreScript.ts) et du netrc temporaire par SSH root, lancement DÉTACHÉ, puis relecture
 * de `restore-status.json` toutes les 3 s, diffusée à l'interface ('sauvegarde:restore:status').
 * Aucun état en mémoire n'est nécessaire pour reprendre : un dimotic-ha redémarré (ou un navigateur
 * rechargé) relit simplement le fichier d'état sur la destination.
 */

import type { IEventBus, Logger } from '../../../core/dist/exports';
import { runSsh, ensureGlobalSshKey, shellQuote } from '../../../core/dist/exports';
import { BACKUP_DIR } from './BackupScript';
import {
  renderRestoreScript,
  RESTORE_SCRIPT_REMOTE_PATH,
  RESTORE_STATUS_REMOTE_PATH,
  RESTORE_NETRC_REMOTE_PATH,
  type RestoreScriptParams
} from './RestoreScript';

const POLL_INTERVAL_MS = 3000;
/** Arrêt de la relecture après ce nombre d'échecs SSH consécutifs (~10 min). */
const MAX_POLL_FAILURES = 200;

export interface RestoreStatus {
  phase: string;
  state: 'running' | 'failed' | 'phase1-done' | 'done';
  step: string;
  message: string;
  updatedAt: string;
  source: string;
  backupRoot: string;
  log: string;
  selfRelocate: boolean;
  items: Record<string, string>;
}

/** Nom d'élément du manifeste = un sous-répertoire direct : jamais de chemin. */
function isSafeItemName(name: string): boolean {
  return Boolean(name) && !name.includes('/') && name !== '.' && name !== '..' && !/[\0\n]/.test(name);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export class RestoreService {
  private readonly pollers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly eventBus: IEventBus, private readonly logger: Logger) {}

  private target(host: string) {
    return { host, sshKeyPath: ensureGlobalSshKey() };
  }

  /** État courant sur la destination, `null` si aucune restauration n'y a jamais été lancée. */
  async readStatus(host: string): Promise<RestoreStatus | null> {
    const result = await runSsh(this.target(host), `cat ${shellQuote(RESTORE_STATUS_REMOTE_PATH)} 2>/dev/null || true`);
    if (!result.success) throw new Error((result.error ?? 'SSH impossible').trim());
    const text = result.output.trim();
    if (!text) return null;
    return JSON.parse(text) as RestoreStatus;
  }

  /** Diffuse l'état et relit toutes les 3 s tant que le script tourne. */
  watch(host: string): void {
    if (this.pollers.has(host)) return;
    let failures = 0;
    const tick = async () => {
      try {
        const status = await this.readStatus(host);
        failures = 0;
        this.eventBus.emitGeneric('sauvegarde:restore:status', { host, status });
        if (!status || status.state !== 'running') this.unwatch(host);
      } catch (error) {
        // Normal pendant une relocalisation de dimotic-ha ou un redémarrage réseau : on insiste.
        if (++failures >= MAX_POLL_FAILURES) {
          this.logger.warn('RestoreService', `Relecture de l'état abandonnée pour ${host}: ${error}`);
          this.unwatch(host);
        }
      }
    };
    this.pollers.set(host, setInterval(() => { void tick(); }, POLL_INTERVAL_MS));
    void tick();
  }

  private unwatch(host: string): void {
    const timer = this.pollers.get(host);
    if (timer) clearInterval(timer);
    this.pollers.delete(host);
  }

  stopAll(): void {
    for (const host of Array.from(this.pollers.keys())) this.unwatch(host);
  }

  private async launch(host: string, phase: 'phase1' | 'phase2'): Promise<void> {
    const log = `${BACKUP_DIR}/restore-${timestamp()}-${phase}.log`;
    // Tous les descripteurs redirigés : la session SSH se termine aussitôt, le script continue seul.
    // ⭐ 23/09/2026 (bug live) : `cd / ; …` et PAS `cd / && … &` — avec `&&`, le `&` mettait toute la
    // liste en arrière-plan dans un sous-shell qui gardait la connexion SSH ouverte jusqu'à la fin du
    // script (« Timeout après 30000ms » sur une restauration de plus de 30 s, alors qu'elle réussissait).
    const command = `cd / ; setsid nohup ${shellQuote(RESTORE_SCRIPT_REMOTE_PATH)} ${phase} ${shellQuote(log)} > ${shellQuote(log)} 2>&1 < /dev/null &`;
    const result = await runSsh(this.target(host), command);
    if (!result.success) throw new Error(`Lancement impossible : ${(result.error ?? '').trim()}`);
  }

  /** Étape 1 : dépose script + netrc, lance, surveille. Refuse si une restauration tourne déjà. */
  async startPhase1(host: string, password: string, params: Omit<RestoreScriptParams, 'timestamp'>): Promise<void> {
    if (!params.items.length) throw new Error('Aucun élément choisi.');
    const bad = params.items.find((i) => !isSafeItemName(i));
    if (bad !== undefined) throw new Error(`Nom d'élément invalide : ${bad}`);
    if (!['docker', 'dimotic-ha-addons'].includes(params.parent)) throw new Error(`Parent inconnu : ${params.parent}`);

    const current = await this.readStatus(host);
    if (current?.state === 'running') throw new Error('Une restauration est déjà en cours sur cette machine.');

    const script = renderRestoreScript({ ...params, timestamp: timestamp() });
    const dir = shellQuote(BACKUP_DIR);
    const scriptResult = await runSsh(this.target(host),
      `mkdir -p ${dir} && cat > ${shellQuote(RESTORE_SCRIPT_REMOTE_PATH)} && chmod 700 ${shellQuote(RESTORE_SCRIPT_REMOTE_PATH)} && rm -f ${shellQuote(RESTORE_STATUS_REMOTE_PATH)}`,
      script);
    if (!scriptResult.success) throw new Error(`Dépôt du script impossible : ${(scriptResult.error ?? '').trim()}`);

    // Même format que le script de sauvegarde (`default login … password …`), jamais en argument de commande.
    const netrc = `default login ${params.user} password ${password}\n`;
    const netrcResult = await runSsh(this.target(host),
      `umask 077 && cat > ${shellQuote(RESTORE_NETRC_REMOTE_PATH)}`, netrc);
    if (!netrcResult.success) throw new Error(`Dépôt des identifiants impossible : ${(netrcResult.error ?? '').trim()}`);

    await this.launch(host, 'phase1');
    this.logger.info('RestoreService', `Étape 1 lancée sur ${host} (${params.site}/${params.machine}/${params.cadence}/${params.parent}-${params.date} : ${params.items.join(', ')})`);
    this.watch(host);
  }

  /** Étape 2 : seulement après une étape 1 terminée (validation humaine faite côté interface). */
  async startPhase2(host: string): Promise<void> {
    const current = await this.readStatus(host);
    if (!current || current.phase !== 'phase1' || current.state !== 'phase1-done') {
      throw new Error(`L'étape 1 n'est pas terminée sur cette machine (état : ${current ? `${current.phase}/${current.state}` : 'aucun'}).`);
    }
    await this.launch(host, 'phase2');
    this.logger.info('RestoreService', `Étape 2 lancée sur ${host}`);
    this.watch(host);
  }
}
