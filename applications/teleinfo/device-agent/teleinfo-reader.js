/**
 * Lecture d'une trame téléinformation EDF, mode historique (1200 bauds, 7E1) — adapté de
 * edfteleinfo.js (zdidnodeteleinfo, prouvé en conditions réelles sur ce matériel exact).
 *
 * Simplifié par rapport à l'original (demande utilisateur, 12/08/2026 — "application plus
 * propre") : seul le mode alterné (2 compteurs sur une même ligne série, bascule GPIO entre
 * chaque trame) est conservé, les modes CONTINU/ALADEMANDE (usage 1 seul compteur, jamais utilisés
 * ici) sont retirés.
 *
 * Protocole (norme Enedis mode historique) :
 * - Trame = suite de lignes "ÉTIQUETTE VALEUR CHECKSUM", séparées par CR-ETX-STX-LF.
 * - Checksum = (somme des codes ASCII de "ÉTIQUETTE VALEUR") & 0x3F, + 0x20.
 * - Trame "longue" (avec OPTARIF, tarif/contrat) vs trame "courte" — on n'exploite que les longues.
 * - ADCO = numéro de série du compteur, présent dans chaque trame, sert à identifier quel
 *   compteur a répondu (indépendant du timing de la bascule GPIO — plus robuste).
 */
'use strict';

// serialport@9 expose la classe directement (pas de named export {SerialPort} — API changée en
// v10, mais v9 est la version dont la compilation native (bindings) est déjà prouvée sur ce RPi1
// exact, voir device-agent/README.md) : constructeur positionnel (path, options), pas {path, ...}.
const SerialPort = require('serialport');

const FRAME_DELIMITER = String.fromCharCode(13, 3, 2, 10); // CR ETX STX LF
const MAX_ANOMALIES = 15;
// ⭐ 05/09/2026 (demande utilisateur) — relevé de 5s à 25s : 5s s'est montré trop court en
// conditions réelles (timeouts systématiques observés sur les 2 positions), sans qu'on sache
// encore si c'est le vrai câblage physique qui est en cause ou juste une marge insuffisante.
const HARD_TIMEOUT_MS = 25000;

function decodeLine(rawLine, frame) {
  const SEPARATOR = ' ';
  if (rawLine.length < 2) return true;

  const checksum = rawLine.charCodeAt(rawLine.length - 1);
  const body = rawLine.substring(0, rawLine.length - 1);
  const parts = body.split(SEPARATOR);

  let sum = 0;
  for (let i = 0; i < body.length - 1; i++) {
    sum += body.charCodeAt(i);
  }
  sum = (sum & 63) + 32;

  if (sum !== checksum || (parts.length !== 3 && parts.length !== 4)) {
    return true; // anomalie
  }

  const value = parts[1 + (parts.length === 4 ? 1 : 0)];
  const numeric = Number(value);
  frame[parts[0]] = isNaN(numeric) ? value : numeric;
  return false;
}

/**
 * Lit une trame longue complète sur `port`, puis referme le port et bascule le GPIO — que la
 * lecture ait réussi ou échoué (anomalie/timeout). Une seule tentative par appel : c'est
 * `teleinfo-service.js` qui boucle indéfiniment en rappelant cette fonction.
 *
 * @param {string} port chemin du device série (ex: /dev/ttyAMA0)
 * @param {(err: string|null, frame: object|null) => void} onFrame
 * @param {() => void} onSwitch appelé après fermeture du port, avant le prochain appel
 */
function readOneFrame(port, onFrame, onSwitch, debug) {
  let serialPort;
  let anomalies = 0;
  let settled = false;
  let bytesReceived = 0;
  const log = debug ? (...args) => console.log('[teleinfo-reader]', ...args) : () => {};

  const hardTimeout = setTimeout(() => {
    log(`timeout — ${bytesReceived} octets reçus sur ce cycle avant expiration`);
    finish('timeout de lecture (25s)', null);
  }, HARD_TIMEOUT_MS);

  log('ouverture du port', port);

  function finish(err, frame) {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimeout);
    try {
      if (serialPort && serialPort.isOpen) serialPort.close();
    } catch (e) {
      // déjà fermé, sans importance
    }
    onSwitch();
    onFrame(err, frame);
  }

  serialPort = new SerialPort(port, {
    baudRate: 1200,
    dataBits: 7,
    parity: 'even',
    stopBits: 1,
    autoOpen: true
  });

  serialPort.on('open', () => log('port ouvert'));

  serialPort.on('error', (err) => {
    log('erreur port série:', err.message || String(err));
    finish(err.message || String(err), null);
  });

  // ⭐ 12/08/2026 (bug trouvé en test réel — vérifié par capture série brute) : FRAME_DELIMITER
  // (CR-ETX-STX-LF) ne sépare que les TRAMES entre elles, pas les lignes à l'intérieur d'une même
  // trame (celles-ci sont juste séparées par CR-LF classique) — un découpage à un seul niveau sur
  // FRAME_DELIMITER livrait donc un bloc de plusieurs lignes collées à decodeLine(), qui échouait
  // systématiquement son checksum (calculé pour une seule ligne). D'où les "anomalie de lecture:
  // timeout" en boucle malgré des données réelles bien reçues sur le port. Même défaut évité côté
  // edfteleinfo.js d'origine par un split('\r\n') supplémentaire dans traitData() — repris ici.
  let buffer = '';
  serialPort.on('data', (chunk) => {
    bytesReceived += chunk.length;
    log(`${chunk.length} octets reçus (total cycle: ${bytesReceived})`);
    buffer += chunk.toString('latin1');
    let idx;
    while ((idx = buffer.indexOf(FRAME_DELIMITER)) !== -1) {
      const frameBlob = buffer.substring(0, idx);
      buffer = buffer.substring(idx + FRAME_DELIMITER.length);
      if (!frameBlob) continue;

      const frame = {};
      const rawLines = frameBlob.split('\r\n').filter(Boolean);
      log(`trame candidate: ${rawLines.length} ligne(s)`);
      rawLines.forEach((rawLine) => {
        const isBad = decodeLine(rawLine, frame);
        if (isBad) {
          anomalies++;
          log(`ligne rejetée (checksum/format): ${JSON.stringify(rawLine)}`);
        }
      });

      if (frame.ADCO && frame.OPTARIF) {
        log('trame longue valide, ADCO:', frame.ADCO);
        finish(null, frame);
        return;
      }

      log('trame incomplète (ADCO/OPTARIF manquant), champs vus:', Object.keys(frame));

      if (anomalies > MAX_ANOMALIES) {
        finish(`${MAX_ANOMALIES} anomalies consécutives`, null);
        return;
      }
    }
  });
}

module.exports = { readOneFrame };
