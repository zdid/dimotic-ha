/**
 * Script de restauration (⭐ 23/09/2026, conception validée le même jour — voir TODO.md
 * « DÉCISION restauration ») — généré ici, déposé par SSH sur la machine de destination
 * (`/dimotic-backup/restore.sh`) et lancé DÉTACHÉ (`setsid nohup`) : il survit à la coupure SSH et
 * au redémarrage de dimotic-ha (cas où la destination est la machine qui pilote). Deux appels :
 *
 * - `restore.sh phase1 <log>` : prérequis (curl/tar par apt, Docker par get.docker.com — même
 *   méthode que prepare-sd-card.sh), relocalisation éventuelle de dimotic-ha dans /docker-temp,
 *   téléchargement + contrôle d'intégrité + contrôle de place, extraction des seuls éléments
 *   choisis, puis pour chacun : arrêt, déplacement de l'existant dans /<parent>-backup-<horodatage>/,
 *   mise en place de la version restaurée. AUCUN redémarrage.
 * - `restore.sh phase2 <log>` : après validation humaine, démarrage des éléments restaurés,
 *   dimotic-ha en dernier.
 *
 * Avancement dans `restore-status.json` (relu par dimotic-ha toutes les 3 s), journal complet dans
 * `<log>` (conservé). Identifiants Nextcloud : fichier netrc temporaire déposé par dimotic-ha juste
 * avant le lancement, supprimé par ce script à sa sortie quoi qu'il arrive.
 */

import { shellQuote } from '../../../core/dist/exports';
import { BACKUP_DIR } from './BackupScript';

export const RESTORE_SCRIPT_REMOTE_PATH = `${BACKUP_DIR}/restore.sh`;
export const RESTORE_STATUS_REMOTE_PATH = `${BACKUP_DIR}/restore-status.json`;
export const RESTORE_NETRC_REMOTE_PATH = `${BACKUP_DIR}/restore.netrc`;

export interface RestoreScriptParams {
  serverUrl: string;
  user: string;
  rootPath: string;
  site: string;
  machine: string;
  cadence: string;
  parent: string;
  date: string;
  items: string[];
  archiveSize: number;
  /** Somme des tailles décompressées des éléments choisis, 0 si inconnue (lue dans l'archive). */
  neededBytes: number;
  /** Horodatage du répertoire de sauvegarde de l'existant (`AAAA-MM-JJ_HHMMSS`). */
  timestamp: string;
  /** Destination = machine qui pilote ET dimotic-ha coché : relocalisation dans /docker-temp. */
  selfRelocate: boolean;
}

export function renderRestoreScript(p: RestoreScriptParams): string {
  const lines: string[] = [
    '#!/bin/bash',
    '# Généré par dimotic-ha (applications/sauvegarde, assistant de restauration) — ne pas éditer.',
    '# Usage : restore.sh phase1|phase2 <fichier journal>',
    'set -uo pipefail',
    '',
    'PHASE="${1:-phase1}"',
    'LOG_FILE="${2:-}"',
    `SITE=${shellQuote(p.site)}`,
    `MACHINE=${shellQuote(p.machine)}`,
    `CADENCE=${shellQuote(p.cadence)}`,
    `PARENT=${shellQuote(p.parent)}`,
    `DATE=${shellQuote(p.date)}`,
    `NEXTCLOUD_SERVER_URL=${shellQuote(p.serverUrl)}`,
    `NEXTCLOUD_USER=${shellQuote(p.user)}`,
    `ROOT_PATH=${shellQuote(p.rootPath)}`,
    `ITEMS=(${p.items.map(shellQuote).join(' ')})`,
    `ARCHIVE_SIZE=${Math.max(0, Math.floor(p.archiveSize))}`,
    `NEEDED_BYTES=${Math.max(0, Math.floor(p.neededBytes))}`,
    `SELF_RELOCATE=${p.selfRelocate ? 1 : 0}`,
    `BACKUP_DIR=${shellQuote(BACKUP_DIR)}`,
    `STATUS_FILE=${shellQuote(RESTORE_STATUS_REMOTE_PATH)}`,
    `NETRC=${shellQuote(RESTORE_NETRC_REMOTE_PATH)}`,
    'WORK="$BACKUP_DIR/restore-work"',
    'TARGET_ROOT="/$PARENT"',
    `BACKUP_ROOT="/\${PARENT}-backup-${p.timestamp}"`,
    '',
    '# Le secret ne sert qu\'à la phase 1 — supprimé à la sortie, succès ou échec ; le répertoire de',
    '# travail (archive + extraction) aussi, le journal reste.',
    'trap \'rm -f "$NETRC"; rm -rf "$WORK"\' EXIT',
    '',
    'declare -A ITEM_STATE',
    'CURRENT_STEP=debut',
    '',
    'json_str() { printf \'%s\' "$1" | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g\' | tr \'\\n\\r\\t\' \'   \'; }',
    '',
    '# Réécrit l\'état complet (écriture atomique : fichier temporaire puis mv).',
    'write_status() {',
    // Variable de boucle LOCALE (st_it) : `it` est celle des boucles de phase1/phase2, qui appellent
    // step() → write_status() — bug vu au test : elle était écrasée par le dernier élément.
    '  local state="$1" message="$2" items="" sep="" st_it',
    '  for st_it in "${ITEMS[@]}"; do',
    '    items+="$sep\\"$(json_str "$st_it")\\": \\"$(json_str "${ITEM_STATE[$st_it]:-en attente}")\\""',
    '    sep=", "',
    '  done',
    '  mkdir -p "$BACKUP_DIR"',
    '  printf \'{"phase": "%s", "state": "%s", "step": "%s", "message": "%s", "updatedAt": "%s", "source": "%s", "backupRoot": "%s", "log": "%s", "selfRelocate": %s, "items": {%s}}\\n\' \\',
    '    "$PHASE" "$state" "$CURRENT_STEP" "$(json_str "$message")" "$(date -Iseconds)" \\',
    '    "$(json_str "$SITE/$MACHINE/$CADENCE/$PARENT-$DATE")" "$BACKUP_ROOT" "$(json_str "$LOG_FILE")" \\',
    '    "$([ "$SELF_RELOCATE" = 1 ] && echo true || echo false)" "$items" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"',
    '}',
    '',
    'step() { CURRENT_STEP="$1"; echo "== [$1] $2"; write_status running "$2"; }',
    'fail() { echo "ÉCHEC [$CURRENT_STEP] : $1"; write_status failed "$1"; exit 1; }',
    '',
    'has_compose() {',
    '  local d="$1"',
    '  [ -f "$d/compose.yaml" ] || [ -f "$d/compose.yml" ] || [ -f "$d/docker-compose.yaml" ] || [ -f "$d/docker-compose.yml" ]',
    '}',
    '',
    'phase1() {',
    '  step prerequis "Vérification des prérequis"',
    '  local missing=()',
    '  command -v curl >/dev/null 2>&1 || missing+=(curl)',
    '  command -v tar >/dev/null 2>&1 || missing+=(tar)',
    '  if [ ${#missing[@]} -gt 0 ]; then',
    '    step prerequis "Installation par apt : ${missing[*]}"',
    '    DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${missing[@]}" \\',
    '      || fail "Installation de ${missing[*]} impossible"',
    '  fi',
    '  if [ "$PARENT" = docker ]; then',
    '    if ! command -v docker >/dev/null 2>&1; then',
    '      step docker "Installation de Docker (get.docker.com, plusieurs minutes)"',
    '      curl -fsSL https://get.docker.com | sh || fail "Installation de Docker impossible"',
    '    fi',
    '    docker compose version >/dev/null 2>&1 || fail "docker compose indisponible"',
    '  fi',
    '',
    '  # Point 10 : la destination est la machine qui pilote — son dimotic-ha tourne depuis',
    '  # /docker-temp pendant toute la restauration, /docker/dimotic-ha reste libre pour la version restaurée.',
    '  if [ "$SELF_RELOCATE" = 1 ] && [ -d /docker/dimotic-ha ]; then',
    '    step relocalisation "dimotic-ha déplacé dans /docker-temp et relancé depuis là"',
    '    (cd /docker/dimotic-ha && docker compose stop) || fail "Arrêt de dimotic-ha impossible"',
    '    mkdir -p /docker-temp',
    '    [ ! -e /docker-temp/dimotic-ha ] || fail "/docker-temp/dimotic-ha existe déjà (restauration précédente inachevée ?)"',
    '    mv /docker/dimotic-ha /docker-temp/dimotic-ha || fail "Déplacement de dimotic-ha impossible"',
    '    (cd /docker-temp/dimotic-ha && docker compose up -d) || fail "Relance de dimotic-ha depuis /docker-temp impossible"',
    '    for _ in $(seq 1 60); do',
    '      [ "$(docker inspect -f \'{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}\' dimotic-ha 2>/dev/null)" = healthy ] && break',
    '      sleep 2',
    '    done',
    '  fi',
    '',
    '  rm -rf "$WORK"',
    '  mkdir -p "$WORK/extract"',
    '  local free',
    '  free=$(df -B1 --output=avail "$WORK" | tail -1 | tr -d \' \')',
    '  [ "$free" -ge $((ARCHIVE_SIZE + NEEDED_BYTES)) ] || fail "Espace insuffisant : $free octets libres, besoin de $((ARCHIVE_SIZE + NEEDED_BYTES))"',
    '',
    '  local url="${NEXTCLOUD_SERVER_URL%/}/remote.php/dav/files/${NEXTCLOUD_USER}"',
    '  [ -n "$ROOT_PATH" ] && url="$url/$ROOT_PATH"',
    '  url="$url/$SITE/$MACHINE/$CADENCE/$PARENT-$DATE.tar.gz"',
    '  step telechargement "Téléchargement de l\'archive ($ARCHIVE_SIZE octets)"',
    '  curl -fsS --netrc-file "$NETRC" -o "$WORK/archive.tar.gz" "$url" || fail "Téléchargement impossible : $url"',
    '  rm -f "$NETRC"',
    '',
    '  step integrite "Contrôle d\'intégrité de l\'archive"',
    '  tar -tzf "$WORK/archive.tar.gz" > "$WORK/list.txt" 2>>"${LOG_FILE:-/dev/null}" || fail "Archive illisible ou tronquée"',
    '  local members=()',
    '  for it in "${ITEMS[@]}"; do',
    '    grep -qE "^$PARENT/$(printf \'%s\' "$it" | sed \'s/[.[\\*^$()+?{|]/\\\\&/g\')(/|$)" "$WORK/list.txt" || fail "$it absent de l\'archive"',
    '    members+=("$PARENT/$it")',
    '  done',
    '',
    '  # Tailles inconnues (manifeste antérieur au 23/09/2026) : majorant = taille décompressée totale de l\'archive.',
    '  if [ "$NEEDED_BYTES" -eq 0 ]; then',
    '    local total',
    '    total=$(tar -tvzf "$WORK/archive.tar.gz" | awk \'{s+=$3} END {printf "%d", s}\')',
    '    free=$(df -B1 --output=avail "$WORK" | tail -1 | tr -d \' \')',
    '    [ "$free" -ge "$total" ] || fail "Espace insuffisant pour extraire : $free octets libres, archive décompressée $total"',
    '  fi',
    '',
    '  step extraction "Extraction des éléments choisis"',
    '  tar -xzf "$WORK/archive.tar.gz" -C "$WORK/extract" "${members[@]}" || fail "Extraction impossible"',
    '  rm -f "$WORK/archive.tar.gz"',
    '',
    '  mkdir -p "$BACKUP_ROOT" "$TARGET_ROOT"',
    '  for it in "${ITEMS[@]}"; do',
    '    local dest="$TARGET_ROOT/$it"',
    '    step remplacement "$it : arrêt et remplacement"',
    '    if [ -e "$dest" ]; then',
    '      if [ "$PARENT" = docker ] && has_compose "$dest"; then',
    '        (cd "$dest" && docker compose stop) || fail "Arrêt de $it impossible"',
    '      elif [ "$PARENT" = dimotic-ha-addons ] && [ -f "$dest/$it.service" ]; then',
    '        systemctl stop "$it" 2>/dev/null || true',
    '      fi',
    '      ITEM_STATE[$it]="arrêté"',
    '      mv "$dest" "$BACKUP_ROOT/$it" || fail "Déplacement de l\'existant $it impossible"',
    '      ITEM_STATE[$it]="existant dans $BACKUP_ROOT"',
    '    fi',
    '    mv "$WORK/extract/$PARENT/$it" "$dest" || fail "Mise en place de $it impossible"',
    '    ITEM_STATE[$it]="restauré, non démarré"',
    '  done',
    '',
    '  CURRENT_STEP=fin',
    '  write_status phase1-done "Étape 1 terminée — rien n\'a été redémarré. Vérifier la machine avant l\'étape 2."',
    '}',
    '',
    'start_item() {',
    '  local it="$1" dest="$TARGET_ROOT/$1"',
    '  if [ "$PARENT" = docker ]; then',
    '    if has_compose "$dest"; then',
    '      if (cd "$dest" && docker compose up -d); then ITEM_STATE[$it]="démarré"; else ITEM_STATE[$it]="ÉCHEC du démarrage"; START_FAIL=1; fi',
    '    else',
    '      ITEM_STATE[$it]="pas de compose : rien à démarrer"',
    '    fi',
    '  else',
    '    # Convention §6ter : <nom>.service / <nom>.cron à la racine du répertoire de déploiement.',
    '    if [ -f "$dest/$it.service" ]; then',
    '      ln -sf "$dest/$it.service" "/etc/systemd/system/$it.service" && systemctl daemon-reload \\',
    '        && systemctl enable --now "$it" && ITEM_STATE[$it]="démarré (systemd)" || { ITEM_STATE[$it]="ÉCHEC systemd"; START_FAIL=1; }',
    '    elif [ -f "$dest/$it.cron" ]; then',
    '      ln -sf "$dest/$it.cron" "/etc/cron.d/$it" && ITEM_STATE[$it]="cron installé" || { ITEM_STATE[$it]="ÉCHEC cron"; START_FAIL=1; }',
    '    else',
    '      ITEM_STATE[$it]="ni .service ni .cron : rien à démarrer"',
    '    fi',
    '  fi',
    '}',
    '',
    'phase2() {',
    '  START_FAIL=0',
    '  for it in "${ITEMS[@]}"; do ITEM_STATE[$it]="restauré, non démarré"; done',
    '  local with_dimotic=0',
    '  for it in "${ITEMS[@]}"; do',
    '    if [ "$PARENT" = docker ] && [ "$it" = dimotic-ha ]; then with_dimotic=1; continue; fi',
    '    step demarrage "Démarrage de $it"',
    '    start_item "$it"',
    '  done',
    '  # dimotic-ha EN DERNIER : si c\'est lui qui pilote, l\'interface se coupe ici et revient sur la version restaurée.',
    '  if [ "$with_dimotic" = 1 ]; then',
    '    step demarrage "Démarrage de dimotic-ha (en dernier)"',
    '    if [ "$SELF_RELOCATE" = 1 ] && [ -d /docker-temp/dimotic-ha ]; then',
    '      (cd /docker-temp/dimotic-ha && docker compose down) || true',
    '      mkdir -p "$BACKUP_ROOT"',
    '      mv /docker-temp/dimotic-ha "$BACKUP_ROOT/dimotic-ha" && rmdir /docker-temp 2>/dev/null',
    '    fi',
    '    start_item dimotic-ha',
    '  fi',
    '  CURRENT_STEP=fin',
    '  if [ "$START_FAIL" = 1 ]; then',
    '    write_status failed "Étape 2 terminée avec des échecs de démarrage — voir le journal."',
    '  else',
    '    write_status done "Restauration terminée."',
    '  fi',
    '}',
    '',
    'case "$PHASE" in',
    '  phase1) phase1 ;;',
    '  phase2) phase2 ;;',
    '  *) echo "Phase inconnue : $PHASE"; exit 2 ;;',
    'esac'
  ];
  return lines.join('\n') + '\n';
}
