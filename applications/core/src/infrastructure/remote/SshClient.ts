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

import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface RemoteTarget {
  host: string;
  sshKeyPath?: string;
}

/**
 * Chemin de la clé SSH privée — UNIQUE pour toute l'installation, partagée par toutes les
 * applications et toutes les cibles (⭐ 24/08/2026, revu sur demande explicite : le modèle
 * précédent, une clé par application ET par cible, n'était pas ce qui était voulu — la
 * granularité par cible ajoutait de la friction sans bénéfice retenu par l'utilisateur).
 * `data/core/ssh/id_ed25519`, jamais `~/.ssh/...` : le conteneur Docker tourne en `USER node`
 * (home `/home/node`, jamais persisté, aucun volume SSH monté, voir Dockerfile/compose.yaml) —
 * seul `data/` survit et reste identique en dev local et en Docker. Rangée sous `data/core/`
 * (pas un `data/ssh/` de premier niveau) parce que `core` est le seul module dont la présence est
 * garantie (jamais désactivable, CLAUDE.md §7) — les autres apps la génèrent si besoin au
 * démarrage mais ne la "possèdent" pas.
 */
export function globalSshKeyPath(): string {
  const dataDir = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'core', 'ssh');
  return path.join(dataDir, 'id_ed25519');
}

/**
 * Génère la clé unique (paire ed25519, sans phrase de passe) si le fichier n'existe pas encore —
 * appelée au démarrage de chaque application (⭐ 24/08/2026, demande explicite : l'utilisateur ne
 * doit plus avoir à lancer `ssh-keygen` lui-même). Idempotente : peu importe laquelle des 4
 * applications démarre en premier, les suivantes constatent juste que le fichier existe déjà.
 * `execFileSync` (pas `execSync` + interpolation de chaîne) — le chemin passe en argument de
 * tableau, jamais interprété par un shell.
 */
export function ensureGlobalSshKey(): string {
  const keyPath = globalSshKeyPath();
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q']);
  }
  return keyPath;
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

export interface RunSshStreamingOptions {
  stdin?: string;
  /** Appelé pour chaque ligne complète reçue (stdout ET stderr confondus — `docker compose pull`
   *  écrit sa progression sur l'un ou l'autre selon les versions). Une ligne partielle en fin de
   *  paquet est retenue jusqu'au prochain paquet ou à la clôture du process, jamais transmise
   *  tronquée. */
  onData?: (line: string) => void;
  /** Timeout réarmé à CHAQUE donnée reçue (stdout ou stderr) — plutôt qu'un timeout absolu unique,
   *  s'adapte naturellement à une cible lente (ex: RPi3 chargé vs RPi5) tant qu'elle progresse
   *  réellement ; ne tue la commande que si plus rien ne se passe pendant `idleTimeoutMs` (silence
   *  prolongé = probablement bloqué). Défaut 90s. */
  idleTimeoutMs?: number;
  /** Plafond absolu, garde-fou pour le cas pathologique d'un flux qui progresse indéfiniment très
   *  lentement sans jamais se terminer. Défaut 45 min. */
  maxTotalMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOTAL_MS = 2700000;

/**
 * Variante de `runSsh` pour une commande longue dont la progression doit être suivie en direct
 * (⭐ 24/08/2026, `docker compose pull` — vérifié empiriquement produire un flux de lignes de
 * progression fréquentes même en SSH non-tty, pas un buffer silencieux jusqu'à la fin). Timeout
 * adaptatif par inactivité (voir `RunSshStreamingOptions.idleTimeoutMs`) plutôt qu'un timeout
 * absolu unique — remplace le besoin d'un timeout fixe différent par type de matériel cible.
 */
export function runSshStreaming(
  target: RemoteTarget,
  remoteCommand: string,
  opts: RunSshStreamingOptions = {}
): Promise<{ success: boolean; output: string; error?: string }> {
  const { stdin, onData, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, maxTotalMs = DEFAULT_MAX_TOTAL_MS } = opts;

  return new Promise((resolve) => {
    const args = ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes'];
    if (target.sshKeyPath) args.push('-i', expandHome(target.sshKeyPath));
    args.push(`root@${target.host}`, remoteCommand);

    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let output = '';
    let pendingLine = '';
    let settled = false;

    const finish = (result: { success: boolean; output: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      resolve(result);
    };

    const flushPendingLine = () => {
      if (pendingLine) {
        onData?.(pendingLine);
        pendingLine = '';
      }
    };

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      resetIdleTimer();

      pendingLine += text;
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) onData?.(line);
    };

    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill();
        finish({ success: false, output, error: `Aucune activité depuis ${idleTimeoutMs}ms — probablement bloqué` });
      }, idleTimeoutMs);
    };
    resetIdleTimer();

    const maxTimer = setTimeout(() => {
      child.kill();
      finish({ success: false, output, error: `Dépassement du plafond de ${maxTotalMs}ms` });
    }, maxTotalMs);

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', (err) => {
      finish({ success: false, output, error: err.message });
    });

    child.on('close', (code) => {
      flushPendingLine();
      if (code === 0) {
        finish({ success: true, output });
      } else {
        finish({ success: false, output, error: `ssh a quitté avec le code ${code}` });
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
