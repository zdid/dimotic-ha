/**
 * Script hôte de sauvegarde (chantier A, §5/§5bis/§5ter de la spec) — généré ici puis poussé par
 * SSH sur chaque machine couverte, en même temps que le secret (voir ScriptPushService et le bouton
 * « Pousser » de Paramètres Techniques). Autonome une fois déployé : ne dépend plus de dimotic-ha
 * pour s'exécuter (tourne au niveau de l'hôte, via cron, marche même sur le RPi1 le plus contraint).
 *
 * ⭐ 18/09/2026, conception V1 minimale actée avec l'utilisateur : l'unité de sauvegarde est
 * `/docker/` et `/dimotic-ha-addons/` PRIS ENTIERS (plus de granularité par application — le script
 * ne s'occupe pas de ce qu'il y a dedans), un manifeste (liste des sous-répertoires trouvés) déposé
 * à côté de chaque archive, même radical de nom. Deux cadences, poussées sur un calendrier fixe (pas
 * de détection de changement pour cette V1) : "journalier" (tous les jours) et "hebdomadaire" (un
 * jour fixe par semaine), chacune en rotation glissante déterministe (retire le fichier daté à
 * J-RETENTION_DAYS / S-RETENTION_WEEKS à chaque poussée, jamais de scan du dossier distant).
 */

import { shellQuote } from '../../../core/dist/exports';

/** Chemin fixe du script sur la machine cible — 4e parent de convention, dédié à l'infrastructure
 *  de sauvegarde elle-même (script + statut), au même niveau que /docker, /dimotic-ha-addons et
 *  /dimotic-secrets, mais jamais sauvegardé (hors des deux arborescences couvertes). */
export const BACKUP_DIR = '/dimotic-backup';
export const BACKUP_SCRIPT_REMOTE_PATH = `${BACKUP_DIR}/nextcloud-backup.sh`;
export const BACKUP_STATUS_REMOTE_PATH = `${BACKUP_DIR}/status.json`;
export const BACKUP_CRON_LOG_REMOTE_PATH = `${BACKUP_DIR}/cron.log`;

/** ⭐ 18/09/2026, décisions explicites : 10 jours + 10 semaines de rétention glissante, cron
 *  quotidien à 3h05 (fenêtre nocturne, décalé de 3h00 pour ne pas croiser des automatisations
 *  d'extinction de lumières existantes), poussée hebdomadaire le dimanche. */
export const BACKUP_RETENTION_DAYS = 10;
export const BACKUP_RETENTION_WEEKS = 10;
export const BACKUP_CRON_HOUR = 3;
export const BACKUP_CRON_MINUTE = 5;
/** `date +%u` : 1=lundi … 7=dimanche. */
export const BACKUP_WEEKLY_DOW = 7;

export interface BackupScriptParams {
  site: string;
  machine: string;
  serverUrl: string;
  user: string;
  rootPath: string;
  secretFilePath: string;
}

/** Remplace un jeton `__NOM__` par une valeur déjà mise en sécurité pour un littéral shell — le
 *  jeton lui-même ne contient jamais de `$`, donc aucun risque de collision avec la syntaxe bash du
 *  reste du script (contrairement à une interpolation `${...}` directe). */
function substitute(template: string, token: string, rawValue: string): string {
  return template.split(`__${token}__`).join(shellQuote(rawValue));
}

/**
 * Génère le contenu du script — écrit comme un tableau de lignes plutôt qu'un template literal
 * unique : le corps est plein de `${VAR}` bash, qui entreraient sans ça en collision avec la
 * syntaxe d'interpolation `${...}` de JavaScript à chaque occurrence.
 */
export function renderBackupScript(params: BackupScriptParams): string {
  const lines: string[] = [
    '#!/bin/bash',
    '# Généré par dimotic-ha (applications/sauvegarde) — voir specs/current/fonctionnelles-sauvegarde_specs.',
    '# Ne pas éditer à la main : re-pousser depuis Paramètres Techniques > Sauvegarde/Restauration > Pousser.',
    "# Pour tester sans attendre plusieurs jours réels, surcharger via l'environnement, ex. :",
    '#   WEEKLY_DOW=$(date +%u) /dimotic-backup/nextcloud-backup.sh   (force la poussée hebdo aujourd\'hui)',
    '#   RETENTION_DAYS=2 RETENTION_WEEKS=2 /dimotic-backup/nextcloud-backup.sh   (rotation plus rapide à observer)',
    '#   TODAY=2026-01-15 DOW=4 /dimotic-backup/nextcloud-backup.sh   (rejoue une date passée, ex. pour vérifier une purge)',
    'set -uo pipefail',
    '',
    'SITE=__SITE__',
    'MACHINE=__MACHINE__',
    'NEXTCLOUD_SERVER_URL=__SERVER_URL__',
    'NEXTCLOUD_USER=__NEXTCLOUD_USER__',
    'ROOT_PATH=__ROOT_PATH__',
    'SECRET_FILE=__SECRET_FILE__',
    `BACKUP_DIR=${shellQuote(BACKUP_DIR)}`,
    `STATUS_FILE=${shellQuote(BACKUP_STATUS_REMOTE_PATH)}`,
    // ⭐ 18/09/2026, demande explicite ("comment ce script peut être testé... des fréquences
    // différentes ?") — ": ${VAR:=defaut}" n'affecte VAR que si absente de l'environnement au
    // lancement : le comportement normal (cron) est inchangé, mais un appel manuel par SSH peut
    // surcharger la cadence/rétention sans re-générer le script, pour observer la rotation sans
    // attendre 10 jours/semaines réels.
    `: "\${RETENTION_DAYS:=${BACKUP_RETENTION_DAYS}}"`,
    `: "\${RETENTION_WEEKS:=${BACKUP_RETENTION_WEEKS}}"`,
    `: "\${WEEKLY_DOW:=${BACKUP_WEEKLY_DOW}}"`,
    '',
    'if [ ! -f "$SECRET_FILE" ]; then',
    '  echo "Secret absent: $SECRET_FILE" >&2',
    '  exit 1',
    'fi',
    'NEXTCLOUD_PASSWORD=$(cat "$SECRET_FILE")',
    '',
    'NETRC_FILE=$(mktemp)',
    'chmod 600 "$NETRC_FILE"',
    'trap \'rm -f "$NETRC_FILE" "${TMP_TAR:-}" "${TMP_MANIFEST:-}"\' EXIT',
    'printf \'default login %s password %s\\n\' "$NEXTCLOUD_USER" "$NEXTCLOUD_PASSWORD" > "$NETRC_FILE"',
    '',
    'BASE_URL="${NEXTCLOUD_SERVER_URL%/}/remote.php/dav/files/${NEXTCLOUD_USER}"',
    '',
    '# Crée une collection WebDAV si absente — 2xx (créée) et 405 (déjà là) sont tous les deux OK.',
    'mkcol_ignore() {',
    '  local code',
    '  code=$(curl -sS --netrc-file "$NETRC_FILE" -X MKCOL "$1" -o /dev/null -w \'%{http_code}\' 2>/dev/null)',
    '  printf \'%s\' "$code" | grep -qE \'^(2|405|301)\'',
    '}',
    '',
    'if [ -n "$ROOT_PATH" ]; then',
    '  BASE_URL="$BASE_URL/$ROOT_PATH"',
    '  mkcol_ignore "$BASE_URL/"',
    'fi',
    'BASE_URL="$BASE_URL/$SITE"',
    'mkcol_ignore "$BASE_URL/"',
    'BASE_URL="$BASE_URL/$MACHINE"',
    'mkcol_ignore "$BASE_URL/"',
    '',
    ': "${TODAY:=$(date +%Y-%m-%d)}"',
    ': "${DOW:=$(date +%u)}"',
    '',
    '# Pousse l\'archive+manifeste courants dans une cadence donnée, puis retire le fichier daté',
    '# $3 jours avant TODAY (rotation glissante déterministe, pas de scan du dossier distant).',
    'push_cadence() {',
    '  local name="$1" cadence="$2" retire_date="$3"',
    '  mkcol_ignore "$BASE_URL/$cadence/"',
    '  local archive_url="$BASE_URL/$cadence/${name}-${TODAY}.tar.gz"',
    '  local manifest_url="$BASE_URL/$cadence/${name}-${TODAY}.manifest.txt"',
    '  local code',
    '  code=$(curl -sS --netrc-file "$NETRC_FILE" -T "$TMP_TAR" "$archive_url" -o /dev/null -w \'%{http_code}\' 2>/dev/null)',
    '  if ! printf \'%s\' "$code" | grep -qE \'^2\'; then',
    '    return 1',
    '  fi',
    '  curl -sS --netrc-file "$NETRC_FILE" -T "$TMP_MANIFEST" "$manifest_url" -o /dev/null 2>/dev/null',
    '',
    '  if [ -n "$retire_date" ]; then',
    '    curl -sS --netrc-file "$NETRC_FILE" -X DELETE "$BASE_URL/$cadence/${name}-${retire_date}.tar.gz" -o /dev/null 2>/dev/null',
    '    curl -sS --netrc-file "$NETRC_FILE" -X DELETE "$BASE_URL/$cadence/${name}-${retire_date}.manifest.txt" -o /dev/null 2>/dev/null',
    '  fi',
    '  return 0',
    '}',
    '',
    'STATUS_JSON="{"',
    'FIRST_ENTRY=1',
    'add_status() {',
    '  local name="$1" success="$2" cadences="$3"',
    '  if [ "$FIRST_ENTRY" -eq 0 ]; then STATUS_JSON="$STATUS_JSON,"; fi',
    '  FIRST_ENTRY=0',
    '  STATUS_JSON="$STATUS_JSON',
    '  \\"$name\\": {\\"lastRun\\": \\"$(date -Iseconds)\\", \\"success\\": $success, \\"cadences\\": \\"$cadences\\"}"',
    '}',
    '',
    'OVERALL_FAIL=0',
    '',
    'for entry in "docker:/docker" "dimotic-ha-addons:/dimotic-ha-addons"; do',
    '  NAME="${entry%%:*}"',
    '  DIR="${entry#*:}"',
    '',
    '  if [ ! -d "$DIR" ]; then',
    '    continue',
    '  fi',
    '',
    '  TMP_TAR=$(mktemp --suffix=.tar.gz)',
    '  TMP_MANIFEST=$(mktemp)',
    '  find "$DIR" -mindepth 1 -maxdepth 1 -printf \'%f\\n\' | sort > "$TMP_MANIFEST"',
    '',
    '  if ! tar -czf "$TMP_TAR" -C / "${DIR#/}" 2>/dev/null; then',
    '    add_status "$NAME" false "archive"',
    '    OVERALL_FAIL=1',
    '    rm -f "$TMP_TAR" "$TMP_MANIFEST"',
    '    continue',
    '  fi',
    '',
    '  if ! tar -tzf "$TMP_TAR" >/dev/null 2>&1; then',
    '    add_status "$NAME" false "integrite"',
    '    OVERALL_FAIL=1',
    '    rm -f "$TMP_TAR" "$TMP_MANIFEST"',
    '    continue',
    '  fi',
    '',
    '  CADENCES_DONE=""',
    '  RETIRE_DAILY=$(date -d "-${RETENTION_DAYS} days" +%Y-%m-%d)',
    '  if push_cadence "$NAME" journalier "$RETIRE_DAILY"; then',
    '    CADENCES_DONE="journalier"',
    '  else',
    '    OVERALL_FAIL=1',
    '  fi',
    '',
    '  if [ "$DOW" = "$WEEKLY_DOW" ]; then',
    '    RETIRE_WEEKLY=$(date -d "-$((RETENTION_WEEKS * 7)) days" +%Y-%m-%d)',
    '    if push_cadence "$NAME" hebdomadaire "$RETIRE_WEEKLY"; then',
    '      [ -n "$CADENCES_DONE" ] && CADENCES_DONE="$CADENCES_DONE,"',
    '      CADENCES_DONE="${CADENCES_DONE}hebdomadaire"',
    '    else',
    '      OVERALL_FAIL=1',
    '    fi',
    '  fi',
    '',
    '  SUCCESS=true',
    '  [ -z "$CADENCES_DONE" ] && SUCCESS=false',
    '  add_status "$NAME" "$SUCCESS" "$CADENCES_DONE"',
    '',
    '  rm -f "$TMP_TAR" "$TMP_MANIFEST"',
    'done',
    '',
    'STATUS_JSON="$STATUS_JSON',
    '}"',
    'mkdir -p "$BACKUP_DIR"',
    'printf \'%s\\n\' "$STATUS_JSON" > "$STATUS_FILE"',
    '',
    'exit $OVERALL_FAIL'
  ];

  let script = lines.join('\n') + '\n';
  script = substitute(script, 'SITE', params.site);
  script = substitute(script, 'MACHINE', params.machine);
  script = substitute(script, 'SERVER_URL', params.serverUrl);
  script = substitute(script, 'NEXTCLOUD_USER', params.user);
  script = substitute(script, 'ROOT_PATH', params.rootPath);
  script = substitute(script, 'SECRET_FILE', params.secretFilePath);
  return script;
}
