# PROMPT PROJET - Règles de Développement

**Version : 1.8**
**Date : 15 Août 2026**
**Dernière mise à jour : Table §11 "Pour Applications Spécifiques" — description de la ligne "Supervision multi-machines (SUPERVISOR)" mise à jour suite à la refonte v2.0 de sa spec (une application = un process OS, MQTT comme bus unifié intra+inter-machine, activation/désactivation en direct). Toujours pas implémenté. Aucun autre changement. Ancienne version v1.7 archivée dans `specs/archives/PROMPT_PROJET_v1.7-20260815.md`.**

## 📚 Table des Matières
1. [Règles Fondamentales](#-règles-fondamentales)
2. [Conventions de Nommage](#-conventions-de-nommage)
3. [Modifications de Programme](#-modifications-de-programme)
4. [Sauvegardes](#-sauvegardes)
5. [Intégration Git](#-intégration-git)
6. [Procédures Types](#-procédures-types)
7. [Gestion des Spécifications](#-gestion-des-spécifications)
8. [Cas Particuliers](#-cas-particuliers)
9. [Templates et Scripts](#-templates-et-scripts)

---

## 📋 Règles Fondamentales

### 1. **Conservation des Spécifications**
✅ **TOUJOURS** conserver les fichiers de spécifications.
❌ **JAMAIS** supprimer un fichier de spécifications, même si sa version est dépassée.

**Stockage :**
- Les spécifications actuelles → `specs/current/`
- Les versions obsolètes → `specs/archives/vX.Y.Z/`
- Un fichier `specs/CHANGELOG.md` doit tracer toutes les évolutions

---

### 2. **Immuabilité des Sauvegardes**
❌ **JAMAIS** modifier un fichier dans `backups/` après sa création.
✅ **TOUJOURS** créer une nouvelle sauvegarde si nécessaire.

---

### 3. **Convention de Nommage des Spécifications**
Les fichiers de spécification **doivent** contenir la version dans leur nom.

**Format recommandé :**
```
[nom]_specs_v[MAJEURE].[MINEURE].[PATCH][.suffixe].ext
```

**Exemples :**
- `api_specs_v1.0.0.md`
- `database_schema_v2.1.0.sql`
- `requirements_v3.0.0-beta.txt`

> **Note (v1.3)** : En pratique, les specs de `specs/current/` utilisent un format à **deux niveaux** `v[MAJEURE].[MINEURE]` (ex : `v4.7`, `v1.0`), le `PATCH` étant omis sauf besoin explicite. Le format ci-dessus reste la référence théorique complète ; la convention à deux niveaux est la norme effective du projet — s'y tenir pour toute nouvelle spec.

### 4. **Gestion des Dates dans les Fichiers**
Pour permettre le contrôle de version, **TOUJOURS** inclure un commentaire de date/heure correspondant à la date heure minutes secondes de le modification dans les fichiers principaux (index.html, etc.).

**Format obligatoire :**
```html
<!-- Derniere modification: AAAA-MM-JJ HH:MM:SS - [Description de la modification] -->
```

**Règles :**
- Utiliser le format ISO 8601 : `AAAA-MM-JJ`
- Inclure l'heure complète : `HH:MM:SS` (24h)
- Mettre à jour **immédiatement** après toute modification
- **Ne jamais** laisser une date obsolète

**Exemple :**
```html
<!-- Derniere modification: 2026-07-13 12:14:50 - deferAlpineStart=true, scripts en fin de body, Alpine.start() manuel -->
```

**Vérification :**
- Toujours vérifier ce commentaire pour confirmer la version du fichier
- En cas de doute, comparer avec le timestamp du système de fichiers

---

## ⚙️ Modifications de Programme

### 4. **Attention aux Modifications de Masse**
⚠️ **Définition :** Une modification de masse est tout changement touchant **plus de 10 fichiers** OU **plus de 30% du code d'un module**.

- **Privilégier** les modifications ciblées et incrémentales
- **Éviter** les refactorisations massives sans justification forte

### 4.1 **Analyse Systématique Obligatoire**
✅ **TOUJOURS analyser** avant toute modification :
- **Portée** : Nombre de fichiers touchés et pourcentage du code modifié dans chaque module
- **Risque de corruption** : La modification peut-elle casser des dépendances, des interfaces, ou la stabilité du programme ?
- **Criticité** : Le fichier modifié est-il critique (ex: service principal, configuration, parseur) ?

### 4.2 **Seuils et Actions Associés**

| Condition | Action Requise |
|-----------|----------------|
| Modification mineure (≤10 fichiers ET ≤30% du code d'un module) ET sans risque | Application directe avec transparence |
| Modification de masse (>10 fichiers OU >30% du code) **OU** risque de corruption identifié | ⚠️ **Demander confirmation explicite** + Créer une sauvegarde avant toute action |

### 4.3 **Risques des Modifications Massives par Script**
⚠️ **Les modifications massives par scripts (sed, awk, etc.) sont à haut risque** :
- **Non-unitarité** : Modifications potentiellement incohérentes ou mal appliquées.
- **Manque de contexte sémantique** : Les scripts ne comprennent pas le code.
- **Effets de bord imprévisibles** : Risque de corruption de fichiers critiques.

✅ **Règles strictes** :
- **❌ Interdit** : Utiliser `sed`, `awk`, ou outils similaires pour modifier du code source **sans validation manuelle préalable**.
- **✅ Préférer** : Outils de refactoring adaptés (IDE, linters, scripts dédiés et testés).
- **⚠️ Si indispensable** :
  1. Tester le script sur une **copie isolée** du projet.
  2. Valider **chaque changement individuellement** (ex: `git diff`).
  3. **Créer une sauvegarde complète** avant toute exécution.

---

## 💾 Sauvegardes

### 5. **Procédure de Sauvegarde Obligatoire**

Si une modification de masse est **indispensable** :

#### 5.1. Créer une sauvegarde
- **Emplacement :** Répertoire dédié aux sauvegardes (ex: `backups/`)
- **Structure :** Conserver **exactement** la même structure de répertoires que le projet original

#### 5.2. Nom de fichier de sauvegarde
Le nom **doit** intégrer :
- Le nom original du fichier
- La date au format `AAAA-MM-JJ`
- Eventuellement un identifiant de version ou description

**Format :**
```
[nom_original]_backup_[AAAA-MM-JJ][_description].ext
```

**Exemples :**
- `app.py_backup_2026-07-12.py`
- `config.json_backup_2026-07-12_before_migration.json`
- `models/component.py_backup_2026-07-12_v1.2.3.py`

#### 5.3. Gestion des versions multiples
- Le répertoire de sauvegarde peut contenir **plusieurs versions** du même programme
- Chaque version **doit** avoir un nom de fichier unique (via la date ou un suffixe)

---

### 6. **Sauvegarde à la Demande**

Je peux demander une sauvegarde complète d'un répertoire entier.

**Règles spécifiques :**
- Seuls **les noms de fichiers** intègrent le nouveau nom (date/suffixe)
- **Les répertoires** conservent leur nom d'origine
- La structure complète est préservée

**Exemple :**
```
Projet original:
project/
├── src/
│   ├── main.py
│   └── utils/
│       └── helper.py
└── config.json

Sauvegarde:
backups/project_2026-07-12/
├── src/
│   ├── main.py_backup_2026-07-12.py
│   └── utils/
│       └── helper.py_backup_2026-07-12.py
└── config.json_backup_2026-07-12.json
```

---

### 7. **Validation des Sauvegardes**
✅ **TOUJOURS vérifier** une sauvegarde avant de modifier l'original :
```bash
diff -r original/ backups/original_backup_2026-07-12/
```

---

### 8. **Nettoyage des Sauvegardes**
- Conserver **au minimum 3 versions** de chaque programme
- Archiver les anciennes sauvegardes (>6 mois) dans `backups/archives/`
- Supprimer uniquement après **validation manuelle** et accord écrit

---

## 🌿 Intégration Git

### 9. **Bonnes Pratiques Git**
- **Ne pas commiter** les sauvegardes dans le dépôt (ajouter `backups/` à `.gitignore`)
- **Taguer** les versions des spécifications : `git tag specs/v1.0.0`
- **Branches :** Utiliser `feature/`, `fix/`, `release/` pour les modifications
- **Commits :** Messages clairs et atomiques

---

## 📁 Structure Recommandée

```
projet/
├── specs/                  # Spécifications (toujours conservées)
│   ├── current/            # Version actuelle
│   │   ├── architectural-patterns_specs.md      # + suffixe de version, ex: _v1.0.md
│   │   ├── classification-rfxcom_specs.md
│   │   ├── erreurs_specs.md
│   │   ├── fonctionnelles-arbreouquoi_specs.md
│   │   ├── fonctionnelles-evoo7_specs.md
│   │   ├── fonctionnelles-nommage_specs.md
│   │   ├── fonctionnelles-rfxcom_specs.md
│   │   ├── guide-nouvelle-application_specs.md
│   │   ├── implementation-arbreouquoi_specs.md
│   │   ├── implementation-nommage_specs.md
│   │   ├── implementation-rfxcom_specs.md
│   │   ├── integrationbridge-mqtt-auto_specs.md
│   │   ├── inter-app-communication_specs.md
│   │   ├── nommage_specs.md
│   │   ├── presentation_specs.md
│   │   ├── recepteurs-emetteurs-rfxcom_specs.md
│   │   └── techniques-socle-ha-mqtt_specs.md
│   │       # ⚠️ Chaque fichier réel porte un suffixe de version (ex: techniques-socle-ha-mqtt_specs_v4.9.md).
│   │       # Voir specs/current/ pour la version exacte actuellement en vigueur.
│   ├── archives/           # Versions obsolètes
│   │   └── vX.Y.Z/
│   │       └── [fichiers archivés]
│   └── CHANGELOG.md        # Historique des spécifications
│
├── applications/           # ⭐ NOUVEAU v1.1: TOUTES LES APPLICATIONS ACTIVÉES (y compris le core)
│   ├── core/              # ⭐ Le socle est une application (NE PEUT PAS ÊTRE DÉSACTIVÉ)
│   │   ├── package.json   # Dépendances spécifiques au core
│   │   ├── tsconfig.json
│   │   ├── dist/          # Binaire compilé
│   │   └── src/           # Sources TypeScript
│   │       ├── index.ts   # Bootstrap
│   │       ├── types/    # Interfaces partagées
│   │       ├── infrastructure/ # Config, Logger, Transport
│   │       ├── ha/       # Couche HA (WS + MQTT)
│   │       ├── application/ # AppService, EventBus, SocketBridge
│   │       └── presentation/ # UI du core
│   │
│   ├── rfxcom/           # Application RFXCOM (exemple)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── dist/
│   │   └── src/
│   │       ├── domain/  # RfxComService, ReceiverModules
│   │       └── presentation/ # UI spécifique
│   │
│   └── [autre-app]/      # Autres applications activées
│       ├── package.json
│       ├── tsconfig.json
│       ├── dist/
│       └── src/
│
├── applications_desactivees/ # ⭐ NOUVEAU v1.1: APPLICATIONS DÉSACTIVÉES
│   └── [app-desactivee]/ # Exemple : application désactivée
│       ├── package.json
│       ├── tsconfig.json
│       ├── dist/
│       └── src/
│
├── data/                  # Données persistantes
│   ├── config.yaml       # Configuration globale (socle + paramètres communs)
│   └── [app-name]/       # Données spécifiques par application
│
├── logs/                  # Logs
│   └── [app-name].log    # Logs par application ou globaux
│
├── backups/               # Sauvegardes des programmes
│   ├── programme1_backup_2026-07-12/
│   │   └── ...
│   └── archives/                   # Archives anciennes
│       └── programme1_backup_2025-12-01/
│
├── scripts/               # Scripts utilitaires
│   └── backup.sh
│
└── README.md
```

> **⚠️ RÈGLES CRITIQUES V1.1 :**
> - **Le core (dans `applications/core/`) NE PEUT PAS être désactivé.**
> - L'activation/désactivation des applications se fait **exclusivement** via le sous-menu **"Paramètres Techniques > Gestion des applications"** dans l'UI, ou via déplacement manuel entre `applications/` et `applications_desactivees/`.
> - Chaque application est **autonome** : elle contient ses propres `package.json`, `tsconfig.json`, et `dist/`.
> - La détection des applications est effectuée par `AppService` qui scanne **uniquement** le répertoire `applications/`.

---

---

## 🔧 Procédures Types

### 🔹 Avant toute modification importante

1. **Vérifier** s'il existe des spécifications concernées
2. **Créer une sauvegarde** si modification de masse (>10 fichiers ou >30% du code)
3. **Documenter** le changement dans `CHANGELOG.md` ou le commit
4. **Tester** les modifications avant validation
5. **Valider** la sauvegarde avec `diff`

### 🔹 Pour demander une sauvegarde

```
"Vibe, sauvegarde le répertoire [nom_répertoire] avec la date du jour."
```

### 🔹 Pour restaurer depuis une sauvegarde

1. Vérifier l'intégrité : `diff -r current/ backups/nom_backup/`
2. Copier les fichiers nécessaires
3. Documenter la restauration dans `CHANGELOG.md`

---

## 📚 Gestion des Spécifications

### 10. **Redondances dans les Spécifications**

**Objectif :** Éviter la duplication de contenu entre les documents de spécification.

#### 🔴 Redondances Majeures (À Centraliser)

| **Thème** | **Fichiers Concernés** | **Fichier de Référence** | **Action** |
|----------|----------------------|--------------------------|------------|
| Définition EventBus | `erreurs_specs`, `presentation_specs`, `techniques-socle` | `techniques-socle-ha-mqtt_specs` | Centraliser dans le socle, autres = références |
| Architecture 5 Couches | `guide-nouvelle-application`, `presentation_specs`, `architectural-patterns` | `techniques-socle-ha-mqtt_specs` | Une seule définition complète dans le socle |
| Gestion des Erreurs | `techniques-socle`, `erreurs_specs` | `techniques-socle-ha-mqtt_specs` | Fusionner ou spécialiser `erreurs_specs` pour RFXCOM uniquement |
| Cycle de vie AppService | `techniques-socle`, `guide-nouvelle-application`, `integrationbridge-mqtt-auto` | `techniques-socle-ha-mqtt_specs` | Documentation principale dans le socle |
| Configuration & Zod | `techniques-socle`, `guide-nouvelle-application`, `fonctionnelles-rfxcom` | `techniques-socle-ha-mqtt_specs` | Socle = référence, autres = exemples |
| Événements Socket.io | `techniques-socle`, `presentation_specs`, `guide-nouvelle-application` | `techniques-socle-ha-mqtt_specs` | Centraliser dans le socle |
| MQTT (généralités) | `techniques-socle`, `integrationbridge-mqtt-auto`, `fonctionnelles-rfxcom` | `techniques-socle-ha-mqtt_specs` | Socle = généralités, autres = implémentations |

#### 🟡 Règles de Référencement
- **✅ TOUJOURS** lier vers le document de référence (`techniques-socle-ha-mqtt_specs`) pour les concepts communs
- **❌ JAMAIS** dupliquer une explication complète si elle existe déjà dans le socle
- **✅ Utiliser** des références croisées : `[Voir §X dans techniques-socle-ha-mqtt_specs](#)` (sans numéro de version — chercher le fichier `_vX.Y.md` le plus récent dans `specs/current/`)

---

### 11. **Spécifications Nécessaires par Type de Développement**

#### 📌 Pour TOUTE Nouvelle Application

| **N°** | **Spécification** | **Rôle** | **Obligatoire** |
|--------|-------------------|----------|----------------|
| 1 | `PROMPT_PROJET.md` | Règles de développement et gestion des specs | ✅ Oui |
| 2 | `techniques-socle-ha-mqtt_specs` | **Socle Commun** : Architecture 5 couches, EventBus, Socket.io, MQTT, AppService, RestartManager | ✅ Oui |
| 3 | `nommage_specs` | Conventions de nommage (QUOI/OÙ, taxonomie) | ✅ Oui |
| 4 | `guide-nouvelle-application_specs` | Guide pratique étape par étape | ✅ Oui |

> Ces noms sont **sans numéro de version** : toujours prendre la version la plus récente présente dans `specs/current/` (ex: `techniques-socle-ha-mqtt_specs_v4.9.md`).

#### 📌 Pour Applications Spécifiques

| **Type d'Application** | **Spécifications Additionnelles** | **Cas d'Usage** |
|------------------------|----------------------------------|-----------------|
| **Intégration MQTT** (RFXCOM, Zigbee2MQTT, etc.) | `integrationbridge-mqtt-auto_specs` | Applications intégrant du matériel via MQTT |
| **Application RFXCOM** | `fonctionnelles-rfxcom_specs` + `recepteurs-emetteurs-rfxcom_specs` + `classification-rfxcom_specs` + `implementation-rfxcom_specs` | **Maintenance et développement** spécifique RFXCOM |
| **Application EVOO7** | `fonctionnelles-evoo7_specs` | **Maintenance et développement** spécifique EVOO7 (régulateur de chauffage/PAC VR Electronique) |
| **Application NOMMAGE** | `fonctionnelles-nommage_specs` + `implementation-nommage_specs` | **Maintenance et développement** spécifique NOMMAGE (au-delà des conventions de nommage génériques déjà couvertes par `nommage_specs` §Pour TOUTE Nouvelle Application) |
| **Application ARBREOUQUOI** | `fonctionnelles-arbreouquoi_specs` + `implementation-arbreouquoi_specs` | **Maintenance et développement** spécifique ARBREOUQUOI |
| **Application IA** | `fonctionnelles-ia_specs` | **Maintenance et développement** spécifique IA (émulation Ollama, routage multi-IA, appel d'outils) — à lire avec `fonctionnelles-planificateur_specs` |
| **Application PLANIFICATEUR** | `fonctionnelles-planificateur_specs` | **Maintenance et développement** spécifique PLANIFICATEUR (macros/planifications, déclencheurs, résolution vers un service HA) — à lire avec `fonctionnelles-ia_specs` |
| **Application AREXX** | `fonctionnelles-arexx_specs` | **Maintenance et développement** spécifique AREXX (capteurs température/humidité BS1000/BS500) |
| **Application HAPLAN** | `fonctionnelles-haplan_specs` | **Maintenance et développement** spécifique HAPLAN (plans de maison tactiles, pilotage d'entités HA) |
| **Application RPIGPIO** | `fonctionnelles-rpigpio_specs` | **Maintenance et développement** spécifique RPIGPIO (paramétrage de pins GPIO via mqtt-io, déploiement Docker) |
| **Application TELEINFO** | `fonctionnelles-teleinfo_specs` | **Maintenance et développement** spécifique TELEINFO (compteurs EDF mode historique, agent RPi1 déployé par SSH+systemd) |
| **Application ESPDISPLAY** | `fonctionnelles-espdisplay_specs` + `inter-app-communication_specs` | **Maintenance et développement** spécifique ESPDISPLAY (orchestration du déploiement de firmware sur les écrans ESP/ESPHome, déclenchée par HAPLAN via EventBus générique — voir `fonctionnelles-haplan_specs` §3.6/§8.9) |
| **Supervision multi-machines (SUPERVISOR)** | `fonctionnelles-supervisor_specs` + `techniques-socle-ha-mqtt_specs` §8.5 | Module du **socle** (`applications/core/src/supervisor/`, pas une application sous `applications/`), pas encore implémenté à ce jour (spec de conception v2.0 validée le 15/08/2026 — voir le document pour le détail) — identité machine, une application = un process OS, MQTT comme bus unifié intra+inter-machine, activation/désactivation en direct sans redémarrage du core, interface web unique préservée |
| **UI Avancée** | `presentation_specs` | Applications avec interface complexe |
| **Gestion d'erreurs fine** | `erreurs_specs` | Applications nécessitant une gestion d'erreur spécifique |
| **Patterns Architecturaux** | `architectural-patterns_specs` | Pour comprendre les patterns MQTT/WS globaux |
| **Communication Inter-Applications** | `inter-app-communication_specs` | Toute application (sauf core) exposant ou consommant des capacités d'une autre application |

#### ⚡ Ordre de Lecture Recommandé

```
1️⃣  PROMPT_PROJET.md → Règles de développement
     ↓
2️⃣  techniques-socle-ha-mqtt_specs → Socle Commun (OBLIGATOIRE)
     ↓
3️⃣  nommage_specs → Conventions de nommage
     ↓
4️⃣  guide-nouvelle-application_specs → Guide pratique
     ↓
4️⃣.5  inter-app-communication_specs → Communication inter-applications (obligatoire sauf core)
     ↓
5️⃣  [Spécs Spécifiques] → Selon type d'application
```

#### 🔍 Localisation des Spécifications
- **Spécifications actuelles** : `specs/current/`
- **Versions archivées** : `specs/archives/`
- **Historique des changements** : `specs/CHANGELOG.md`

---

## ⚡ Cas Particuliers

### 🔸 Fichiers Binaires
- Toujours vérifier avec des **checksums** (MD5/SHA1) :
  ```bash
  sha256sum fichier.bin > fichier.bin.sha256
  ```

### 🔸 Bases de Données
- Sauvegarder avec `pg_dump`/`mysqldump` + date dans le nom :
  ```bash
  pg_dump db_name > backups/db_backup_2026-07-12.sql
  ```

### 🔸 Configurations
- **TOUJOURS** sauvegarder AVANT une mise à jour
- Conserver l'ancienne version avec suffixe : `config.old_2026-07-12.conf`

### 🔸 Fichiers Volumineux
- Pour les fichiers >100Mo : compresser en `.tar.gz` ou `.zip`
- Exemple : `data_backup_2026-07-12.tar.gz`

---

## 📝 Templates et Scripts

### 🔹 Script de Sauvegarde (backup.sh)

```bash
#!/bin/bash
# backup.sh - Script pour sauvegarder un répertoire
# Usage: ./backup.sh <répertoire_source> [description]

set -e

if [ -z "$1" ]; then
    echo "Erreur: Spécifiez un répertoire source"
    echo "Usage: $0 <répertoire> [description]"
    exit 1
fi

SOURCE="$1"
DESCRIPTION="${2:-}"
DEST_DIR="backups/$(basename "$SOURCE")_$(date +%Y-%m-%d)"

if [ -n "$DESCRIPTION" ]; then
    DEST_DIR="${DEST_DIR}_${DESCRIPTION}"
fi

# Créer la structure de destination
mkdir -p "$DEST_DIR"

# Copier récursivement
cp -r "$SOURCE"/* "$DEST_DIR/" 2>/dev/null || cp -r "$SOURCE"/. "$DEST_DIR/"

# Renommer les fichiers avec le suffixe de sauvegarde
find "$DEST_DIR" -type f -name "*.backup_*" -prune -o -type f -print | while read -r file; do
    dir=$(dirname "$file")
    base=$(basename "$file")
    ext="${base##*.}"
    name="${base%.*}"
    new_name="${name}_backup_$(date +%Y-%m-%d).${ext}"
    mv "$file" "$dir/$new_name"
done

echo "✅ Sauvegarde créée: $DEST_DIR"
ls -la "$DEST_DIR"
```

### 🔹 Template de Documentation de Sauvegarde

```markdown
---
**Fiche de Sauvegarde**
- **ID :** [auto-généré ou manuel]
- **Source :** `chemin/vers/répertoire/`
- **Destination :** `backups/nom_backup_2026-07-12/`
- **Date :** 2026-07-12
- **Heure :** 14:30:00
- **Raison :** [Refactorisation majeure / Migration / Correctif urgent]
- **Auteur :** [Nom ou identifiant]
- **Validé par :** [Nom ou identifiant]
- **Checksum :** [SHA256 du répertoire]
- **Taille :** [XX Mo/Go]
- **Fichiers :** [nombre de fichiers sauvegardés]
---

**Modifications associées :**
- [ ] Modification de masse
- [ ] Mise à jour de spécifications
- [ ] Correction de bug critique
- [ ] Autre: _______

**Notes :**
```

### 🔹 Commandes Utiles

| Action | Commande |
|--------|----------|
| Sauvegarder un répertoire | `./scripts/backup.sh src/ before_refactor` |
| Lister les sauvegardes | `ls -la backups/` |
| Comparer avec l'original | `diff -r src/ backups/src_backup_2026-07-12/` |
| Vérifier checksum | `sha256sum -c fichier.sha256` |
| Compresser une sauvegarde | `tar -czvf archive.tar.gz backups/nom_backup/` |
| Archiver une sauvegarde | `mv backups/ancien/ backups/archives/ancien_2026-07-12/` |

---

## ⚠️ Points Critiques

- **Ne jamais** supprimer `specs/` ou son contenu
- **Toujours** versionner les fichiers de spécifications
- **Vérifier** les sauvegardes avant de modifier
- **Documenter** chaque sauvegarde (pourquoi, quand, par qui)
- **Ne jamais** modifier les fichiers dans `backups/`
- **Conserver** au minimum 3 versions de chaque programme
- **Valider** les sauvegardes avec `diff` avant toute modification
- **Le core (applications/core/) NE PEUT PAS être désactivé**
- **L'activation/désactivation des applications se fait via le sous-menu "Paramètres Techniques > Gestion des applications" dans l'UI**

---

*Ce fichier doit être lu et respecté avant tout travail sur un projet.*
