/**
 * Publication MQTT + découverte Home Assistant par compteur — remplace hateleinfo2.js
 * (zdidnodeteleinfo), qui publiait directement sur homeassistant/sensor/... avec des libellés
 * français fixes. Ici : publication sur <discoveryPrefix>/sensor/... (par défaut "homeassist", PAS
 * "homeassistant") pour transiter par le pipeline nommage — même convention que zigbee2mqtt/mqtt-io
 * (voir applications/nommage, applications/rpigpio) — avec device.name = "QUOI---OÙ" par compteur,
 * pour que nommage assigne la bonne area et le bon quoi automatiquement.
 *
 * Amélioration par rapport à l'original : state_class ajouté (measurement pour les grandeurs
 * instantanées, total_increasing pour les index de consommation) — absent avant, pourtant requis
 * par HA pour qu'un capteur soit utilisable dans le tableau de bord Énergie.
 */
'use strict';

const mqtt = require('mqtt');

const HA_STATUS_TOPIC = 'homeassistant/status'; // topic réel de HA, indépendant de discoveryPrefix

const SENSORS = [
  { key: 'IINST', label: 'Intensité', unit: 'A', device_class: 'current', state_class: 'measurement' },
  { key: 'PAPP', label: 'Puissance apparente', unit: 'VA', device_class: 'apparent_power', state_class: 'measurement' },
  { key: 'BASE', label: 'Index base', unit: 'Wh', device_class: 'energy', state_class: 'total_increasing' },
  { key: 'HCHC', label: 'Index heures creuses', unit: 'Wh', device_class: 'energy', state_class: 'total_increasing' },
  { key: 'HCHP', label: 'Index heures pleines', unit: 'Wh', device_class: 'energy', state_class: 'total_increasing' }
];

function buildQuoiOuName(compteur) {
  const segments = [];
  const precisDistinct = compteur.lieuPrecis && compteur.lieuPrecis.toLowerCase() !== compteur.lieu.toLowerCase();
  if (precisDistinct) segments.push(compteur.lieuPrecis);
  segments.push(compteur.lieu);
  if (compteur.lieuPere) segments.push(compteur.lieuPere);
  if (compteur.lieuGrandPere) segments.push(compteur.lieuGrandPere);
  return compteur.quoi + '---' + segments.join('--');
}

function createHaPublisher(mqttConfig, discoveryPrefix) {
  const compteursByAdco = {}; // adco (number) -> {quoi, lieu..., quoiOuName}
  const autodiscoverySent = {};
  let client = null;

  function declareCompteurs(compteurs) {
    compteurs.forEach((c) => {
      const adco = Number(c.adco);
      compteursByAdco[adco] = Object.assign({}, c, { quoiOuName: buildQuoiOuName(c) });
    });
  }

  function baseTopicFor(adco) {
    return discoveryPrefix + '/sensor/teleinfo_' + adco;
  }

  function sendAutodiscovery(adco) {
    const compteur = compteursByAdco[adco];
    if (!compteur) return;
    const uniqueIdBase = 'teleinfo_' + adco;
    const baseTopic = baseTopicFor(adco);

    SENSORS.forEach((sensor) => {
      const payload = {
        name: sensor.label,
        state_topic: baseTopic + '/state',
        unique_id: uniqueIdBase + '_' + sensor.key,
        device_class: sensor.device_class,
        state_class: sensor.state_class,
        unit_of_measurement: sensor.unit,
        value_template: '{{ value_json.' + sensor.key + ' }}',
        device: {
          identifiers: ['teleinfo_' + adco],
          name: compteur.quoiOuName,
          manufacturer: 'Teleinfo EDF (mode historique)'
        }
      };
      client.publish(
        discoveryPrefix + '/sensor/' + uniqueIdBase + '_' + sensor.key + '/config',
        JSON.stringify(payload),
        { retain: true }
      );
    });
    autodiscoverySent[adco] = true;
  }

  function publishFrame(frame) {
    if (!frame || !frame.ADCO) return;
    const adco = Number(frame.ADCO);
    if (!compteursByAdco[adco]) {
      console.warn('[ha-publisher] ADCO non déclaré, trame ignorée:', adco);
      return;
    }
    if (!autodiscoverySent[adco]) sendAutodiscovery(adco);

    const payload = {};
    SENSORS.forEach((sensor) => {
      if (frame[sensor.key] !== undefined) payload[sensor.key] = frame[sensor.key];
    });
    client.publish(baseTopicFor(adco) + '/state', JSON.stringify(payload));
  }

  function connect() {
    client = mqtt.connect(mqttConfig.url, {
      username: mqttConfig.user || undefined,
      password: mqttConfig.password || undefined
    });
    client.on('error', (err) => console.error('[ha-publisher] Erreur MQTT:', err.message));
    client.on('connect', () => {
      console.log('[ha-publisher] Connecté au broker MQTT');
      client.subscribe(HA_STATUS_TOPIC);
    });
    client.on('message', (topic, message) => {
      if (topic === HA_STATUS_TOPIC && message.toString() === 'online') {
        console.log('[ha-publisher] HA redémarré — republication de la découverte');
        Object.keys(compteursByAdco).forEach((adco) => sendAutodiscovery(Number(adco)));
      }
    });
  }

  return { declareCompteurs, publishFrame, connect };
}

module.exports = { createHaPublisher, buildQuoiOuName };
