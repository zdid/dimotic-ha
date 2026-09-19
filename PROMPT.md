# PROMPT.md - Instructions pour Vibe

## 📌 Règles Principales

### 1. **Lecture Obligatoire avant toute action**
- ✅ **TOUJOURS** lire `PROMPT_PROJET.md` en premier
- ✅ **TOUJOURS** lire les spécifications actuelles dans `specs/current/` avant toute modification
- ✅ **TOUJOURS** vérifier les dates de modification dans les commentaires des fichiers

### 2. **Gestion des Spécifications**
- ❌ **JAMAIS** supprimer ou modifier un fichier dans `specs/`
- ✅ **TOUJOURS** conserver toutes les versions (archives dans `specs/archives/vX.Y.Z/`)
- ✅ **TOUJOURS** inclure la version dans le nom des fichiers de specs
- ✅ **TOUJOURS** mettre à jour `specs/CHANGELOG.md` après modification des specs

### 3. **Build Obligatoire**
- ✅ **TOUJOURS** exécuter `npm run build` après toute modification du code
- ✅ Vérifier que le build se termine sans erreur avant de commiter

---

## 🔧 Procédure Standard pour toute Tâche

### Avant de commencer :
```
1. Lire PROMPT_PROJET.md
2. Lire toutes les specs dans specs/current/
3. Identifier les fichiers concernés
4. Vérifier les commentaires de date dans les fichiers principaux
```

### Pendant le travail :
```
1. Respecter les conventions de nommage (voir nommage_specs)
2. Respecter les patterns architecturaux (voir architectural-patterns_specs)
3. Appliquer les règles de gestion des erreurs (voir erreurs_specs)
4. Suivre les spécifications fonctionnelles de l'application concernée (voir fonctionnelles-{app}_specs, ex: fonctionnelles-rfxcom_specs)
```

### Après modification :
```
1. Exécuter : npm run build
2. Vérifier l'absence d'erreurs de compilation
3. Tester les modifications si applicable
4. Mettre à jour les commentaires de date dans les fichiers modifiés
5. Documenter dans CHANGELOG.md si modification des specs
```

---

## 📁 Structure des Spécifications Actuelles

> ⚠️ Liste **sans numéro de version** : chaque nom ci-dessous est un préfixe de base — le fichier réel dans `specs/current/` porte toujours un suffixe `_vX.Y.md` (ex: `techniques-socle-ha-mqtt_specs_v4.9.md`). Toujours utiliser la version la plus récente présente dans `specs/current/`.

| Fichier (base, sans version) | Description |
|---|---|
| `architectural-patterns_specs` | Patterns architecturaux MQTT/WS |
| `classification-rfxcom_specs` | **Archivé (19/09/2026)** : conception jamais construite (IHaClassifier RFXCOM), ne correspond pas au code réel — voir `specs/archives/v5.17-rfxcom/` et l'avertissement en tête de `fonctionnelles-rfxcom_specs_v6.0.md` |
| `erreurs_specs` | Codes d'erreur et états standardisés |
| `fonctionnelles-arbreouquoi_specs` | Spécifications fonctionnelles ARBREOUQUOI |
| `fonctionnelles-nommage_specs` | Spécifications fonctionnelles NOMMAGE |
| `fonctionnelles-rfxcom_specs` | Spécifications RFXCOM — fusion Fonctionnel+Implémentation+Récepteurs/Émetteurs depuis le 19/09/2026 (v6.0, un seul fichier, 3 parties §/§T/§R) |
| `guide-nouvelle-application_specs` | Guide de création d'une nouvelle application |
| `implementation-arbreouquoi_specs` | Implémentation ARBREOUQUOI |
| `implementation-nommage_specs` | Implémentation NOMMAGE |
| `integrationbridge-mqtt-auto_specs` | Démarrage/arrêt automatique MQTT et HA-WS |
| `inter-app-communication_specs` | Communication inter-applications (Request/Reply, EventBus partagé) |
| `nommage_specs` | Conventions de nommage QUOI/OÙ |
| `presentation_specs` | Couche Présentation (TypeScript + Web Components) |
| `techniques-socle-ha-mqtt_specs` | Spécifications techniques du socle (architecture 5 couches) |

---

## 🚨 Règles Critiques pour Vibe

### Modifications de Masse
- ⚠️ **Une modification de masse** = >10 fichiers OU >30% du code d'un module
- ✅ **Analyser systématiquement** : portée, risque de corruption, criticité
- ✅ **Seuils** :
  - Modification mineure (≤10 fichiers ET ≤30% du code) ET sans risque → Application directe
  - Modification de masse (>10 fichiers OU >30%) OU risque identifié → **Demander confirmation explicite** + sauvegarde

### Scripts de Modification Massive
- ❌ **INTERDIT** : Utiliser `sed`, `awk` pour modifier du code source **sans validation manuelle préalable**
- ✅ **Préférer** : Outils de refactoring adaptés (IDE, linters)
- ⚠️ **Si indispensable** :
  1. Tester sur une copie isolée
  2. Valider chaque changement avec `git diff`
  3. Créer une sauvegarde complète avant exécution

### Sauvegardes
- ✅ **Créer une sauvegarde** dans `backups/` avant toute modification de masse
- ✅ **Format** : `[nom]_backup_[AAAA-MM-JJ][_description].ext`
- ✅ **Vérifier** avec `diff -r original/ backups/nom_backup/`
- ✅ **Conserver** au minimum 3 versions de chaque programme
- ❌ **JAMAIS** modifier un fichier dans `backups/`

---

## 📝 Format des Commentaires de Date

**Format obligatoire** dans les fichiers principaux (index.html, etc.) :
```html
<!-- Derniere modification: AAAA-MM-JJ HH:MM:SS - [Description de la modification] -->
```

**Exemple** :
```html
<!-- Derniere modification: 2026-07-13 12:14:50 - deferAlpineStart=true, scripts en fin de body, Alpine.start() manuel -->
```

---

## 🔄 Procédures Types

### Pour demander une sauvegarde :
```
"Vibe, sauvegarde le répertoire [nom_répertoire] avec la date du jour."
```

### Pour restaurer depuis une sauvegarde :
1. Vérifier l'intégrité : `diff -r current/ backups/nom_backup/`
2. Copier les fichiers nécessaires
3. Documenter dans `CHANGELOG.md`

---

## 🏗️ Structure du Projet

```
ha-mqtt-socle/
├── app/                          # Applications
├── applications/                 # Applications actives
├── applications_desactivees/    # Applications désactivées
├── backups/                      # Sauvegardes (exclu de git)
├── data/                         # Données
├── dist/                         # Build compilé
├── docs/                         # Documentation
├── logs/                         # Logs
├── scripts/                      # Scripts utilitaires
├── specs/                        # Spécifications
│   ├── current/                  # Spécifications actuelles
│   ├── archives/                 # Archives des specs
│   └── CHANGELOG.md              # Historique des specs
├── src/                          # Code source TypeScript
├── temprfxcom/                   # Fichiers temporaires RFXCOM
└── tests/                        # Tests
```

---

## ⚡ Commandes Utiles

| Action | Commande |
|--------|----------|
| Build | `npm run build` |
| Build UI | `npm run build:ui` |
| Build watch | `npm run build:watch` |
| Start | `npm start` |
| Dev | `npm run dev` |
| Test | `npm test` |
| Test watch | `npm run test:watch` |
| Typecheck | `npm run typecheck` |

| Action | Commande |
|--------|----------|
| Sauvegarder | `./scripts/backup.sh <répertoire> [description]` |
| Lister sauvegardes | `ls -la backups/` |
| Comparer | `diff -r src/ backups/src_backup_2026-07-12/` |
| Vérifier checksum | `sha256sum -c fichier.sha256` |

---

## 📊 Résumé des Règles en 10 Secondes

1. **Lire** PROMPT_PROJET.md + specs/current/ AVANT tout
2. **Sauvegarder** si modification de masse (>10 fichiers ou >30% du code)
3. **Build** après toute modification : `npm run build`
4. **Documenter** les dates dans les fichiers principaux
5. **Ne jamais** supprimer specs/ ou backups/
6. **Valider** avec `diff` avant de restaurer

---

*Ce fichier doit être lu avant toute interaction avec le projet. En cas de doute, se référer à PROMPT_PROJET.md.*