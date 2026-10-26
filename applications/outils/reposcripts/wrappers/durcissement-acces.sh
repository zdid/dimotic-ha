#!/bin/bash
# Généré par l'application Outils — DURCIT l'accès d'une machine DÉJÀ installée (sudo requis), À PASSER APRÈS L'INSTALLATION
# (⭐ 26/10/2026, demande utilisateur) : la carte préparée par Outils laisse root se connecter par mot de passe pour faciliter
# l'installation ; ce script le SUPPRIME.
#   - SSH : mot de passe refusé pour tous les comptes SAUF l'utilisateur choisi ; clés toujours acceptées ;
#   - root : par clé SEULEMENT (PermitRootLogin prohibit-password) — le mot de passe de root n'est pas modifié (console) ;
#   - fail2ban : 5 essais en 10 minutes puis 12 heures de blocage, jamais pour les adresses indiquées (réseau local par défaut).
# Avant toute modification : sauvegarde de /etc/ssh, /etc/fail2ban et /etc/shadow dans /root/durcissement-acces-<date>/ ;
# configuration contrôlée par sshd -t / sshd -T AVANT rechargement, remise en place automatique si un contrôle échoue.
# Les sessions SSH ouvertes ne sont pas coupées (rechargement, pas redémarrage). Gardez-en une ouverte pendant l'essai.
#
# @outils:default UTILISATEUR = didier
# @outils:hint UTILISATEUR = Compte qui garde la connexion SSH par mot de passe (il doit déjà exister et avoir un mot de passe).
# @outils:default FAIL2BAN_IGNOREIP = 192.168.0.0/16
# @outils:hint FAIL2BAN_IGNOREIP = Adresses jamais bannies par fail2ban, séparées par des espaces (127.0.0.1 et ::1 toujours incluses). Vide = aucune en plus.

set -uo pipefail

UTILISATEUR="__UTILISATEUR__"
FAIL2BAN_IGNOREIP="__FAIL2BAN_IGNOREIP__"

[ "$EUID" -eq 0 ] || { echo "Ce script doit être lancé avec sudo (/etc/ssh, /etc/shadow, fail2ban)." >&2; exit 1; }

# --- Vérifications avant de toucher à quoi que ce soit ---
[ -n "$UTILISATEUR" ] && id "$UTILISATEUR" >/dev/null 2>&1 || { echo "ERREUR : le compte « $UTILISATEUR » n'existe pas sur $(hostname)." >&2; exit 1; }
[ "$UTILISATEUR" != root ] || { echo "ERREUR : choisissez un compte autre que root (root passe par clé seulement)." >&2; exit 1; }
[ "$(passwd -S "$UTILISATEUR" | awk '{print $2}')" = P ] \
  || { echo "ERREUR : « $UTILISATEUR » n'a pas de mot de passe utilisable — donnez-lui en un (passwd $UTILISATEUR) avant de durcir." >&2; exit 1; }
if ! grep -Eq '^(ssh-|ecdsa-|sk-)' /root/.ssh/authorized_keys 2>/dev/null; then
  echo "ATTENTION : aucune clé pour root (/root/.ssh/authorized_keys) — après ce script, root ne sera joignable en SSH que par $UTILISATEUR puis sudo/su." >&2
fi
command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ] || { echo "ERREUR : serveur SSH (sshd) introuvable." >&2; exit 1; }
SSHD=/usr/sbin/sshd

# --- Sauvegarde ---
SAUV="/root/durcissement-acces-$(date +%Y-%m-%d_%H%M%S)"
mkdir -p "$SAUV" && chmod 700 "$SAUV"
cp -a /etc/ssh "$SAUV/ssh"
[ -d /etc/fail2ban ] && cp -a /etc/fail2ban "$SAUV/fail2ban"
cp -a /etc/shadow "$SAUV/shadow"
echo "Sauvegarde de la configuration actuelle : $SAUV"

restaurer() {
  echo "Remise en place de la configuration d'origine depuis $SAUV..." >&2
  rm -rf /etc/ssh && cp -a "$SAUV/ssh" /etc/ssh
  cp -a "$SAUV/shadow" /etc/shadow
  if [ -d "$SAUV/fail2ban" ]; then rm -rf /etc/fail2ban && cp -a "$SAUV/fail2ban" /etc/fail2ban; fi
  echo "Configuration d'origine remise en place ; rien n'a été rechargé." >&2
}

# --- SSH ---
# Drop-in en « 01- » : sshd garde la PREMIÈRE valeur lue et lit sshd_config.d par ordre alphabétique — un « 50-cloud-init.conf »
# (PasswordAuthentication yes) passerait sinon avant nous.
mkdir -p /etc/ssh/sshd_config.d
grep -Eq '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config \
  || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
PRL=prohibit-password
cat > /etc/ssh/sshd_config.d/01-dimotic-durcissement.conf <<EOF
# Durcissement (script Outils « durcissement-acces », $(date +%d/%m/%Y)) — mot de passe refusé sauf bloc Match en fin de sshd_config.
PermitRootLogin $PRL
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
# Bloc Match géré par ce script, entre repères (remplacé à chaque passage), TOUJOURS en fin de fichier.
sed -i '/^# >>> dimotic durcissement-acces/,/^# <<< dimotic durcissement-acces/d' /etc/ssh/sshd_config
COMPTES_MDP="$UTILISATEUR"
printf '\n# >>> dimotic durcissement-acces (ne pas modifier entre ces repères)\nMatch User %s\n    PasswordAuthentication yes\n# <<< dimotic durcissement-acces\n' \
  "$COMPTES_MDP" >> /etc/ssh/sshd_config

# --- Contrôles AVANT rechargement ---
mkdir -p /run/sshd
"$SSHD" -t || { echo "ERREUR : sshd refuse la nouvelle configuration." >&2; restaurer; exit 1; }
verifier() { # $1 = compte, $2 = yes|no attendu
  local eff; eff="$("$SSHD" -T -C "user=$1,host=essai,addr=127.0.0.1" 2>/dev/null)"
  grep -q "^passwordauthentication $2\$" <<<"$eff" \
    || { echo "ERREUR : mot de passe SSH pour « $1 » : « $2 » attendu." >&2; restaurer; exit 1; }
}
verifier "$UTILISATEUR" yes
verifier root no
verifier personne-dimotic no
grep -q "^permitrootlogin $PRL\$" <<<"$("$SSHD" -T -C user=root,host=essai,addr=127.0.0.1)" \
  || { [ "$PRL" = prohibit-password ] && grep -q '^permitrootlogin without-password$' <<<"$("$SSHD" -T -C user=root,host=essai,addr=127.0.0.1)"; } \
  || { echo "ERREUR : PermitRootLogin n'est pas « $PRL »." >&2; restaurer; exit 1; }
echo "SSH : mot de passe accepté pour $UTILISATEUR seulement, clés acceptées, root par clé seulement — contrôlé."

# --- fail2ban ---
if ! command -v fail2ban-client >/dev/null 2>&1; then
  echo "Installation de fail2ban..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban python3-systemd nftables >/dev/null \
    || { apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban python3-systemd nftables >/dev/null; } \
    || { echo "ERREUR : installation de fail2ban impossible (réseau ?)." >&2; restaurer; exit 1; }
fi
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1
findtime = 600
maxretry = 5
bantime  = 43200
banaction = nftables
backend = systemd

[sshd]
enabled = true
port    = ssh
EOF
printf '[DEFAULT]\nignoreip = 127.0.0.1/8 ::1 %s\n' "$FAIL2BAN_IGNOREIP" > /etc/fail2ban/jail.d/zz-ignoreip.local
fail2ban-client -t >/dev/null 2>&1 || { echo "ERREUR : fail2ban refuse la configuration." >&2; restaurer; exit 1; }

# --- Application ---
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || { echo "ERREUR : rechargement de SSH impossible." >&2; restaurer; exit 1; }
systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban
sleep 2
echo "fail2ban : $(fail2ban-client status sshd 2>/dev/null | grep -E 'Currently banned|Total banned' | tr -s '\t ' ' ' | paste -sd';' -) — jamais bannies : 127.0.0.1 ::1 $FAIL2BAN_IGNOREIP"

# --- Bilan (information) ---
echo
echo "=== Bilan sur $(hostname)"
echo "Comptes avec un mot de passe utilisable : $(passwd -Sa 2>/dev/null | awk '$2 == "P" {print $1}' | paste -sd' ' -)"
echo "Clés acceptées pour root : $(grep -c '^ssh-\|^ecdsa-' /root/.ssh/authorized_keys 2>/dev/null || echo 0)"
echo "Ports ouverts sur le réseau :"
ss -ltnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\])' | sort -u | paste -sd' ' - | sed 's/^/  /'
echo
echo "✅ Durcissement appliqué. Testez une NOUVELLE connexion SSH avant de fermer celle-ci. Retour arrière : $SAUV"
