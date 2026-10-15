# Accès restreint de l'agent de noisy2 aux pilotes de noisy (à installer par l'utilisateur)

Principe : l'agent Claude de **noisy2** appelle noisy par SSH avec une clé dédiée, dont la **seule commande permise** est
`/usr/local/bin/dimotic-pilotes` (lister / lire / écrire / arrêter / démarrer / redémarrer un pilote : arexx, rfxcom,
rpigpio, teleinfo). Pas de shell, pas de rebond, pas de redirection (`restrict`). Journal : `/var/log/dimotic-pilotes.log` sur noisy.

## 1. Sur noisy2 (compte `claude`, depuis la console IA ou `su - claude`)
```
ssh-keygen -t ed25519 -N '' -C 'agent-noisy2 -> pilotes noisy' -f ~/.ssh/noisy-pilotes
cat ~/.ssh/noisy-pilotes.pub        # à recopier à l'étape 2
```

## 2. Sur noisy (en root) — depuis falbala : `ssh -J root@dimoticnoisy.duckdns.org root@192.168.1.62`
```
install -m 755 /chemin/dimotic-pilotes.sh /usr/local/bin/dimotic-pilotes      # copie du script (voir étape 3)
touch /var/log/dimotic-pilotes.log
echo 'command="/usr/local/bin/dimotic-pilotes",restrict <contenu de noisy-pilotes.pub>' >> /root/.ssh/authorized_keys
```

## 3. Copier le script
Le script est dans le dépôt : `applications/ia/agent/noisy-pilotes/dimotic-pilotes.sh` (et déjà posé sur noisy2 :
`/home/claude/noisy-pilotes/dimotic-pilotes.sh`). Depuis falbala :
`scp -J root@dimoticnoisy.duckdns.org applications/ia/agent/noisy-pilotes/dimotic-pilotes.sh root@192.168.1.62:/tmp/` puis `install` ci-dessus.

## 4. Essai (sur noisy2, compte `claude`)
```
ssh -i ~/.ssh/noisy-pilotes -o IdentitiesOnly=yes root@192.168.1.62 lister
ssh -i ~/.ssh/noisy-pilotes -o IdentitiesOnly=yes root@192.168.1.62 lister arexx
ssh -i ~/.ssh/noisy-pilotes -o IdentitiesOnly=yes root@192.168.1.62 ls        # doit être REFUSÉ
```

## 5. Autoriser Claude Code à l'utiliser (compte `claude` de noisy2)
Dans `~/.claude/settings.json` (ou le `settings.json` de `/dimotic-ha-addons/agent-ha/.claude/`), ajouter dans `permissions.allow` :
```
"Bash(ssh -i ~/.ssh/noisy-pilotes -o IdentitiesOnly=yes root@192.168.1.62 lister*)",
"Bash(ssh -i ~/.ssh/noisy-pilotes -o IdentitiesOnly=yes root@192.168.1.62 lire *)"
```
Et laisser **en demande de confirmation** (ne pas les mettre dans `allow`) les commandes qui agissent : `ecrire`, `arreter`, `demarrer`, `redemarrer`.

## Retour arrière
Supprimer la ligne `command="/usr/local/bin/dimotic-pilotes"…` de `/root/.ssh/authorized_keys` sur noisy.
