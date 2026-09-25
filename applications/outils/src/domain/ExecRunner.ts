/**
 * ⭐ 25/09/2026 — exécution d'un script Outils sur une machine par SSH (fonctionnelles-outils_specs
 * §5.5, décisions utilisateur) : Outils se connecte LUI-MÊME avec la clé unique de dimotic-ha
 * (`data/core/ssh/id_ed25519`), copie le script (`scp`) puis le lance avec un pseudo-terminal
 * (`ssh -tt`) — la sortie est relayée en direct et ce que l'utilisateur tape est envoyé au script
 * comme dans un terminal (confirmations `read -rp` des scripts interactifs).
 *
 * Jamais d'exécution locale (en Docker, le script ne pourrait rien faire sur la machine hôte) : pour
 * agir sur la machine locale, on la vise par SSH comme une autre. Pas de délai maximal (script
 * interactif) : arrêt manuel (`cancel`).
 *
 * ⚠️ Sécurité (décision utilisateur : « à noter, pour l'instant on fait ») — accès root distant
 * depuis une page sans mot de passe : confirmation/journal/restriction notés au TODO.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../../../core/dist/exports';
import { ensureGlobalSshKey } from '../../../core/dist/exports';

export interface ExecTarget {
  host: string;
  user: string;
  /** Dossier de travail distant (vide = dossier personnel de l'utilisateur). */
  dossier?: string;
}

/** `runId` passé à chaque appel : le premier message part avant que start() ait rendu la main. */
export interface ExecCallbacks {
  onOutput: (runId: string, chunk: string) => void;
  onEnd: (runId: string, code: number | null, error?: string) => void;
}

/** Hôte (nom ou IPv4/IPv6), utilisateur Unix, dossier : formats contrôlés — ils finissent dans des
 *  arguments ssh/scp ou dans la commande distante. */
const HOST_RE = /^[A-Za-z0-9._:-]+$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;
const DOSSIER_RE = /^[A-Za-z0-9._/~ -]*$/;

export function validateTarget(target: ExecTarget): string | undefined {
  if (!HOST_RE.test(target.host || '')) return `Hôte invalide : « ${target.host} »`;
  if (!USER_RE.test(target.user || '')) return `Utilisateur invalide : « ${target.user} »`;
  if (target.dossier && (!DOSSIER_RE.test(target.dossier) || target.dossier.includes('..'))) {
    return `Dossier invalide : « ${target.dossier} »`;
  }
  return undefined;
}

function sshOptions(): string[] {
  return [
    '-i', ensureGlobalSshKey(),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new'
  ];
}

/** Guillemets simples pour la commande distante (dossier : format déjà contrôlé). */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class ExecRunner {
  private readonly runs = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly logger: Logger) {}

  /**
   * Lance une exécution. `scriptPath` : fichier local à copier puis exécuter (script substitué ou
   * archive auto-extractible) ; `deleteAfter` : supprimé localement une fois copié.
   */
  start(scriptPath: string, target: ExecTarget, callbacks: ExecCallbacks, deleteAfter: string[] = []): string {
    const runId = crypto.randomBytes(8).toString('hex');
    const remotePath = `/tmp/outils-${runId}.sh`;
    const dest = `${target.user}@${target.host}`;
    const cleanupLocal = () => { for (const f of deleteAfter) fs.rmSync(f, { force: true }); };

    this.logger.info('ExecRunner', `Exécution ${runId} : copie vers ${dest}:${remotePath}`);
    callbacks.onOutput(runId, `$ scp → ${dest}:${remotePath}\n`);

    const scp = spawn('scp', [...sshOptions(), '-q', scriptPath, `${dest}:${remotePath}`]);
    let scpErr = '';
    scp.stderr.on('data', (d) => { scpErr += d.toString(); });
    scp.on('error', (err) => { cleanupLocal(); callbacks.onEnd(runId, null, `scp introuvable : ${err.message}`); });
    scp.on('close', (code) => {
      cleanupLocal();
      if (code !== 0) {
        callbacks.onEnd(runId, code, `Copie impossible (scp code ${code}) : ${scpErr.trim() || 'erreur inconnue'} — la clé SSH de dimotic-ha est-elle installée sur ${dest} (ssh-copy-id) ?`);
        return;
      }
      const cd = target.dossier ? `cd ${quote(target.dossier)} && ` : '';
      const remoteCommand = `${cd}bash ${remotePath}; rc=$?; rm -f ${remotePath}; exit $rc`;
      callbacks.onOutput(runId, `$ ssh ${dest} ${target.dossier ? `(dossier ${target.dossier})` : ''}\n`);
      // -tt : pseudo-terminal forcé (stdin n'est pas un terminal ici) — les invites `read -rp`
      // s'affichent et reçoivent ce qui est tapé dans la page (voir input()).
      const ssh = spawn('ssh', [...sshOptions(), '-tt', dest, remoteCommand]);
      this.runs.set(runId, ssh);
      ssh.stdout.on('data', (d) => callbacks.onOutput(runId, d.toString()));
      ssh.stderr.on('data', (d) => callbacks.onOutput(runId, d.toString()));
      ssh.on('error', (err) => { this.runs.delete(runId); callbacks.onEnd(runId, null, `ssh introuvable : ${err.message}`); });
      ssh.on('close', (code) => {
        this.runs.delete(runId);
        this.logger.info('ExecRunner', `Exécution ${runId} terminée (code ${code})`);
        callbacks.onEnd(runId, code);
      });
    });
    return runId;
  }

  /** Texte tapé par l'utilisateur → script (suivi d'un retour à la ligne, comme Entrée). */
  input(runId: string, text: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.stdin.write(`${text}\n`);
    return true;
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.kill('SIGTERM');
    return true;
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.kill('SIGTERM');
    this.runs.clear();
  }
}

/** Écrit un contenu dans un fichier temporaire local (script substitué à copier). */
export function writeTempScript(content: string): string {
  const file = path.join(os.tmpdir(), `outils-exec-${crypto.randomBytes(8).toString('hex')}.sh`);
  fs.writeFileSync(file, content, { mode: 0o700 });
  return file;
}
