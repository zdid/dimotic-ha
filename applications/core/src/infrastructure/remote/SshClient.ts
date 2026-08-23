/**
 * Primitives SSH/SCP partagées — extraites de `rpigpio`/`teleinfo`/`espdisplay`, qui avaient chacune
 * réimplémenté une version quasi identique de `runSsh`/`runScp`/`shellQuote`/`expandHome`
 * (constaté en lisant les trois `DeployService.ts` le 22/08/2026). Un seul module, pour que toute
 * application pilotant une machine distante en SSH n'ait plus à la réécrire.
 *
 * `RemoteOpResult` remplace les interfaces `DeployResult` dupliquées (même forme partout :
 * `{ success, step?, error?, output? }`) — `step` reste une chaîne libre, chaque appelant peut
 * définir son propre alias de type plus précis s'il veut restreindre les valeurs possibles.
 *
 * Toujours `root` (⭐ 23/08/2026) : les machines cibles pilotées par ce socle sont toujours jointes
 * en root direct, jamais un compte dédié avec `sudo NOPASSWD` — analysé et tranché avec
 * l'utilisateur : `sudo NOPASSWD` sur des commandes larges (`tee`, `docker`, `mkdir`, déjà le cas
 * partout ici) équivaut de toute façon à root (`sudo tee` sur un chemin arbitraire permet
 * d'écraser `/etc/sudoers`) — la distinction n'apportait qu'un vernis, pas une vraie réduction de
 * privilège. `RemoteTarget` n'a donc plus de champ `sshUser`.
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RemoteTarget {
  host: string;
  sshKeyPath?: string;
}

/**
 * Chemin par défaut de la clé SSH privée d'une cible — `data/<appId>/ssh/<targetId>/id_ed25519`,
 * jamais `~/.ssh/...` : le conteneur Docker tourne en `USER node` (home `/home/node`, jamais
 * persisté, aucun volume SSH monté, voir Dockerfile/compose.yaml) — seul `data/` survit et reste
 * identique en dev local et en Docker. Une clé PAR CIBLE (pas partagée par application) : révoquer
 * une cible compromise ne doit pas obliger à re-clef toutes les autres cibles de la même app.
 */
export function defaultSshKeyPath(appId: string, targetId: string): string {
  const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', appId, 'ssh', targetId);
  return path.join(dataDir, 'id_ed25519');
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
    args.push(`root@${target.host}`, remoteCommand);

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
    args.push(...localPaths, `root@${target.host}:${remoteDest}`);

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
