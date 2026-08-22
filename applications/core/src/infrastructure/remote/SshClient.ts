/**
 * Primitives SSH/SCP partagées — extraites de `rpigpio`/`teleinfo`/`espdisplay`, qui avaient chacune
 * réimplémenté une version quasi identique de `runSsh`/`runScp`/`shellQuote`/`expandHome`
 * (constaté en lisant les trois `DeployService.ts` le 22/08/2026). Un seul module, pour que toute
 * application pilotant une machine distante en SSH n'ait plus à la réécrire.
 *
 * `RemoteOpResult` remplace les interfaces `DeployResult` dupliquées (même forme partout :
 * `{ success, step?, error?, output? }`) — `step` reste une chaîne libre, chaque appelant peut
 * définir son propre alias de type plus précis s'il veut restreindre les valeurs possibles.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';

export interface RemoteTarget {
  host: string;
  sshUser: string;
  sshKeyPath?: string;
}

export interface RemoteOpResult {
  success: boolean;
  step?: string;
  error?: string;
  output?: string;
}

const DEFAULT_TIMEOUT_MS = 30000;

export function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}

/** Échappement simple pour un argument shell distant (chemins/noms, pas de saisie libre). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Exécute une commande distante via SSH, avec un contenu optionnel envoyé sur stdin. */
export function runSsh(
  target: RemoteTarget,
  remoteCommand: string,
  stdin?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const args = ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes'];
    if (target.sshKeyPath) args.push('-i', expandHome(target.sshKeyPath));
    args.push(`${target.sshUser}@${target.host}`, remoteCommand);

    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, output: stdout, error: `Timeout après ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: stdout, error: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr || `ssh a quitté avec le code ${code}` });
      }
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/** Copie un ou plusieurs fichiers/répertoires vers la machine cible (scp -r). */
export function runScp(
  target: RemoteTarget,
  localPaths: string[],
  remoteDest: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const args = ['-r', '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes'];
    if (target.sshKeyPath) args.push('-i', expandHome(target.sshKeyPath));
    args.push(...localPaths, `${target.sshUser}@${target.host}:${remoteDest}`);

    const child = spawn('scp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); resolve({ success: false, error: `Timeout après ${timeoutMs}ms` }); }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ success: false, error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: stderr || `scp a quitté avec le code ${code}` });
    });
  });
}
