# Procédure — Déployer une application ou un correctif par la racine externe

*Établie le 06/10/2026 en déployant `rfxcom` sur une machine distante. À utiliser pour le **débogage à distance**, un
**correctif urgent** ou l'essai d'une application sur **n'importe quelle machine**, sans reconstruire ni publier d'image Docker.*

## 1. Principe

Le core détecte les applications sur **deux racines** (`application/appRoots.ts`) :

| Racine | Dossier | Rôle |
|---|---|---|
| interne | `applications/` | livrée avec l'image Docker |
| **externe** | `data/applications/` | sur le volume `data/` : **survit aux changements d'image** |

Une application externe de **même nom** qu'une interne la **masque**, sans toucher au disque. Pour revenir à la version de l'image :
supprimer son dossier, puis désactiver et réactiver l'application. Dans « Gestion des applications », elle porte le badge « externe ».

**Ne jamais modifier les fichiers à l'intérieur du conteneur** (`docker cp` dans `/app/applications/…`) : les changements disparaissent
au prochain changement d'image et rien ne l'indique dans l'interface.

## 2. Ce qu'il faut savoir avant de commencer

- **En production, tout tourne en JavaScript compilé.** Le superviseur lance `dist/standalone.js` avec `node` ; il ne se rabat sur
  `src/standalone.ts` via `tsx` que si `dist/` est absent, et **`tsx` n'est pas dans l'image** (dépendances de développement retirées).
  Une application externe doit donc contenir son `dist/`.
- Le **lien `data/applications/core → ../../applications/core`** (créé par le core) est nécessaire : les applications importent le core par
  un chemin relatif (`../../../core/dist/exports`). Il existe déjà ; le vérifier. Le core lui-même ne peut pas être remplacé par ce moyen.
- Une application externe lit les **mêmes données** que l'interne (`data/<app>/…`).
- **Repères de préparation** (`ExternalAppPreparer`) : `node_modules/.dimotic-install` (dernière installation) et `dist/.dimotic-build` (dernière
  compilation), comparés aux dates de `package.json`, `package-lock.json` et `src/`. Quand ils manquent ou sont plus anciens, le core veut
  **installer les dépendances (`npm install`) puis compiler (`tsc -p tsconfig.json`)** avant d'activer l'application : il faut alors les
  sources (`src/`, `tsconfig.json`) et c'est long sur un Raspberry Pi.

## 3. Méthode A — code compilé ailleurs (la plus rapide)

1. **Compiler et tester en local** : `cd applications/<app> && npm run build && npm test`.
2. **Repérer ce qui diffère de l'image** : comparer les sommes de contrôle des `.js` de `dist/` entre le conteneur et le dossier local
   (`docker exec <conteneur> sh -c 'cd /app/applications/<app>/dist && find . -name "*.js" | sort | xargs md5sum'`). Ignorer le dossier
   `dist/core/` ou `dist/<app>/src/`, artefacts de compilation absents de l'image. Seuls les fichiers modifiés sont à poser.
3. **Sur la machine cible** (`<DATA>` = dossier de l'hôte monté sur `/app/data`) :
   - `mkdir -p <DATA>/applications/<app>` ;
   - copier la base **saine** depuis le conteneur :
     `docker cp <conteneur>:/app/applications/<app>/{package.json,package-lock.json,node_modules,dist} <DATA>/applications/<app>/`
     (une copie par élément) ;
   - **superposer** les fichiers modifiés (par exemple `tar -C dist -cf - <fichiers> | ssh <hôte> 'tar -C <DATA>/applications/<app>/dist -xf -'`) ;
   - **poser les repères** : `date -u +%FT%TZ > <DATA>/applications/<app>/node_modules/.dimotic-install` (s'il n'existe pas) et
     `… > <DATA>/applications/<app>/dist/.dimotic-build` ;
   - `chown -R <propriétaire de <DATA>> <DATA>/applications/<app>` (le conteneur tourne avec l'utilisateur 1000) ;
   - vérifier que `<DATA>/applications/core` pointe vers `../../applications/core`.
4. **Prise en compte à chaud** : désactiver puis activer l'application (page « Gestion des applications », ou événements Socket.io, §5). Le core
   n'est **jamais** redémarré. Pour `rfxcom`, la radio est coupée environ 20 secondes.
5. **Vérifier** : le processus est `node /app/data/applications/<app>/dist/standalone.js` ; le journal du core contient
   `Application <app> activée (/app/data/applications/<app>)`.

**Retour arrière** : supprimer `<DATA>/applications/<app>`, puis désactiver et réactiver l'application.

## 4. Méthode B — sources (le flux prévu par le core)

Déposer `src/`, `package.json`, `package-lock.json` et `tsconfig.json` dans `<DATA>/applications/<app>/`, puis cliquer sur **« Réinstaller /
recompiler »** sur l'application **qui tourne** : le core installe, compile, puis la **relance** (`app:applications:prepare`). L'application
embarquée continue de fonctionner pendant la préparation. Lent sur Raspberry Pi (délai maximal 20 minutes par étape), à n'utiliser que si on
ne peut pas compiler ailleurs.

## 5. Désactiver / activer sans passer par l'écran (machine distante)

Ouvrir un tunnel vers le core (port web 8087 par défaut) : `ssh -f -N -L 18087:127.0.0.1:8087 <hôte>`. Puis, avec le module `ws` du core :

```js
const WebSocket = require('<projet>/applications/core/node_modules/ws');
const [host, appId, ev] = process.argv.slice(2);          // ex. 127.0.0.1:18087 rfxcom app:applications:disable
const ws = new WebSocket(`ws://${host}/socket.io/?EIO=4&transport=websocket`);
ws.on('message', m => {
  const s = m.toString();
  if (s[0] === '0') ws.send('40');                        // ouverture Engine.IO → namespace par défaut
  else if (s === '2') ws.send('3');                       // ping → pong
  else if (s.startsWith('40')) ws.send('42' + JSON.stringify([ev, { appId }]));
  else if (s.startsWith('42')) { const [n, d] = JSON.parse(s.slice(2)); if (n === ev + ':result') { console.log(JSON.stringify(d)); process.exit(d.success ? 0 : 3); } }
});
```

Exécuter une fois avec `app:applications:disable`, puis avec `app:applications:enable`. Fermer le tunnel ensuite (par son numéro de processus : un
`pkill -f` dont le motif figure dans sa propre ligne de commande se tue lui-même).

## 6. Pièges rencontrés

- **Ne pas désactiver avant que le dossier externe soit prêt.** Activer une application externe non préparée lance `npm install` + `tsc`
  alors qu'elle est éteinte : le 06/10/2026, RFXCOM est resté éteint 75 secondes sur un site, et la compilation a échoué faute de
  `tsconfig.json`. Poser le dossier **complet avec ses repères** avant toute désactivation.
- **Sans repères ni sources**, le core force une préparation qui échoue : l'application reste désactivée. Retirer le dossier suffit à
  rétablir l'interne.
- **`tsx` absent de l'image** : une application externe sans `dist/` est refusée (« ni dist/standalone.js ni src/standalone.ts »).
- **Toujours sauvegarder** ce qu'on remplace, et vérifier après le redémarrage à chaud que le statut de l'application est « online ».
- Le `npm install` du core peut ajouter les dépendances de développement (TypeScript) au dossier externe : le dossier grossit, sans conséquence.

## 7. Diagnostic radio (RFXCOM)

`radioDebug: true` dans `data/rfxcom/config.yaml` journalise en hexadécimal chaque paquet reçu et émis par le transceiver (journal du
conteneur) ; il est pris en compte à la connexion suivante et se retire en supprimant la ligne (puis désactivation/activation). Les traces du
journal applicatif (`RF reçu`, `Volet …`, `→ RFXCOM`) sont toujours actives en niveau debug.
