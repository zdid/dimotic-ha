#!/usr/bin/env node
/**
 * Liste les appareils zigbee2mqtt connus (lecture seule — ne modifie rien).
 *
 * Se connecte au broker MQTT configuré dans data/nommage/config.yaml (première source de
 * sources[], même broker que celui utilisé par l'app Nommage) et lit le topic retained
 * <baseTopic>/bridge/devices publié par zigbee2mqtt.
 *
 * Usage : node scripts/list-zigbee-devices.js [baseTopic]
 *   baseTopic — topic de base de zigbee2mqtt (mqtt.base_topic dans sa propre config),
 *               PAS le topicPrefix de découverte HA. Défaut : "zigbee2mqtt".
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const mqtt = require('mqtt');

const baseTopic = process.argv[2] || 'zigbee2mqtt';

// Depuis la restructuration data/ (v4.14, 24/07/2026), la config de Nommage est isolée dans son
// propre fichier (objet nu, plus de clé d'enveloppe "nommage"). L'id de la source zigbee a aussi
// été renommé depuis ('zigbee' -> le hostname réel du broker) — on ne filtre plus par id, ce
// fichier ne contenant de toute façon qu'une seule source, dédiée à zigbee2mqtt.
const configPath = path.join(process.env.PROJECT_ROOT || path.join(__dirname, '..', '..', '..'), 'data', 'nommage', 'config.yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

const zigbeeSource = (config.sources || [])[0];
if (!zigbeeSource) {
  console.error('Aucune source trouvée dans sources[] (data/nommage/config.yaml).');
  process.exit(1);
}

const mqttConfig = zigbeeSource.mqtt;
console.log(`Connexion à ${mqttConfig.host}:${mqttConfig.port} (topic de base zigbee2mqtt: "${baseTopic}")...`);

const client = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
  clientId: `list-zigbee-devices-${Date.now()}`,
  username: mqttConfig.username || undefined,
  password: mqttConfig.password || undefined,
  connectTimeout: 8000
});

const timeout = setTimeout(() => {
  console.error(`Aucune réponse sur ${baseTopic}/bridge/devices après 8s — le topic de base est peut-être différent (essaie: node scripts/list-zigbee-devices.js <base_topic>).`);
  client.end(true);
  process.exit(1);
}, 8000);

client.on('connect', () => {
  client.subscribe(`${baseTopic}/bridge/devices`, (err) => {
    if (err) {
      console.error('Erreur de souscription:', err.message);
      process.exit(1);
    }
  });
});

client.on('message', (topic, payload) => {
  clearTimeout(timeout);

  let devices;
  try {
    devices = JSON.parse(payload.toString());
  } catch (e) {
    console.error('Payload non-JSON reçu:', e.message);
    process.exit(1);
  }

  const actionable = devices.filter((d) => d.type !== 'Coordinator');
  console.log(`\n${actionable.length} appareil(s) (hors coordinateur) :\n`);
  console.log('friendly_name'.padEnd(30), 'ieee_address'.padEnd(20), 'type'.padEnd(12), 'modèle');
  console.log('-'.repeat(90));

  for (const d of actionable.sort((a, b) => a.friendly_name.localeCompare(b.friendly_name))) {
    const model = d.definition ? `${d.definition.vendor || ''} ${d.definition.model || ''}`.trim() : '(interview en cours ?)';
    console.log(
      String(d.friendly_name).padEnd(30),
      String(d.ieee_address).padEnd(20),
      String(d.type).padEnd(12),
      model
    );
  }

  console.log(`\nTerminé. Rien n'a été modifié (lecture seule).`);
  client.end(true);
  process.exit(0);
});

client.on('error', (err) => {
  console.error('Erreur MQTT:', err.message);
  process.exit(1);
});
