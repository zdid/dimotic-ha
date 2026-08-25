#!/usr/bin/env node
/**
 * Superviseur minimal, indépendant de Docker — relance l'application à chaque arrêt, sauf
 * demande d'arrêt explicite. Remplace la dépendance à `restart: unless-stopped` de Docker
 * (qui reste en place comme filet de sécurité si ce process lui-même plante) : utilisable
 * identiquement en conteneur ou en installation directe (systemd, service, cron @reboot...).
 *
 * Pourquoi ce script existe : constaté empiriquement le 07/08/2026 en testant le compte à
 * rebours de redémarrage (Gestion des applications) que `tsx watch` ne relance PAS le script
 * qu'il enveloppe quand celui-ci appelle process.exit() lui-même — seulement sur changement de
 * fichier. RestartManager.ts s'appuie entièrement sur un superviseur externe pour redémarrer
 * après un process.exit(0) ; sans lui (dev local hors Docker, ou installation bare-metal sans
 * systemd configuré), l'application reste morte.
 *
 * Code de sortie spécial : NO_RESTART_EXIT_CODE (75, voir RestartManager.ts — même valeur, à
 * garder synchronisée manuellement, TS/JS ne partagent pas ce module) — un enfant qui sort avec
 * ce code signale un arrêt volontaire définitif (pas un simple redémarrage) : pas de relance.
 * Tout autre code de sortie (y compris 0, utilisé aujourd'hui par RestartManager pour un
 * redémarrage normal après sauvegarde de config / activation-désactivation d'application)
 * déclenche une relance après un court délai.
 *
 * SIGTERM/SIGINT reçus par CE process (ex: `docker stop`, Ctrl+C, `systemctl stop`) sont
 * transmis à l'enfant puis traités comme un arrêt définitif — pas de relance non plus.
 *
 * Usage : node applications/core/scripts/supervisor.js
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const NO_RESTART_EXIT_CODE = 75;
const RESTART_DELAY_MS = 1000;

const CORE_DIR = path.resolve(__dirname, '..');
const DIST_ENTRY_POINT = path.join(CORE_DIR, 'dist', 'index.js');
const TSX_BIN = path.join(CORE_DIR, 'node_modules', '.bin', 'tsx');
const SRC_ENTRY_POINT = path.join(CORE_DIR, 'src', 'index.ts');

let child = null;
let stopping = false;

function log(message) {
  console.log(`[supervisor] ${new Date().toISOString()} ${message}`);
}

/** ⭐ 25/08/2026 : dist/index.js (compilé, `node` pur) EN PREMIER si présent — même ordre de
 *  priorité que ProcessSupervisor.ts::resolveEntryPoint() pour les apps métier. Repli sur
 *  tsx+src/index.ts uniquement si dist/ est absent (dev local hors `dev:local` qui n'appelle
 *  jamais ce script, ou installation bare-metal sans build préalable) — garde ce superviseur
 *  utilisable tel quel dans les deux cas, sans dépendre de tsx quand un build existe déjà. */
function resolveEntryPoint() {
  if (fs.existsSync(DIST_ENTRY_POINT)) {
    return { command: process.execPath, args: [DIST_ENTRY_POINT] };
  }
  return { command: TSX_BIN, args: [SRC_ENTRY_POINT] };
}

function start() {
  log("Démarrage de l'application...");
  const entry = resolveEntryPoint();
  log(`Point d'entrée : ${entry.command} ${entry.args.join(' ')}`);
  child = spawn(entry.command, entry.args, { stdio: 'inherit', cwd: CORE_DIR });

  child.on('exit', (code, signal) => {
    child = null;

    if (stopping) {
      log('Application arrêtée (arrêt du superviseur demandé) — pas de relance');
      process.exit(0);
    }

    if (code === NO_RESTART_EXIT_CODE) {
      log(`Application arrêtée volontairement (code de sortie ${NO_RESTART_EXIT_CODE}) — pas de relance`);
      process.exit(0);
    }

    log(`Application terminée (code: ${code}, signal: ${signal}) — relance dans ${RESTART_DELAY_MS}ms`);
    setTimeout(start, RESTART_DELAY_MS);
  });

  child.on('error', (error) => {
    log(`Échec du lancement de l'application: ${error.message}`);
  });
}

function handleStopSignal(signal) {
  log(`Signal ${signal} reçu — arrêt définitif, transmission à l'application`);
  stopping = true;
  if (child) {
    child.kill(signal);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => handleStopSignal('SIGTERM'));
process.on('SIGINT', () => handleStopSignal('SIGINT'));

start();
