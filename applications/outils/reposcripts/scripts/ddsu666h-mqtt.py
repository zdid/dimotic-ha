#!/usr/bin/env python3
# Compteur Huawei/Chint DDSU666-H (RS485, Modbus RTU) -> MQTT avec découverte Home Assistant, sans dépendance.
#
# Pourquoi pas modbus2mqtt : noisy est un RPi3 en Raspbian 10 32 bits (armv7l) ; l'image de modbus2mqtt n'existe pas
# pour cette architecture (constaté le 01/10/2026 : « no matching manifest for linux/arm/v7 »). Ce script n'a besoin que
# de python3 (termios de la bibliothèque standard) et de `mosquitto_pub` (paquet mosquitto-clients, déjà sur noisy).
#
# Carte de registres vérifiée en réel (TODO.md, « carte de registres DDSU666H complète et vérifiée », 14/09/2026, et
# relue sur noisy le 01/10/2026) : flottants 32 bits, octets de poids fort d'abord, fonction 3, adresse 11, 9600 8N1 :
#   0x2000 tension V · 0x2002 courant A · 0x2006 puissance active kW (positive = tirée du réseau, négative = injectée)
#   0x200C réactive kvar · 0x2012 apparente kVA · 0x2018 facteur de puissance · 0x2020 fréquence Hz
#   0x4000 énergie totale (importée − exportée) · 0x400A importée · 0x4014 exportée (kWh)
#
# LECTURE SEULE sur le bus : le script n'émet que des requêtes de lecture. À lancer seul sur le port.
#
# Home Assistant : messages de découverte RETENUS sous <préfixe>/sensor/<nœud>/<mesure>/config (un appareil, 10 capteurs),
# état en un seul message JSON sur <thème>/state, `expire_after` : si le script s'arrête, les capteurs passent « indisponible ».
#
# Usage : python3 ddsu666h-mqtt.py [options]      (--help pour la liste ; --dry-run n'envoie rien à MQTT)

import argparse
import json
import os
import select
import struct
import subprocess
import sys
import termios
import time

BAUDS = {2400: termios.B2400, 4800: termios.B4800, 9600: termios.B9600, 19200: termios.B19200, 38400: termios.B38400}


def crc16_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def open_serial(dev, baud, parity):
    fd = os.open(dev, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    iflag, oflag, cflag, lflag, _, _, cc = termios.tcgetattr(fd)
    cflag = (cflag & ~(termios.CSIZE | termios.PARENB | termios.PARODD | termios.CSTOPB | termios.CRTSCTS)) | termios.CS8 | termios.CREAD | termios.CLOCAL
    if parity == "E":
        cflag |= termios.PARENB
    termios.tcsetattr(fd, termios.TCSANOW, [0, 0, cflag, 0, BAUDS[baud], BAUDS[baud], cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def read_floats(fd, addr, start, count_regs, timeout=0.5):
    """Liste de flottants lus (fonction 3), ou None si pas de réponse valide."""
    body = struct.pack(">BBHH", addr, 3, start, count_regs)
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, body + struct.pack("<H", crc16_modbus(body)))
    need = 5 + 2 * count_regs
    raw = b""
    end = time.time() + timeout
    while time.time() < end and len(raw) < need:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            raw += os.read(fd, 256)
    if len(raw) < need or raw[0] != addr or raw[1] != 3 or raw[2] != 2 * count_regs:
        return None
    if crc16_modbus(raw[:need - 2]) != (raw[need - 2] | (raw[need - 1] << 8)):
        return None
    return list(struct.unpack(">" + "f" * (count_regs // 2), raw[3:3 + 2 * count_regs]))


def poll(fd, addr):
    """Dictionnaire des mesures, ou None si une lecture échoue."""
    block = read_floats(fd, addr, 0x2000, 28)
    freq = read_floats(fd, addr, 0x2020, 2)
    energy = read_floats(fd, addr, 0x4000, 24)
    if block is None or freq is None or energy is None:
        return None
    f = lambda reg: block[(reg - 0x2000) // 2]
    e = lambda reg: energy[(reg - 0x4000) // 2]
    return {
        "voltage": round(f(0x2000), 1),
        "current": round(f(0x2002), 3),
        "power": round(f(0x2006) * 1000, 1),
        "reactive_power": round(f(0x200C) * 1000, 1),
        "apparent_power": round(f(0x2012) * 1000, 1),
        "power_factor": round(f(0x2018), 3),
        "frequency": round(freq[0], 2),
        "energy_total": round(e(0x4000), 2),
        "energy_import": round(e(0x400A), 2),
        "energy_export": round(e(0x4014), 2),
    }


# clé -> (nom, device_class, unité, state_class, précision)
SENSORS = {
    "voltage": ("Tension", "voltage", "V", "measurement", 1),
    "current": ("Courant", "current", "A", "measurement", 2),
    "power": ("Puissance active (positive = soutirage)", "power", "W", "measurement", 0),
    "reactive_power": ("Puissance réactive", "reactive_power", "var", "measurement", 0),
    "apparent_power": ("Puissance apparente", "apparent_power", "VA", "measurement", 0),
    "power_factor": ("Facteur de puissance", "power_factor", None, "measurement", 3),
    "frequency": ("Fréquence", "frequency", "Hz", "measurement", 2),
    "energy_total": ("Énergie totale (import - export)", "energy", "kWh", "total", 2),
    "energy_import": ("Énergie importée", "energy", "kWh", "total_increasing", 2),
    "energy_export": ("Énergie exportée", "energy", "kWh", "total_increasing", 2),
}


def discovery_messages(args):
    device = {"identifiers": [args.node], "name": args.name, "manufacturer": "Huawei / Chint", "model": "DDSU666-H"}
    messages = []
    for key, (label, dclass, unit, sclass, precision) in SENSORS.items():
        payload = {
            "name": label,
            "unique_id": "%s_%s" % (args.node, key),
            "object_id": "%s_%s" % (args.node, key),
            "state_topic": args.topic + "/state",
            "value_template": "{{ value_json.%s }}" % key,
            "device_class": dclass,
            "state_class": sclass,
            "suggested_display_precision": precision,
            "expire_after": max(60, args.interval * 6),
            "device": device,
        }
        if unit:
            payload["unit_of_measurement"] = unit
        messages.append(("%s/sensor/%s/%s/config" % (args.prefix, args.node, key), json.dumps(payload, ensure_ascii=False), True))
    return messages


def publish(args, topic, payload, retain=False):
    if args.dry_run:
        print("MQTT %s%s %s" % (topic, " (retenu)" if retain else "", payload))
        return True
    cmd = ["mosquitto_pub", "-h", args.mqtt_host, "-p", str(args.mqtt_port), "-t", topic, "-m", payload, "-q", "0"]
    if retain:
        cmd.append("-r")
    try:
        return subprocess.run(cmd, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def main():
    ap = argparse.ArgumentParser(description="DDSU666-H (RS485) -> MQTT + découverte Home Assistant")
    ap.add_argument("--device", default="/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0")
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--parity", default="N", choices=["N", "E"])
    ap.add_argument("--address", type=int, default=11)
    ap.add_argument("--mqtt-host", default="192.168.1.201")
    ap.add_argument("--mqtt-port", type=int, default=1883)
    ap.add_argument("--prefix", default="homeassistant", help="préfixe de découverte de Home Assistant")
    ap.add_argument("--topic", default="ddsu666h/noisy", help="thème de l'état")
    ap.add_argument("--node", default="ddsu666h_noisy")
    ap.add_argument("--name", default="Compteur réseau noisy (DDSU666-H)")
    ap.add_argument("--interval", type=int, default=5, help="secondes entre deux lectures (1 à 60)")
    ap.add_argument("--once", action="store_true", help="une seule lecture puis sortie")
    ap.add_argument("--dry-run", action="store_true", help="affiche les messages au lieu de les envoyer à MQTT")
    args = ap.parse_args()
    args.interval = min(60, max(1, args.interval))

    fd = open_serial(args.device, args.baud, args.parity)
    last_discovery, failures = 0.0, 0
    print("DDSU666-H adresse %d sur %s -> MQTT %s:%d (%s), toutes les %d s" % (args.address, args.device, args.mqtt_host, args.mqtt_port, args.topic, args.interval), flush=True)
    while True:
        started = time.time()
        if started - last_discovery > 600:                       # découverte retenue, republiée toutes les 10 min
            for topic, payload, retain in discovery_messages(args):
                publish(args, topic, payload, retain)
            last_discovery = started
        values = poll(fd, args.address)
        if values is None:
            failures += 1
            if failures in (1, 5) or failures % 60 == 0:
                print("lecture impossible (%d échec(s) de suite) — câblage, adresse ou port occupé ?" % failures, flush=True)
        else:
            if failures:
                print("lecture rétablie après %d échec(s)" % failures, flush=True)
            failures = 0
            publish(args, args.topic + "/state", json.dumps(values), False)
        if args.once:
            sys.exit(0 if values else 1)
        time.sleep(max(0.0, args.interval - (time.time() - started)))


if __name__ == "__main__":
    main()
