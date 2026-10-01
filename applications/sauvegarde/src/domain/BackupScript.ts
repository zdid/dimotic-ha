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
    // ⭐ 01/10/2026, demande explicite (« un peu plus bavard au niveau de la log ») : tout ce qui est
    // écrit ici part dans cron.log (cron >> cron.log 2>&1), horodaté — étapes, tailles, durées, codes
    // HTTP et codes de sortie. Jamais le mot de passe (netrc, curl -sS n'affiche pas ses identifiants).
    "log() { printf '[%s] %s\\n' \"$(date -Iseconds)\" \"$*\"; }",
    'START_EPOCH=$(date +%s)',
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
    '  log "ÉCHEC : secret absent ($SECRET_FILE) — rien n\'est sauvegardé" >&2',
    '  exit 1',
    'fi',
    'NEXTCLOUD_PASSWORD=$(cat "$SECRET_FILE")',
    '',
    'NETRC_FILE=$(mktemp)',
    'chmod 600 "$NETRC_FILE"',
    'mkdir -p "$BACKUP_DIR"',
    'CURL_ERR="$BACKUP_DIR/.curl-err"',
    'trap \'rm -f "$NETRC_FILE" "${TMP_TAR:-}" "${TMP_MANIFEST:-}" "$CURL_ERR"\' EXIT',
    'printf \'default login %s password %s\\n\' "$NEXTCLOUD_USER" "$NEXTCLOUD_PASSWORD" > "$NETRC_FILE"',
    '',
    'BASE_URL="${NEXTCLOUD_SERVER_URL%/}/remote.php/dav/files/${NEXTCLOUD_USER}"',
    '',
    '# Crée une collection WebDAV si absente — 2xx (créée) et 405 (déjà là) sont tous les deux OK.',
    'mkcol_ignore() {',
    '  local code',
    '  code=$(curl -sS --netrc-file "$NETRC_FILE" -X MKCOL "$1" -o /dev/null -w \'%{http_code}\' 2>/dev/null)',
    '  if printf \'%s\' "$code" | grep -qE \'^(2|405|301)\'; then return 0; fi',
    '  log "ATTENTION : création du dossier distant $1 refusée (HTTP ${code:-aucun})"',
    '  return 1',
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
    'log "=== Début de la sauvegarde ${SITE}/${MACHINE} — jour ${TODAY} (jour de semaine ${DOW}, envoi hebdomadaire le ${WEEKLY_DOW}) — rétention ${RETENTION_DAYS} j / ${RETENTION_WEEKS} sem — destination ${BASE_URL}"',
    '',
    '# Pousse l\'archive+manifeste courants dans une cadence donnée, puis retire le fichier daté',
    '# $3 jours avant TODAY (rotation glissante déterministe, pas de scan du dossier distant).',
    'push_cadence() {',
    '  local name="$1" cadence="$2" retire_date="$3"',
    '  mkcol_ignore "$BASE_URL/$cadence/"',
    '  local archive_url="$BASE_URL/$cadence/${name}-${TODAY}.tar.gz"',
    '  local manifest_url="$BASE_URL/$cadence/${name}-${TODAY}.manifest.txt"',
    '  local code curl_exit size t0 mcode dcode',
    '  size=$(stat -c %s "$TMP_TAR" 2>/dev/null || echo "?")',
    '  t0=$(date +%s)',
    '  code=$(curl -sS --netrc-file "$NETRC_FILE" -T "$TMP_TAR" "$archive_url" -o /dev/null -w \'%{http_code}\' 2>"$CURL_ERR")',
    '  curl_exit=$?',
    '  if ! printf \'%s\' "$code" | grep -qE \'^2\'; then',
    '    log "ÉCHEC envoi ${name} (${cadence}) : HTTP ${code:-aucun}, code curl ${curl_exit}, ${size} octets en $(( $(date +%s) - t0 )) s — $(tr \'\\n\' \' \' < "$CURL_ERR" 2>/dev/null)"',
    '    return 1',
    '  fi',
    '  log "envoi ${name} (${cadence}) OK : HTTP ${code}, ${size} octets en $(( $(date +%s) - t0 )) s"',
    '  mcode=$(curl -sS --netrc-file "$NETRC_FILE" -T "$TMP_MANIFEST" "$manifest_url" -o /dev/null -w \'%{http_code}\' 2>/dev/null)',
    '  printf \'%s\' "$mcode" | grep -qE \'^2\' || log "ATTENTION : manifeste ${name} (${cadence}) non accepté (HTTP ${mcode:-aucun}) — la restauration ne verra pas la liste des éléments"',
    '',
    '  if [ -n "$retire_date" ]; then',
    '    dcode=$(curl -sS --netrc-file "$NETRC_FILE" -X DELETE "$BASE_URL/$cadence/${name}-${retire_date}.tar.gz" -o /dev/null -w \'%{http_code}\' 2>/dev/null)',
    '    curl -sS --netrc-file "$NETRC_FILE" -X DELETE "$BASE_URL/$cadence/${name}-${retire_date}.manifest.txt" -o /dev/null 2>/dev/null',
    '    log "purge ${name} (${cadence}) du ${retire_date} : HTTP ${dcode:-aucun} (204 = supprimée, 404 = déjà absente)"',
    '  fi',
    '  return 0',
    '}',
    '',
    'STATUS_JSON="{"',
    'FIRST_ENTRY=1',
    'add_status() {',
    '  local name="$1" success="$2" cadences="$3" tar_exit="${4:-}" tar_log="${5:-}" failed="${6:-}"',
    '  if [ "$FIRST_ENTRY" -eq 0 ]; then STATUS_JSON="$STATUS_JSON,"; fi',
    '  FIRST_ENTRY=0',
    '  STATUS_JSON="$STATUS_JSON',
    '  \\"$name\\": {\\"lastRun\\": \\"$(date -Iseconds)\\", \\"success\\": $success, \\"cadences\\": \\"$cadences\\", \\"cadencesEchec\\": \\"$failed\\", \\"tarExit\\": \\"$tar_exit\\", \\"tarLog\\": \\"$tar_log\\"}"',
    '}',
    // ⭐ 25/09/2026 (spec §5ter v1.6, supervision) — date de la dernière réussite par dossier et par
    // cadence : status.json ne décrit que la DERNIÈRE exécution (la date du dernier hebdomadaire s'y
    // perdait). Écrit seulement après un envoi accepté par Nextcloud (push_cadence vérifie le code HTTP).
    'mark_success() {',
    '  date -Iseconds > "$BACKUP_DIR/last-$1-$2"',
    '}',
    '',
    'OVERALL_FAIL=0',
    '',
    'for entry in "docker:/docker" "dimotic-ha-addons:/dimotic-ha-addons"; do',
    '  NAME="${entry%%:*}"',
    '  DIR="${entry#*:}"',
    '',
    '  if [ ! -d "$DIR" ]; then',
    '    log "dossier ${DIR} absent sur cette machine, ignoré"',
    '    continue',
    '  fi',
    '  log "--- ${NAME} (${DIR}) : archivage"',
    '  T_TAR=$(date +%s)',
    '',
    '  TMP_TAR=$(mktemp --suffix=.tar.gz)',
    '  TMP_MANIFEST=$(mktemp)',
    // ⭐ 23/09/2026, décision (point 14 de la conception de la restauration) : chaque ligne du
    // manifeste porte, après une tabulation, la taille DÉCOMPRESSÉE de l'élément en octets
    // (`du -sb`, mesurée juste avant l'archivage) — l'assistant de restauration la lit AVANT de
    // télécharger l'archive, pour l'afficher par case et vérifier l'espace libre sur la cible.
    // Premier champ inchangé (nom de l'élément), les manifestes plus anciens restent lisibles.
    '  find "$DIR" -mindepth 1 -maxdepth 1 -printf \'%f\\n\' | sort | while IFS= read -r ENTRY; do',
    '    printf \'%s\\t%s\\n\' "$ENTRY" "$(du -sb "$DIR/$ENTRY" 2>/dev/null | cut -f1)"',
    '  done > "$TMP_MANIFEST"',
    '',
    // ⭐ 23/09/2026, demande explicite (échec intermittent « archive » en test réel sur ha2, sans
    // aucune trace — stderr était jeté) : la sortie d'erreur de tar va dans un fichier daté sous
    // BACKUP_DIR (jamais sauvegardé), SUPPRIMÉ si tar sort en 0, CONSERVÉ sinon pour analyse a
    // posteriori. Code 1 de GNU tar = « des fichiers ont changé/disparu pendant la lecture »
    // (base HA, mosquitto, logs actifs) : archive quand même exploitable → on continue (le
    // fichier de log conservé dit lesquels). Seul un code ≥ 2 (erreur fatale) arrête ce parent.
    '  TAR_LOG="$BACKUP_DIR/tar-${NAME}-$(date +%Y-%m-%d_%H%M%S).log"',
    '  mkdir -p "$BACKUP_DIR"',
    '  tar -czf "$TMP_TAR" -C / "${DIR#/}" 2>"$TAR_LOG"',
    '  TAR_EXIT=$?',
    '  log "tar ${NAME} : code ${TAR_EXIT}, archive $(stat -c %s "$TMP_TAR" 2>/dev/null || echo "?") octets, $(wc -l < "$TMP_MANIFEST") éléments au manifeste, en $(( $(date +%s) - T_TAR )) s"',
    '  if [ "$TAR_EXIT" -eq 0 ]; then',
    '    rm -f "$TAR_LOG"',
    '    TAR_LOG=""',
    '  else',
    '    log "tar ${NAME} : messages (journal complet : ${TAR_LOG}) :"',
    '    head -n 8 "$TAR_LOG" | while IFS= read -r L; do log "    tar: $L"; done',
    '  fi',
    '  if [ "$TAR_EXIT" -ge 2 ]; then',
    '    log "ÉCHEC ${NAME} : erreur fatale de tar (code ${TAR_EXIT}), rien n\'est envoyé pour ce dossier"',
    '    add_status "$NAME" false "archive" "$TAR_EXIT" "$TAR_LOG"',
    '    OVERALL_FAIL=1',
    '    rm -f "$TMP_TAR" "$TMP_MANIFEST"',
    '    continue',
    '  fi',
    '',
    '  if ! tar -tzf "$TMP_TAR" >/dev/null 2>&1; then',
    '    log "ÉCHEC ${NAME} : l\'archive créée est illisible (contrôle d\'intégrité), rien n\'est envoyé"',
    '    add_status "$NAME" false "integrite" "$TAR_EXIT" "$TAR_LOG"',
    '    OVERALL_FAIL=1',
    '    rm -f "$TMP_TAR" "$TMP_MANIFEST"',
    '    continue',
    '  fi',
    '',
    '  CADENCES_DONE=""',
    '  CADENCES_FAILED=""',
    '  RETIRE_DAILY=$(date -d "-${RETENTION_DAYS} days" +%Y-%m-%d)',
    '  if push_cadence "$NAME" journalier "$RETIRE_DAILY"; then',
    '    CADENCES_DONE="journalier"',
    '    mark_success "$NAME" journalier',
    '  else',
    '    CADENCES_FAILED="journalier"',
    '    OVERALL_FAIL=1',
    '  fi',
    '',
    '  if [ "$DOW" = "$WEEKLY_DOW" ]; then',
    '    RETIRE_WEEKLY=$(date -d "-$((RETENTION_WEEKS * 7)) days" +%Y-%m-%d)',
    '    if push_cadence "$NAME" hebdomadaire "$RETIRE_WEEKLY"; then',
    '      [ -n "$CADENCES_DONE" ] && CADENCES_DONE="$CADENCES_DONE,"',
    '      CADENCES_DONE="${CADENCES_DONE}hebdomadaire"',
    '      mark_success "$NAME" hebdomadaire',
    '    else',
    '      [ -n "$CADENCES_FAILED" ] && CADENCES_FAILED="$CADENCES_FAILED,"',
    '      CADENCES_FAILED="${CADENCES_FAILED}hebdomadaire"',
    '      OVERALL_FAIL=1',
    '    fi',
    '  fi',
    '',
    '  SUCCESS=true',
    '  [ -z "$CADENCES_DONE" ] && SUCCESS=false',
    '  log "bilan ${NAME} : envoyé=[${CADENCES_DONE:-aucune}] échec=[${CADENCES_FAILED:-aucun}]"',
    '  add_status "$NAME" "$SUCCESS" "$CADENCES_DONE" "$TAR_EXIT" "$TAR_LOG" "$CADENCES_FAILED"',
    '',
    '  rm -f "$TMP_TAR" "$TMP_MANIFEST"',
    'done',
    '',
    'STATUS_JSON="$STATUS_JSON',
    '}"',
    'mkdir -p "$BACKUP_DIR"',
    'printf \'%s\\n\' "$STATUS_JSON" > "$STATUS_FILE"',
    '',
    'RESULTAT="SUCCÈS"',
    '[ "$OVERALL_FAIL" -ne 0 ] && RESULTAT="AVEC ÉCHEC"',
    'log "=== Fin de la sauvegarde : ${RESULTAT} en $(( $(date +%s) - START_EPOCH )) s"',
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
