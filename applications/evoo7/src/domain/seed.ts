/**
 * Transforme le JSON source `seed/evoo7_donnees.json` (43 données EVOO7, capturées et enrichies
 * depuis http://192.168.1.55:8082 — voir plan d'implémentation EVOO7) en configuration initiale
 * du fichier centralisé config-evoo7-donnees-v1.0.yaml.
 *
 * Champs figés (updatable, isConfigData) dérivés une fois ici, jamais recalculés ensuite — le
 * JSON source n'est plus relu après le premier démarrage (voir ConfigFileManager.load()).
 */

import * as fs from 'node:fs';
import type { Evoo7DataDefinition, Evoo7DonneesConfig } from './types';

interface RawValeurPossible {
  code: string;
  libelle: string;
}

interface RawDonnee {
  id: string;
  consultation: boolean;
  mise_a_jour: boolean | null;
  description: string;
  min?: number;
  max?: number;
  valeurs_possibles?: RawValeurPossible[];
  topic_sensor: string;
  format_message_sensor: string;
}

interface RawEvoo7Json {
  donnees: RawDonnee[];
}

export function seedFromJsonFile(jsonPath: string): Evoo7DonneesConfig {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const parsed = JSON.parse(raw) as RawEvoo7Json;

  const evoo7_donnees: Record<string, Evoo7DataDefinition> = {};

  for (const d of parsed.donnees) {
    evoo7_donnees[d.id] = {
      id: d.id,
      description: d.description,
      min: d.min,
      max: d.max,
      valeursPossibles: d.valeurs_possibles?.map((v) => ({ code: v.code, libelle: v.libelle })),

      updatable: d.mise_a_jour !== null,
      isConfigData: !d.consultation,

      consultation: d.consultation,
      miseAJour: d.mise_a_jour === true,
      topicSensor: d.topic_sensor,
      formatMessageSensor: d.format_message_sensor
    };
  }

  return { evoo7_donnees, thermostat: { enabled: false, allowCooling: false } };
}
