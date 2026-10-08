/**
 * Jeu fixe et générique d'outils déclarés à Mistral (specs §7) — contrat structurel strict (format
 * JSON function-calling de l'API Mistral), volontairement en code plutôt que dans
 * regles_mistral.txt : un schéma malformé ferait rejeter la requête par l'API, contrairement au
 * texte des règles qui tolère l'imprécision.
 */

import type { MistralToolSchema } from './MistralClient';

export const IA_TOOLS: MistralToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'lister_entites',
      description: "Liste les entités Home Assistant connues correspondant à un filtre QUOI/OÙ (les deux paramètres sont optionnels — absents, retourne toutes les entités).",
      parameters: {
        type: 'object',
        properties: {
          quoi: { type: 'string', description: 'Catégorie QUOI (ex: "lumière", "température")' },
          lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux à filtrer. Plusieurs lieux = l\'un OU l\'autre (ex: ["salon", "cuisine"]). Un repère précis (plafonnier, chevet) avec un lieu = les deux à la fois (ex: ["plafonnier", "chambre"] ou ["plafonnier de la chambre"]).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'obtenir_etat',
      description: "État actuel d'une ou plusieurs entités correspondant à un filtre QUOI/OÙ.",
      parameters: {
        type: 'object',
        properties: {
          quoi: { type: 'string', description: 'Catégorie QUOI (ex: "lumière")' },
          lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux à filtrer. Plusieurs lieux = l\'un OU l\'autre (ex: ["salon", "cuisine"]). Un repère précis (plafonnier, chevet) avec un lieu = les deux à la fois (ex: ["plafonnier", "chambre"] ou ["plafonnier de la chambre"]).' }
        },
        required: ['quoi']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'executer_action',
      description: "Exécute une action domotique immédiate (ex: allumer/éteindre/régler). Mêmes champs qu'un ActionNode : verbe, quoi, lieux, valeur optionnelle.",
      parameters: {
        type: 'object',
        properties: {
          verbe: { type: 'string', description: 'Verbe d\'action (ex: "allumer", "éteindre", "régler")' },
          quoi: { type: 'string', description: 'Catégorie QUOI ciblée (ex: "lumière")' },
          lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux ciblés (ex: ["salon"])' },
          valeur: { description: 'Valeur associée si le verbe en porte une (ex: pourcentage, température)' }
        },
        required: ['verbe', 'quoi', 'lieux']
      }
    }
  }
];
