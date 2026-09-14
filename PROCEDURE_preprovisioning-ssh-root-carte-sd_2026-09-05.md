# Procédure de pré-provisionnement SSH root sur une carte SD (avant premier boot)

<!-- Derniere modification: 2026-09-05 - Premier jet, rédigé avec l'utilisateur -->

Contexte (05/09/2026) : après un reflash de la carte SD du RPi1 (Raspberry Pi OS Bookworm), l'accès
SSH root direct dont dépend le déploiement automatique de `teleinfo` (`DeployService.ts`,
`ensureGlobalSshKey`) n'existe plus — contrairement à l'ancienne installation (voir mémoire de
session `project_teleinfo_app`), Raspberry Pi OS moderne ne permet pas le login root par défaut et
ne crée pas de compte root utilisable. Cette procédure prépare la carte **avant** de la remettre dans
le Pi, en montant directement sa partition système sur la machine qui héberge dimotic-ha.

⚠️ Nécessite `sudo` sur la machine hôte (écriture dans des répertoires appartenant à `root` sur la
carte) — Claude ne peut pas l'exécuter lui-même (pas de mot de passe sudo interactif disponible dans
ce contexte), donc à lancer manuellement par l'utilisateur.

## Prérequis

- Carte flashée avec Raspberry Pi Imager (SSH activé via l'option du logiciel, ou fichier `ssh` vide
  à la racine de `bootfs` sinon).
- Carte encore branchée sur la machine qui héberge dimotic-ha (pas encore insérée dans le Pi).
- Les 2 partitions (`bootfs` FAT32, `rootfs` ext4) automatiquement montées par l'environnement de
  bureau — vérifier avec `lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT`. Chemins observés en
  conditions réelles : `/media/<user>/bootfs` et `/media/<user>/rootfs`.

## Étape 1 — Autoriser le login SSH root (drop-in, pas d'édition directe)

Raspberry Pi OS inclut `/etc/ssh/sshd_config.d/*.conf` depuis `sshd_config` (`Include` en tête de
fichier) — un drop-in dédié est préféré à une édition en place de `sshd_config`, pour ne pas risquer
un conflit avec une régénération de config par le premier boot (Raspberry Pi Imager y dépose déjà son
propre `rename_user.conf`) :

```bash
sudo mkdir -p /media/<user>/rootfs/etc/ssh/sshd_config.d
echo "PermitRootLogin yes" | sudo tee /media/<user>/rootfs/etc/ssh/sshd_config.d/permit-root-login.conf
```

## Étape 2 — Déposer les clés publiques autorisées pour root

**Pas de mot de passe root créé** — le compte root reste verrouillé (comportement par défaut d'une
image fraîche), seule l'authentification par clé est possible. C'est cohérent avec le mécanisme
existant : `DeployService.ts`/`ensureGlobalSshKey` n'utilisent jamais de mot de passe.

Deux clés déposées, chacune avec son usage :
- La clé **unique de l'installation dimotic-ha** (`data/core/ssh/id_ed25519.pub`, générée
  automatiquement au démarrage — voir `core/infrastructure/remote/SshClient.ts`) — pour le
  déploiement automatique déclenché depuis l'IHM.
- Une clé **personnelle** de l'utilisateur — pour un accès root manuel direct (dépannage), sans
  dépendre de dimotic-ha.

```bash
sudo mkdir -p /media/<user>/rootfs/root/.ssh
sudo tee /media/<user>/rootfs/root/.ssh/authorized_keys > /dev/null << 'EOF'
<contenu de data/core/ssh/id_ed25519.pub>
<contenu de la clé publique personnelle choisie>
EOF

sudo chmod 700 /media/<user>/rootfs/root/.ssh
sudo chmod 600 /media/<user>/rootfs/root/.ssh/authorized_keys
sudo chown -R 0:0 /media/<user>/rootfs/root/.ssh

sync
```

## Étape 3 — Vérification avant éjection

```bash
cat /media/<user>/rootfs/etc/ssh/sshd_config.d/permit-root-login.conf   # doit afficher "PermitRootLogin yes"
sudo cat /media/<user>/rootfs/root/.ssh/authorized_keys                 # doit afficher les 2 clés
```

**⚠️ Piège observé en conditions réelles** : un utilisateur normal (pas root) ne peut plus lire
`/root/.ssh/` une fois les permissions restrictives appliquées (`Permission non accordée`) — c'est le
comportement **attendu**, pas un échec. Seul `sudo cat ...` confirme le contenu avec certitude.

## Étape 4 — Démonter et insérer dans le Pi

```bash
sudo umount /media/<user>/bootfs /media/<user>/rootfs
```

Puis retirer la carte, l'insérer dans le RPi1, démarrer.

## Étape 5 — Test final (depuis la machine hôte dimotic-ha, une fois le Pi démarré et sur le réseau)

```bash
ssh root@<ip-du-rpi1>
```

Doit se connecter directement, sans mot de passe (authentification par clé). Si ça fonctionne, le
bouton "Déployer" de l'application Téléinfo (dimotic-ha) doit fonctionner sans étape manuelle
supplémentaire.

## Contexte plus large

Voir aussi :
- Mémoire de session `project_teleinfo_app` — historique complet du reflash RPi1 et des bugs
  d'activation/déploiement corrigés le même jour.
- `TODO.md`, entrée *"Teleinfo : déploiement sur cible sans Node.js/npm"* — installation automatique
  de Node.js (apt)/npm (tarball autonome) une fois l'accès SSH root rétabli par cette procédure.
