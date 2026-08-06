#!/usr/bin/env node
/**
 * Renomme en masse les appareils zigbee2mqtt vers la convention QUOI---OÙ du projet.
 *
 * Sécurité :
 *  - Revérifie d'abord la liste actuelle des appareils (bridge/devices) et refuse de renommer
 *    si un "from" attendu n'existe plus (évite de renommer sur la base d'un état périmé).
 *  - Demande une confirmation interactive explicite avant toute publication.
 *  - Renomme un appareil à la fois, attend la réponse de zigbee2mqtt avant de passer au suivant.
 *  - Affiche un compte-rendu final (succès/échec par appareil).
 *
 * Usage : node scripts/rename-zigbee-devices.js [baseTopic]
 *
 * Exécuté avec succès le 06/08/2026 contre le zigbee2mqtt restauré sur ha2 (34/34 renommages —
 * 'cuisine--lave vaisselle-ancien' retiré de la liste, ce device n'existait plus). Un nouveau
 * lancement sans modifier RENAMES est un no-op sûr : plus aucun "from" ne correspond à un
 * appareil réel, le script refusera tout (voir Sécurité ci-dessus) plutôt que de renommer deux
 * fois. Garder ce fichier comme trace de la convention appliquée plutôt que le supprimer.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const yaml = require('js-yaml');
const mqtt = require('mqtt');

const baseTopic = process.argv[2] || 'zigbee2mqtt';

// Correspondance ancien nom -> nouveau nom, décidée avec l'utilisateur (voir session).
const RENAMES = [
  ['bibliothèque--baromètre', 'baromètre---bibliothèque--bibliothèque--rez de chaussée'],
  ['blanc--scènes switch', 'scènes switch---blanc'],
  ['bureau--thermostat', 'thermostat---bureau--bureau--1er étage'],
  ["chambre d'ami--thermostat", "thermostat---chambre d'ami--chambre d'ami--1er étage"],
  ['chambre de jo--chevets', 'lumière---chevets--chambre de jo--1er étage'],
  ['chambre de jo--leds', 'lumière---leds--chambre de jo--1er étage'],
  ['chambre de jo--plafonnier', 'lumière---plafonnier--chambre de jo--1er étage'],
  ['chambre de jo--thermostat', 'thermostat---chambre de jo--chambre de jo--1er étage'],
  ['chambre du bas--baromètre', 'baromètre---chambre du bas--chambre du bas--rez de chaussée'],
  ['couloir--escalier-détecteur', 'détecteur---escalier--couloir--1er étage'],
  ['cuisine--four', 'four---cuisine--cuisine--rez de chaussée'],
  ['cuisine--lave vaisselle', 'lave vaisselle---cuisine--cuisine--rez de chaussée'],
  ['cuisine--lumière plan de travail', 'lumière---plan de travail--cuisine--rez de chaussée'],
  ['cuisine--lumière vitrine', 'lumière---vitrine--cuisine--rez de chaussée'],
  ['cuisine--plaques', 'plaques---cuisine--cuisine--rez de chaussée'],
  ['infra--gros ballon', 'gros ballon---maison--maison--rez de chaussée'],
  ['infra--machine à laver', 'machine à laver---maison--maison--rez de chaussée'],
  ['infra--petit ballon', 'petit ballon---maison--maison--rez de chaussée'],
  ['linky--linky', 'compteur---linky--maison--rez de chaussée'],
  ['noir--scènes switch', 'scènes switch---noir'],
  ['salle à manger--bouton lumière du bureau', 'bouton---bureau--salle à manger'],
  ['salle à manger--prise du poêle', 'poêle---salle à manger--salle à manger--rez de chaussée'],
  ['salle à manger--prise lumière bureau', 'lumière---bureau--salle à manger--rez de chaussée'],
  ['salle à manger--thermostat', 'thermostat---salle à manger--salle à manger--rez de chaussée'],
  ['salle de bain du bas--baromètre', 'baromètre---salle de bain du bas--salle de bain du bas--rez de chaussée'],
  ['salle de bain du haut--baromètre', 'baromètre---salle de bain du haut--salle de bain du haut--1er étage'],
  ['salle de bain du haut--bouton', 'bouton---salle de bain du haut'],
  ['salle de bain du haut--infra rouge radiateur', 'infrarouge---radiateur--salle de bain du haut--1er étage'],
  ['salle de bain du haut--lumière', 'lumière---salle de bain du haut--salle de bain du haut--1er étage'],
  ['salle de bain du haut--radiateur', 'radiateur---salle de bain du haut--salle de bain du haut--1er étage'],
  ['salon--infrarouge télévision', 'infrarouge---télévision--salon--rez de chaussée'],
  ['terrasse--lumière', 'lumière---terrasse--terrasse--rez de chaussée'],
  ['toilettes du haut--detecteur', 'détecteur---toilettes du haut--toilettes du haut--1er étage'],
  ['toilettes du haut--plafonnier', 'lumière---plafonnier--toilettes du haut--1er étage']
];

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

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function connect() {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
      clientId: `rename-zigbee-devices-${Date.now()}`,
      username: mqttConfig.username || undefined,
      password: mqttConfig.password || undefined,
      connectTimeout: 8000
    });
    client.on('connect', () => resolve(client));
    client.on('error', reject);
  });
}

function fetchCurrentDevices(client) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout en attente de bridge/devices')), 8000);
    client.subscribe(`${baseTopic}/bridge/devices`, (err) => { if (err) { clearTimeout(timeout); reject(err); } });
    client.on('message', function onMsg(topic, payload) {
      if (topic !== `${baseTopic}/bridge/devices`) return;
      clearTimeout(timeout);
      client.removeListener('message', onMsg);
      try {
        resolve(JSON.parse(payload.toString()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function renameOne(client, from, to) {
  return new Promise((resolve) => {
    const responseTopic = `${baseTopic}/bridge/response/device/rename`;
    const timeout = setTimeout(() => {
      client.unsubscribe(responseTopic);
      resolve({ success: false, error: 'timeout (10s)' });
    }, 10000);

    client.subscribe(responseTopic, () => {
      client.publish(`${baseTopic}/bridge/request/device/rename`, JSON.stringify({ from, to }));
    });

    client.on('message', function onMsg(topic, payload) {
      if (topic !== responseTopic) return;
      let data;
      try { data = JSON.parse(payload.toString()); } catch { return; }
      // zigbee2mqtt répond pour la dernière requête de rename en cours — on ne filtre pas plus
      // finement (pas de correlation id natif côté z2m pour cette route), d'où le renommage
      // strictement séquentiel (un à la fois, jamais en parallèle).
      clearTimeout(timeout);
      client.removeListener('message', onMsg);
      client.unsubscribe(responseTopic);
      resolve({ success: data.status === 'ok', error: data.status !== 'ok' ? (data.error || JSON.stringify(data)) : undefined });
    });
  });
}

async function main() {
  console.log(`Connexion à ${mqttConfig.host}:${mqttConfig.port}...`);
  const client = await connect();

  console.log('Vérification de la liste actuelle des appareils...');
  const currentDevices = await fetchCurrentDevices(client);
  const currentNames = new Set(currentDevices.map((d) => d.friendly_name));

  const missing = RENAMES.filter(([from]) => !currentNames.has(from));
  if (missing.length > 0) {
    console.error(`\n${missing.length} appareil(s) attendu(s) introuvable(s) dans l'état actuel — abandon, rien n'a été modifié :`);
    for (const [from] of missing) console.error(`  - "${from}"`);
    client.end(true);
    process.exit(1);
  }

  console.log(`\n${RENAMES.length} renommages prévus :\n`);
  for (const [from, to] of RENAMES) console.log(`  ${from}\n    -> ${to}`);

  const answer = await ask(`\nConfirmer les ${RENAMES.length} renommages sur le zigbee2mqtt réel ? (taper "oui" pour continuer) `);
  if (answer.trim().toLowerCase() !== 'oui') {
    console.log('Annulé — rien n\'a été modifié.');
    client.end(true);
    process.exit(0);
  }

  const results = [];
  for (const [from, to] of RENAMES) {
    process.stdout.write(`Renommage "${from}" -> "${to}"... `);
    const result = await renameOne(client, from, to);
    console.log(result.success ? 'OK' : `ÉCHEC (${result.error})`);
    results.push({ from, to, ...result });
  }

  const failures = results.filter((r) => !r.success);
  console.log(`\n${results.length - failures.length}/${results.length} renommages réussis.`);
  if (failures.length > 0) {
    console.log('Échecs :');
    for (const f of failures) console.log(`  - "${f.from}": ${f.error}`);
  }

  client.end(true);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Erreur:', err.message);
  process.exit(1);
});
