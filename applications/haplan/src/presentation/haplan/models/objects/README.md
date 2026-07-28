# Bibliothèque d'Entités Améliorées pour Home Assistant Floor Plan

## 🚀 Introduction

Cette bibliothèque fournit une nouvelle architecture pour représenter les entités Home Assistant sur les plans d'étage avec une meilleure gestion des dimensions, du positionnement et de l'affichage des valeurs.

**Problème résolu** : La représentation graphique actuelle des entités ne convient pas du tout. Cette bibliothèque offre une solution structurée et extensible.

## 🎯 Fonctionnalités Clés

### 1. **Gestion des Dimensions**
- Chaque entité a des dimensions définies (largeur × hauteur)
- Dimensions par défaut adaptées à chaque type d'entité
- Personnalisation facile des dimensions

### 2. **Affichage des Valeurs**
- Système standardisé pour afficher les valeurs des capteurs
- Badges de valeurs avec libellés et unités
- Gestion dynamique des valeurs à afficher

### 3. **Styles Visuels**
- **Icon** : Style minimaliste pour les entités simples
- **Card** : Style carte pour les entités interactives
- **Gauge** : Style jauge pour les valeurs numériques
- **Slider** : Style avec curseur pour les valeurs ajustables

### 4. **Schéma de Couleurs**
- Personnalisation complète des couleurs
- Variables CSS pour une cohérence visuelle
- Schémas de couleurs par défaut adaptés à chaque type

### 5. **Éléments Standardisés**
- Méthodes utilitaires pour créer des éléments UI
- Titres, icônes, indicateurs d'état, boutons, etc.
- Cohérence visuelle entre toutes les entités

## 📦 Structure de la Bibliothèque

```
models/objects/
├── BaseEntity.ts              # Classe de base étendant HAObject
├── EnhancedLightObject.ts     # Lumière améliorée
├── EnhancedTemperatureSensor.ts # Capteur de température amélioré
├── EnhancedObjectFactory.ts   # Fabrique d'objets améliorée
├── ENTITY_LIBRARY_DOCUMENTATION.md # Documentation détaillée
├── example-usage.ts           # Exemples d'utilisation
└── README.md                  # Ce fichier
```

## 🔧 Installation et Utilisation

### 1. Importer la fabrique

```typescript
import { EnhancedObjectFactory } from './models/objects/EnhancedObjectFactory';
import { DataService } from '../../services/DataService';
```

### 2. Créer une entité

```typescript
const commandService = new DataService();

const light = EnhancedObjectFactory.createObject(
  'light.living_room_light',
  'light',
  { x: 0.5, y: 0.5 }, // Position (0-1)
  { state: 'on', attributes: { brightness: 150 } }, // État initial
  commandService,
  { width: 80, height: 80 } // Dimensions (optionnel)
);
```

### 3. Personnaliser l'entité

```typescript
// Changer le style visuel
light.setVisualStyle('card');

// Changer les dimensions
light.setDimensions(100, 100);

// Changer les couleurs
light.setColorScheme({
  primary: '#FF5722',
  secondary: '#FF9800',
  background: '#FFFFFF',
  text: '#333333'
});

// Ajouter des valeurs à afficher
light.setDisplayValue('power', '45W');
light.setDisplayValue('mode', 'warm');
```

### 4. Intégrer avec FloorPlan

```typescript
import { FloorPlan } from '../FloorPlan';

const floorPlan = new FloorPlan(document.getElementById('floorplan-container'));
floorPlan.addObject(light);
```

## 🎨 Styles Visuels Disponibles

| Style | Description | Utilisation Typique |
|-------|-------------|---------------------|
| `icon` | Minimaliste avec icône | Entités simples, capteurs basiques |
| `card` | Carte avec fond et bordure | Lumières, interrupteurs, entités interactives |
| `gauge` | Jauge avec indicateurs visuels | Capteurs de température, humidité, qualité d'air |
| `slider` | Avec curseur de contrôle | Entités avec valeurs ajustables |

## 📊 Dimensions par Défaut

| Type d'Entité | Dimensions | Style par Défaut |
|---------------|------------|------------------|
| Lumière | 80×80 px | Card |
| Capteur de température | 100×100 px | Gauge |
| Thermostat | 120×100 px | Gauge |
| Volet/Store | 90×90 px | Card |
| Générique | 70×70 px | Icon |

## 🎯 Avantages par Rapport à l'Ancienne Architecture

### ✅ Améliorations

1. **Standardisation** : Toutes les entités suivent le même modèle
2. **Flexibilité** : Personnalisation facile des dimensions et styles
3. **Richesse visuelle** : Affichage de multiples valeurs et indicateurs
4. **Cohérence** : Schéma de couleurs unifié
5. **Extensibilité** : Facile à étendre avec de nouveaux types
6. **Maintenabilité** : Code plus organisé et réutilisable

### ❌ Problèmes Résolus

- Représentation graphique limitée des entités
- Manque de standardisation entre les types d'entités
- Gestion incohérente des dimensions
- Affichage limité des valeurs des capteurs
- Difficulté à personnaliser l'apparence

## 🔄 Migration depuis l'Ancienne Architecture

### Avant
```typescript
import { LightObject } from './LightObject';
const light = new LightObject('light.living_room', { x: 0.5, y: 0.5 });
```

### Après
```typescript
import { EnhancedObjectFactory } from './EnhancedObjectFactory';
const light = EnhancedObjectFactory.createObject(
  'light.living_room',
  'light',
  { x: 0.5, y: 0.5 }
);
```

## 🧪 Exemples

Voir [`example-usage.ts`](example-usage.ts) pour des exemples complets d'utilisation.

## 📚 Documentation Complète

Consultez [`ENTITY_LIBRARY_DOCUMENTATION.md`](ENTITY_LIBRARY_DOCUMENTATION.md) pour une documentation détaillée incluant :

- Architecture complète
- API détaillée
- Exemples avancés
- Bonnes pratiques
- Guide d'extensibilité

## 🎨 Personnalisation CSS

Les entités utilisent des variables CSS pour une personnalisation facile :

```css
--entity-primary-color: couleur principale
--entity-secondary-color: couleur secondaire  
--entity-background-color: couleur de fond
--entity-text-color: couleur du texte
```

Voir [`styles.css`](../../styles/styles.css) pour les styles complets.

## 🚀 Extensibilité

Pour ajouter un nouveau type d'entité :

1. Créer une classe qui étend `BaseEntity`
2. Implémenter `renderEntity()`, `updateDisplay()`, `handleAction()`
3. Ajouter la logique dans `EnhancedObjectFactory`
4. Ajouter les styles CSS correspondants

Exemple :
```typescript
class EnhancedThermostat extends BaseEntity {
  // Implémentation spécifique
}
```

## 📈 Roadmap

- [x] Classe de base `BaseEntity`
- [x] Lumière améliorée
- [x] Capteur de température amélioré
- [x] Fabrique d'objets améliorée
- [x] Styles CSS complets
- [x] Documentation détaillée
- [x] Exemples d'utilisation
- [ ] Thermostat amélioré
- [ ] Volet/Store amélioré
- [ ] Capteur d'humidité amélioré
- [ ] Intégration complète avec l'interface existante

## 🤝 Contribution

Les contributions sont les bienvenues ! Voir [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) pour les directives.

## 📝 Licence

Ce projet est sous licence MIT. Voir [`LICENSE`](../../../LICENSE) pour plus de détails.

---

**💡 Conseil** : Commencez par explorer les exemples dans `example-usage.ts` pour voir la bibliothèque en action !