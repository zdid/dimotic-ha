# Bibliothèque d'Entités Améliorées

Cette bibliothèque fournit une nouvelle architecture pour représenter les entités Home Assistant sur le plan avec une meilleure gestion des dimensions, du positionnement et de l'affichage des valeurs.

## Architecture

### Classe de Base : `BaseEntity`

La classe `BaseEntity` étend `HAObject` et fournit les fonctionnalités suivantes :

- **Gestion des dimensions** : Chaque entité a des dimensions définies (largeur, hauteur)
- **Affichage des valeurs** : Système standardisé pour afficher les valeurs des capteurs
- **Styles visuels** : Plusieurs styles disponibles (icon, card, gauge, slider)
- **Schéma de couleurs** : Personnalisation des couleurs pour chaque entité
- **Éléments standardisés** : Méthodes pour créer des titres, icônes, indicateurs d'état, etc.

### Classes Spécifiques

#### `EnhancedLightObject`
- **Style** : Card
- **Fonctionnalités** : 
  - Affichage de l'état (ON/OFF)
  - Affichage de la luminosité
  - Bouton de contrôle pour allumer/éteindre
  - Indicateur visuel d'état

#### `EnhancedTemperatureSensor`
- **Style** : Gauge
- **Fonctionnalités** :
  - Affichage de la température avec unité
  - Barre visuelle représentant la température
  - Indicateur d'état (normal, avertissement, erreur)
  - Changement de couleur en fonction de la température

#### `GenericEntity`
- **Style** : Icon (par défaut)
- **Fonctionnalités** :
  - Représentation générique pour tout type d'entité
  - Affichage dynamique des attributs
  - Personnalisable via le schéma de couleurs

## Utilisation

### Création d'une Entité

```typescript
import { EnhancedObjectFactory } from './EnhancedObjectFactory';
import { DataService } from '../../services/DataService';

// Créer un service de commande (optionnel)
const commandService = new DataService();

// Créer une entité lumière
const lightEntity = EnhancedObjectFactory.createObject(
  'light.living_room_light',
  'light',
  { x: 0.5, y: 0.5 }, // Position (0-1)
  { state: 'on', attributes: { brightness: 150 } }, // État initial
  commandService,
  { width: 80, height: 80 } // Dimensions personnalisées (optionnel)
);

// Créer un capteur de température
const tempSensor = EnhancedObjectFactory.createObject(
  'sensor.living_room_temperature',
  'sensor',
  { x: 0.3, y: 0.7 },
  { state: '22.5' },
  commandService
);
```

### Personnalisation

```typescript
// Changer le style visuel
lightEntity.setVisualStyle('card'); // ou 'icon', 'gauge', 'slider'

// Changer les dimensions
lightEntity.setDimensions(100, 100);

// Changer le schéma de couleurs
lightEntity.setColorScheme({
  primary: '#FF5722',
  secondary: '#FF9800',
  background: '#FFFFFF',
  text: '#333333'
});

// Ajouter des valeurs à afficher
lightEntity.setDisplayValue('power', '45W');
lightEntity.setDisplayValue('mode', 'warm');
```

### Intégration avec FloorPlan

```typescript
import { FloorPlan } from '../FloorPlan';
import { EnhancedObjectFactory } from './objects/EnhancedObjectFactory';

// Créer le plan
const floorPlanContainer = document.getElementById('floorplan-container');
const floorPlan = new FloorPlan(floorPlanContainer);

// Charger le plan
floorPlan.loadPlan('path/to/floorplan.png');

// Ajouter des entités
const light = EnhancedObjectFactory.createObject(
  'light.kitchen_light',
  'light',
  { x: 0.6, y: 0.4 },
  { state: 'off' }
);

floorPlan.addObject(light);

// Mettre à jour l'état d'une entité
light.updateState({ state: 'on', attributes: { brightness: 200 } });
```

## Dimensions par Défaut

La fabrique utilise des dimensions par défaut pour chaque type d'entité :

- **Lumière** : 80x80 px
- **Capteur de température** : 100x100 px
- **Thermostat** : 120x100 px
- **Volet/Store** : 90x90 px
- **Générique** : 70x70 px

## Styles Visuels

### Icon
Style minimaliste avec une icône et des valeurs de base.

### Card
Style carte avec fond, bordure et ombre, adapté pour les entités interactives.

### Gauge
Style jauge avec indicateurs visuels, idéal pour les capteurs et les valeurs numériques.

### Slider
Style avec curseur, adapté pour les entités avec des valeurs ajustables.

## Variables CSS

Les entités utilisent des variables CSS pour la personnalisation :

```css
--entity-primary-color: couleur principale
--entity-secondary-color: couleur secondaire
--entity-background-color: couleur de fond
--entity-text-color: couleur du texte
```

## Migration depuis l'Ancienne Architecture

Pour migrer depuis les anciennes classes (`LightObject`, `TemperatureSensor`, etc.) :

1. **Remplacer les imports** :
   ```typescript
   // Ancien
   import { LightObject } from './LightObject';
   
   // Nouveau
   import { EnhancedObjectFactory } from './EnhancedObjectFactory';
   ```

2. **Utiliser la fabrique** :
   ```typescript
   // Ancien
   const light = new LightObject('light.living_room', { x: 0.5, y: 0.5 });
   
   // Nouveau
   const light = EnhancedObjectFactory.createObject(
     'light.living_room',
     'light',
     { x: 0.5, y: 0.5 }
   );
   ```

3. **Mettre à jour les styles** :
   - Ajouter les nouveaux styles CSS
   - Supprimer les anciens styles spécifiques

## Exemples Complets

### Exemple 1 : Lumière avec Commande

```typescript
const light = EnhancedObjectFactory.createObject(
  'light.bedroom_light',
  'light',
  { x: 0.2, y: 0.3 },
  { state: 'off' },
  commandService
);

// Ajouter au plan
floorPlan.addObject(light);

// Mettre à jour l'état
light.updateState({ state: 'on', attributes: { brightness: 180 } });

// Gérer les actions
light.handleAction('toggle'); // Basculer l'état
```

### Exemple 2 : Capteur de Température avec Alertes

```typescript
const tempSensor = EnhancedObjectFactory.createObject(
  'sensor.outside_temperature',
  'sensor',
  { x: 0.8, y: 0.1 },
  { state: '5.2' },
  commandService,
  { width: 120, height: 80 }
);

// Personnaliser les couleurs pour les températures froides
tempSensor.setColorScheme({
  primary: '#2196F3', // Bleu
  secondary: '#03A9F4', // Bleu clair
});

// Ajouter au plan
floorPlan.addObject(tempSensor);

// Mettre à jour avec une température normale
tempSensor.updateState({ state: '22.5' });
```

## Bonnes Pratiques

1. **Dimensions cohérentes** : Utilisez des dimensions similaires pour les entités du même type
2. **Couleurs significatives** : Utilisez des schémas de couleurs qui ont du sens (rouge pour chaud, bleu pour froid, etc.)
3. **Styles appropriés** : Choisissez le style visuel en fonction du type d'entité
4. **Valeurs pertinentes** : N'affichez que les valeurs les plus importantes pour éviter la surcharge
5. **Performance** : Limitez le nombre de valeurs affichées pour les entités avec beaucoup d'attributs

## Extensibilité

Pour ajouter un nouveau type d'entité :

1. **Créer une nouvelle classe** qui étend `BaseEntity`
2. **Implémenter les méthodes abstraites** : `renderEntity()`, `updateDisplay()`, `handleAction()`
3. **Ajouter la logique spécifique** dans la fabrique `EnhancedObjectFactory`
4. **Ajouter les styles CSS** correspondants

Exemple pour un nouveau type `EnhancedThermostat` :

```typescript
import { BaseEntity } from './BaseEntity';

export class EnhancedThermostat extends BaseEntity {
  // Implémentation spécifique pour les thermostats
  // ...
}
```

Puis ajouter dans la fabrique :

```typescript
if (entity_id.startsWith('climate.')) {
  return new EnhancedThermostat(entity_id, position, finalDimensions, commandService);
}
```

## Conclusion

Cette bibliothèque offre une approche plus structurée et flexible pour représenter les entités Home Assistant sur le plan. Elle permet une meilleure personnalisation, une représentation visuelle plus riche et une gestion plus cohérente des dimensions et des valeurs affichées.