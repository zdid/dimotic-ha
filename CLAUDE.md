# CLAUDE.md

Règles distillées de `PROMPT.md` et `PROMPT_PROJET.md` (voir l'en-tête de chaque fichier pour sa version courante — référence volontairement sans numéro de version ici, pour ne pas se périmer à chaque mise à jour de l'un des deux, cf. `PROMPT_PROJET.md` §3), les documents de règles du projet écrits pour tout assistant IA travaillant ici. **Ces deux fichiers restent la référence complète** (procédures détaillées, templates de sauvegarde, table de correspondance specs↔application) — en cas de divergence avec ce CLAUDE.md, ce sont eux qui font foi ; mets ce fichier à jour en conséquence si tu les modifies.

## Le projet

`ha-mqtt-socle` — socle technique commun (WebSocket Home Assistant + MQTT) sur lequel se greffent des applications métier indépendantes.

## Structure réelle (vérifiée sur disque)

```
applications/
  core/                    # Le socle — NE PEUT PAS être désactivé. package.json/tsconfig/src propres.
  <app>/                   # Chaque application métier est autonome : son propre
                            # package.json, tsconfig.json, src/, dist/ (ex: nommage, arbreouquoi)
applications_désactivées/  # Applications désactivées
specs/
  current/                 # Spécifications actuelles, versionnées dans le nom du fichier
  archives/vX.Y.Z/         # Anciennes versions des specs (gitignored)
  CHANGELOG.md             # Historique des évolutions de specs
backups/                   # Sauvegardes locales (gitignored, jamais commitées)
data/                      # Runtime, gitignored — un sous-répertoire par application
  core/                    # config.yaml du socle (ha/web/logging)
  <app>/                   # config.yaml de l'app (objet nu) + ses fichiers de données
logs/                      # Runtime, gitignored
```

Chaque application (y compris le core) a son propre sous-répertoire dans `data/`, regroupant
config et données — objectif : pouvoir déplacer une application d'une machine à une autre en
copiant un seul sous-répertoire. `ConfigLoader`/`ConfigService` fusionnent tout en mémoire au
chargement ; le code métier d'une application continue de n'accéder qu'à sa propre section via
`IAppConfigProvider`, sans changement.

Il n'existe **pas** de build global fiable à la racine : le script `build` du `package.json` racine référence encore un ancien chemin (`src/applications/rfxcom/...`) qui n'existe plus dans la nouvelle arborescence — considère-le obsolète. Build toujours au niveau de l'application modifiée :

```bash
cd applications/core && npm run build      # tsc (+ build:ui, dev, dev:local, test, typecheck)
cd applications/nommage && npm run build    # tsc (+ watch)
cd applications/arbreouquoi && npm run build # tsc (+ watch, dev:local)
```

## Règles impératives

1. **Specs immuables** : jamais de suppression ni modification en place dans `specs/`. Nouvelle version → nouveau fichier `nom_specs_vX.Y.Z.md` dans `specs/current/`, l'ancien déplacé vers `specs/archives/vX.Y.Z/`, et `specs/CHANGELOG.md` mis à jour.
2. **Lecture avant modification** : avant de toucher à une application, lire les specs concernées dans `specs/current/` (voir la table de correspondance §11 de `PROMPT_PROJET.md`).
3. **Build après modification de code** : exécuter le `npm run build` de l'application concernée et vérifier l'absence d'erreur avant de considérer la tâche terminée.
4. **Modification de masse** (>10 fichiers OU >30% du code d'un module) OU risque de corruption identifié → **demander confirmation explicite** + créer une sauvegarde avant d'agir. Ne jamais utiliser `sed`/`awk` sur du code source sans validation manuelle préalable (`git diff`) et sauvegarde complète.
5. **Sauvegardes** dans `backups/` : jamais commitées, jamais modifiées après création, nommage `[fichier]_backup_[AAAA-MM-JJ][_description].ext`, structure de répertoires préservée, vérification avec `diff -r` avant toute restauration, minimum 3 versions conservées.
6. **Commentaire de date** obligatoire dans les fichiers principaux (`index.html`, etc.) : `<!-- Derniere modification: AAAA-MM-JJ HH:MM:SS - [description] -->`, à maintenir à jour immédiatement après chaque modification.
7. **Le core** (`applications/core/`) ne peut jamais être désactivé. L'activation/désactivation des autres applications se fait uniquement via l'UI (*Paramètres Techniques > Gestion des applications*) ou par déplacement manuel entre `applications/` et `applications_désactivées/`.
8. **Git** : ne pas committer `backups/` (déjà exclu via `.gitignore`), taguer les versions de specs (`git tag specs/vX.Y.Z`), branches `feature/`, `fix/`, `release/`, commits atomiques et clairs.
