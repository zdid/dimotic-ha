# Accès restreint de l'agent Claude d'un site aux pilotes d'une machine

L'agent Claude d'un site (**noisy2** pour noisy, **ha2** pour stfort) appelle la machine des pilotes par SSH avec une clé dédiée dont la **seule commande permise** est
`/usr/local/bin/dimotic-pilotes` : `lister`, `lire`, `ecrire` (sauvegarde + contrôle YAML/JSON), `arreter` / `demarrer` / `redemarrer` un pilote (arexx, rfxcom, rpigpio, teleinfo ; jamais le cœur).
Pas de shell, ni rebond, ni redirection (`restrict`). Journal : `/var/log/dimotic-pilotes.log` sur la machine des pilotes. Rien ne s'installe tout seul.

Ce dossier est dans l'image dimotic-ha : `/app/applications/ia/agent/acces-pilotes/`. Pour le sortir : `docker cp dimotic-ha:/app/applications/ia/agent/acces-pilotes /tmp/` (sur chaque machine concernée).

## 1. Côté agent (noisy2 ou ha2, compte `claude`)
```
/tmp/acces-pilotes/installer-acces-agent.sh agent --nom noisy  --hote 192.168.1.62     # pour noisy  (clé ~/.ssh/noisy-pilotes)
/tmp/acces-pilotes/installer-acces-agent.sh agent --nom stfort --hote 192.168.1.53     # pour stfort (clé ~/.ssh/stfort-pilotes)
```
Il crée la clé (sans la remplacer si elle existe) et affiche la partie publique.

## 2. Côté pilotes (noisy ou stfort, root)
```
sudo /tmp/acces-pilotes/installer-acces-agent.sh pilotes --cle-publique "ssh-ed25519 AAAA… agent …"
```
Détecte les pilotes présents dans `/docker/dimotic-ha/data` (ou `--apps "arexx rfxcom"`, `--donnees`, `--conteneur`, `--port`), installe le script, écrit `/etc/dimotic-pilotes.conf` et autorise la clé
(sauvegarde de `authorized_keys` avant).

## 3. Essai (depuis l'agent)
```
ssh -i ~/.ssh/noisy-pilotes -o IdentitiesOnly=yes root@192.168.1.62 lister arexx
ssh -i ~/.ssh/noisy-pilotes -o IdentitiesOnly=yes root@192.168.1.62 ls          # doit être REFUSÉ
```

## 4. Autoriser Claude Code (compte `claude` de l'agent)
Dans son `settings.json`, `permissions.allow` : seulement `lister` et `lire` (ex. `"Bash(ssh -i ~/.ssh/noisy-pilotes -o IdentitiesOnly=yes root@192.168.1.62 lister*)"`, idem `lire *`).
Laisser `ecrire`, `arreter`, `demarrer`, `redemarrer` **hors** de la liste : Claude Code demande alors confirmation à chaque fois.

## Retour arrière
`sudo ./installer-acces-agent.sh pilotes --annuler` (retire la clé autorisée, le script et la config).
