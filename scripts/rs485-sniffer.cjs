#!/usr/bin/env node
// =============================================================================
// Écoute passive d'un bus RS485 (aucune trame émise) — reconstitue et décode les
// trames Modbus RTU vues sur le fil, sans jouer le rôle de maître.
//
// Contexte (14/09/2026) : compteur DDZY422-D2 chez noisy, protocole local jamais
// débloqué en interrogation active (AcknowledgeError systématique, cf. TODO.md).
// Le module WiFi du compteur dialogue en interne avec le compteur sur les mêmes
// bornes A/B (LED "COM" du guide Huawei) — en branchant un deuxième adaptateur
// RS485 EN PARALLÈLE sur ce bus (A-A, B-B, rien à débrancher) et en écoutant
// sans jamais émettre, on capture le vrai trafic Modbus RTU du module WiFi vers
// le compteur : adresse esclave réelle, registres réellement interrogés, trames
// de réponse réelles — sans deviner.
//
// ⚠️ Ce script n'écrit JAMAIS sur le port série (aucun appel à port.write) — ne
// PAS ajouter de code d'émission sans y réfléchir à deux fois : sur un bus
// RS485 multi-drop, émettre en même temps qu'un maître légitime provoque une
// collision et peut perturber le fonctionnement réel du compteur.
//
// Découpage en trames : détection par silence inter-octets (règle Modbus RTU —
// silence ≥ 3.5 temps-caractère = nouvelle trame), pas par un motif fixe. Le
// CRC16 Modbus est vérifié pour chaque trame candidate — une trame CRC invalide
// est affichée quand même (marquée) mais peut indiquer un mauvais débit/format
// ou une coupure en plein milieu (capture démarrée en cours de trame).
//
// Usage :
//   node rs485-sniffer.cjs [device] [baudRate] [dataBits] [parity] [stopBits]
//   node rs485-sniffer.cjs /dev/ttyUSB1 9600 8 none 1
//
// Valeurs par défaut : /dev/ttyUSB1, 9600, 8, none, 1 — à ajuster une fois sur
// site si aucune trame valide n'apparaît (tester d'autres débits courants :
// 4800/19200/38400 ; le DDSU666H de ce soir était en 8-N-2, essayer aussi 2
// bits de stop si rien ne sort en 1).
//
// Dépendance : paquet npm `serialport` (déjà présent dans l'image
// ghcr.io/modbus2mqtt/modbus2mqtt, réutilisée pour exécuter ce script — voir
// TODO.md pour la commande `docker run` de test du DDSU ce soir, même patron :
//   docker run --rm --device=/dev/ttyUSB1 \
//     -v $(pwd)/scripts/rs485-sniffer.cjs:/usr/local/lib/node_modules/modbus2mqtt/sniff.cjs \
//     -w /usr/local/lib/node_modules/modbus2mqtt --entrypoint node \
//     ghcr.io/modbus2mqtt/modbus2mqtt:latest sniff.cjs /dev/ttyUSB1 9600
// =============================================================================

const { SerialPort } = require("serialport");

const device = process.argv[2] || "/dev/ttyUSB1";
const baudRate = parseInt(process.argv[3] || "9600", 10);
const dataBits = parseInt(process.argv[4] || "8", 10);
const parityArg = (process.argv[5] || "none").toLowerCase();
const stopBits = parseInt(process.argv[6] || "1", 10);

// Temps-caractère à ce débit (11 bits/octet en 8-N-1 approximatif, suffisant
// pour le calcul du seuil de silence — pas besoin d'exactitude au bit près).
const charTimeMs = (11 / baudRate) * 1000;
const silenceThresholdMs = Math.max(4, charTimeMs * 3.5);

console.log(`Écoute passive sur ${device} @ ${baudRate} ${dataBits}${parityArg[0].toUpperCase()}${stopBits} — seuil de silence ${silenceThresholdMs.toFixed(1)}ms`);
console.log("Ctrl+C pour arrêter. Aucune trame n'est émise sur le bus.\n");

const port = new SerialPort({
  path: device,
  baudRate,
  dataBits,
  parity: parityArg,
  stopBits,
  autoOpen: true,
});

port.on("error", (err) => {
  console.error("Erreur port série:", err.message);
  process.exit(1);
});

// CRC16 Modbus (polynôme 0xA001, init 0xFFFF) — vérification, pas génération.
function crc16modbus(buf) {
  let crc = 0xffff;
  for (let pos = 0; pos < buf.length; pos++) {
    crc ^= buf[pos];
    for (let i = 0; i < 8; i++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

function describeFunction(fc) {
  const names = {
    1: "Read Coils", 2: "Read Discrete Inputs",
    3: "Read Holding Registers", 4: "Read Input Registers",
    5: "Write Single Coil", 6: "Write Single Register",
    15: "Write Multiple Coils", 16: "Write Multiple Registers",
  };
  if (fc & 0x80) return `EXCEPTION de ${names[fc & 0x7f] || "fonction " + (fc & 0x7f)}`;
  return names[fc] || `fonction ${fc}`;
}

let buffer = Buffer.alloc(0);
let lastByteTime = Date.now();
let frameCount = 0;

function flushFrame() {
  if (buffer.length === 0) return;
  frameCount++;
  const now = new Date().toISOString();

  if (buffer.length < 4) {
    console.log(`[${now}] #${frameCount} trame trop courte (${buffer.length} octets) : ${buffer.toString("hex")}`);
    buffer = Buffer.alloc(0);
    return;
  }

  const payload = buffer.subarray(0, buffer.length - 2);
  const receivedCrc = buffer.readUInt16LE(buffer.length - 2);
  const computedCrc = crc16modbus(payload);
  const crcOk = receivedCrc === computedCrc;

  const addr = buffer[0];
  const fc = buffer[1];
  const data = buffer.subarray(2, buffer.length - 2);

  console.log(
    `[${now}] #${frameCount} addr=${addr} (0x${addr.toString(16)}) fc=${fc} (${describeFunction(fc)}) ` +
    `data=${data.toString("hex")} crc=${crcOk ? "OK" : "INVALIDE"} raw=${buffer.toString("hex")}`
  );

  buffer = Buffer.alloc(0);
}

port.on("data", (chunk) => {
  const now = Date.now();
  if (buffer.length > 0 && now - lastByteTime > silenceThresholdMs) {
    flushFrame();
  }
  buffer = Buffer.concat([buffer, chunk]);
  lastByteTime = now;
});

setInterval(() => {
  if (buffer.length > 0 && Date.now() - lastByteTime > silenceThresholdMs) {
    flushFrame();
  }
}, Math.max(10, silenceThresholdMs / 2));

process.on("SIGINT", () => {
  console.log(`\nArrêt — ${frameCount} trame(s) capturée(s).`);
  port.close(() => process.exit(0));
});
