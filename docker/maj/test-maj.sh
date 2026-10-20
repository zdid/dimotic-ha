#!/usr/bin/env bash
# Essais de maj-dimotic.sh avec un faux `docker` et un faux `curl` (aucun vrai conteneur touché).
set -u
cd "$(dirname "$0")"
SCRIPT="$PWD/maj-dimotic.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/dir/logs" "$T/dir/data/core"
ARCH="$(case "$(uname -m)" in x86_64) echo amd64;; aarch64) echo arm64;; *) uname -m;; esac)"

# faux docker : enregistre les appels ; MAJ_FAUX_SANTE=healthy|unhealthy ; MAJ_FAUX_PULL=ok|ko
cat > "$T/bin/docker" <<DEOF
#!/bin/sh
echo "docker \$*" >> "$T/appels"
case "\$1" in
  pull) [ "\${MAJ_FAUX_PULL:-ok}" = ok ] && exit 0 || exit 1 ;;
  inspect) echo "\${MAJ_FAUX_SANTE:-healthy}" ;;
  compose) echo "compose-up tag=\$(grep '^DIMOTIC_TAG=' "$T/dir/.env" | cut -d= -f2)" >> "$T/appels" ;;
esac
DEOF
# faux curl : tags/<v> → images de l'architecture locale, sauf 9.9.9 (inexistante)
cat > "$T/bin/curl" <<DEOF
#!/bin/sh
for a in "\$@"; do u="\$a"; done
case "\$u" in
  */tags/9.9.9) exit 22 ;;
  */tags/*) echo '{"images":[{"architecture":"$ARCH"},{"architecture":"unknown"}]}' ;;
  *) echo '{"results":[{"name":"latest"},{"name":"3.9.5"},{"name":"3.10.0"},{"name":"3.9.12"},{"name":"4.0.0-rc1"}]}' ;;
esac
DEOF
chmod +x "$T/bin/docker" "$T/bin/curl"
export PATH="$T/bin:$PATH" MAJ_DIR="$T/dir" MAJ_SANS_MQTT=1 MAJ_SONDE_SEC=0 MAJ_HEALTH_TIMEOUT=2
echo "DIMOTIC_TAG=3.9.5" > "$T/dir/.env"; echo "services: {}" > "$T/dir/compose.yaml"

ok=0; ko=0
verifie() { if [ "$2" = "$3" ]; then ok=$((ok+1)); echo "  ok  $1"; else ko=$((ko+1)); echo "  ECHEC $1 : attendu « $3 », obtenu « $2 »"; fi; }
tag() { grep '^DIMOTIC_TAG=' "$T/dir/.env" | cut -d= -f2; }
raz() { : > "$T/appels"; rm -rf "$T/dir/.maj.lock" "$T/dir/.maj-precedent" "$T/dir/.maj-ids-vus"; echo "DIMOTIC_TAG=3.9.5" > "$T/dir/.env"; }

echo "== versions"
raz; verifie "dernière version du hub (hors latest et rc)" "$("$SCRIPT" etat | jq -r .derniere_hub)" "3.10.0"
"$SCRIPT" mettre-a-jour "latest; rm -rf /" --oui >/dev/null 2>&1; verifie "version invalide refusée (code 2)" "$?" "2"
"$SCRIPT" mettre-a-jour 9.9.9 --oui >/dev/null 2>&1; verifie "version absente du hub refusée (code 3)" "$?" "3"
verifie "  .env intact" "$(tag)" "3.9.5"
"$SCRIPT" mettre-a-jour 3.9.5 --oui >/dev/null 2>&1; verifie "même version : rien à faire" "$(grep -c pull "$T/appels")" "0"

echo "== aperçu"
raz; "$SCRIPT" mettre-a-jour 3.9.6 2>/dev/null | jq -e '.apercu == true and .vers == "3.9.6"' >/dev/null; verifie "aperçu sans --oui" "$?" "0"
verifie "  .env intact" "$(tag)" "3.9.5"; verifie "  aucun appel docker" "$(grep -c . "$T/appels")" "0"

echo "== mise à jour réussie"
raz; "$SCRIPT" mettre-a-jour 3.9.6 --oui >/dev/null 2>&1; verifie "code 0" "$?" "0"
verifie "  .env en 3.9.6" "$(tag)" "3.9.6"
verifie "  téléchargement AVANT le redémarrage" "$(grep -n 'pull\|compose-up' "$T/appels" | head -1 | grep -c pull)" "1"
verifie "  redémarrage avec le nouveau tag" "$(grep compose-up "$T/appels" | head -1)" "compose-up tag=3.9.6"
verifie "  version précédente retenue" "$(cat "$T/dir/.maj-precedent")" "3.9.5"
verifie "  verrou libéré" "$([ -d "$T/dir/.maj.lock" ] && echo non || echo oui)" "oui"
ls "$T/dir"/.env.bak-* >/dev/null 2>&1; verifie "  sauvegarde du .env" "$?" "0"

echo "== échec du téléchargement"
raz; MAJ_FAUX_PULL=ko "$SCRIPT" mettre-a-jour 3.9.6 --oui >/dev/null 2>&1; verifie "code 5" "$?" "5"
verifie "  .env intact" "$(tag)" "3.9.5"; verifie "  aucun redémarrage" "$(grep -c compose-up "$T/appels")" "0"

echo "== conteneur non sain : retour arrière"
raz; MAJ_FAUX_SANTE=unhealthy "$SCRIPT" mettre-a-jour 3.9.6 --oui >/dev/null 2>&1; verifie "code 6" "$?" "6"
verifie "  .env revenu en 3.9.5" "$(tag)" "3.9.5"
verifie "  deux redémarrages (bascule puis retour)" "$(grep -c compose-up "$T/appels")" "2"

echo "== verrou"
raz; mkdir "$T/dir/.maj.lock"; "$SCRIPT" mettre-a-jour 3.9.6 --oui >/dev/null 2>&1; verifie "mise à jour déjà en cours (code 4)" "$?" "4"
rmdir "$T/dir/.maj.lock"

echo "== revenir"
raz; "$SCRIPT" mettre-a-jour 3.9.6 --oui >/dev/null 2>&1; "$SCRIPT" revenir --oui >/dev/null 2>&1; verifie ".env revenu en 3.9.5" "$(tag)" "3.9.5"

export MAJ_MACHINE_ID=ha2_test
MAJ_SOURCE_ONLY=1 . "$SCRIPT"

echo "== verrou libéré après chaque mise à jour (l'agent d'écoute ne se termine jamais)"
raz; cmd_mettre_a_jour 3.9.6 --oui >/dev/null 2>&1; verifie "première mise à jour réussie" "$(tag)" "3.9.6"
verifie "  verrou libéré sans quitter le processus" "$([ -d "$T/dir/.maj.lock" ] && echo non || echo oui)" "oui"
cmd_mettre_a_jour 3.9.7 --oui >/dev/null 2>&1; verifie "deuxième mise à jour dans le même processus" "$(tag)" "3.9.7"
raz; MAJ_FAUX_PULL=ko cmd_mettre_a_jour 3.9.6 --oui >/dev/null 2>&1; verifie "  après un échec aussi, verrou libéré" "$([ -d "$T/dir/.maj.lock" ] && echo non || echo oui)" "oui"
raz; MAJ_FAUX_SANTE=unhealthy cmd_mettre_a_jour 3.9.6 --oui >/dev/null 2>&1; verifie "  après un retour arrière aussi" "$([ -d "$T/dir/.maj.lock" ] && echo non || echo oui)" "oui"

echo "== bouton Installer de HA"
raz; traiter_installation_ha >/dev/null 2>&1; verifie "installe la dernière version du hub (3.10.0)" "$(tag)" "3.10.0"
raz; echo "DIMOTIC_TAG=3.10.0" > "$T/dir/.env"; : > "$T/appels"; traiter_installation_ha >/dev/null 2>&1; verifie "déjà à jour : rien" "$(grep -c pull "$T/appels")" "0"
raz; echo "DIMOTIC_TAG=4.0.0" > "$T/dir/.env"; traiter_installation_ha >/dev/null 2>&1; verifie "installée plus récente que le hub : jamais de rétrogradation" "$(tag)" "4.0.0"
raz; MAJ_INSTALL_HA=0 traiter_installation_ha >/dev/null 2>&1; verifie "bouton HA désactivé : rien" "$(tag)" "3.9.5"

echo; echo "Résultat : $ok réussis, $ko échecs"; [ "$ko" = 0 ]
