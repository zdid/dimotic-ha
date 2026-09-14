#!/usr/bin/env python3
# =============================================================================
# Écoute passive d'un bus RS485 (aucune trame émise) — reconstitue et décode les
# trames Modbus RTU vues sur le fil, sans jouer le rôle de maître.
#
# Version Python pure (pas de Docker) pour matériel ARMv6 (Pi 1 / Pi Zero non-W)
# où Docker n'est plus praticable en 2026 — voir scripts/rs485-sniffer.cjs pour
# l'équivalent Node.js utilisé sur du matériel plus récent (noisy2/RPi4, via
# l'image ghcr.io/modbus2mqtt/modbus2mqtt qui embarque déjà `serialport`).
#
# Contexte (14/09/2026) : compteur DDZY422-D2 chez noisy, protocole local jamais
# débloqué en interrogation active (AcknowledgeError systématique, cf. TODO.md).
# Le module WiFi/GPRS du compteur dialogue en interne avec le compteur sur les
# mêmes bornes A/B — en branchant un adaptateur RS485 EN PARALLÈLE sur ce bus
# (A-A, B-B, rien à débrancher) et en écoutant sans jamais émettre, on capture
# le vrai trafic Modbus RTU du module vers le compteur : adresse esclave
# réelle, registres réellement interrogés, trames de réponse réelles.
#
# ⚠️ Ce script n'écrit JAMAIS sur le port série (aucun appel à ser.write) — ne
# PAS ajouter de code d'émission sans y réfléchir à deux fois : sur un bus
# RS485 multi-drop, émettre en même temps qu'un maître légitime provoque une
# collision et peut perturber le fonctionnement réel du compteur.
#
# Découpage en trames : détection par silence inter-octets (règle Modbus RTU —
# silence ≥ 3.5 temps-caractère = nouvelle trame), pas par un motif fixe. Le
# CRC16 Modbus est vérifié pour chaque trame candidate.
#
# Prérequis (sur le Pi 1, Raspberry Pi OS) :
#   sudo apt-get install -y python3-serial
#
# Usage :
#   python3 rs485-sniffer.py [device] [baudrate] [bytesize] [parity] [stopbits]
#   python3 rs485-sniffer.py /dev/ttyUSB0 9600 8 E 1
#
# Valeurs par défaut : /dev/ttyUSB0, 9600, 8, E (paire), 1 — ce sont les
# paramètres déjà confirmés pour le DDZY422-D2 (guide rapide Solarman +
# reconfirmé le 14/09/2026 : adresse 001, 9600 bauds, parité paire, 8 bits,
# 1 stop). Paramètres CLI prévus au cas où l'écoute ne donne rien de propre à
# ces valeurs (ex. tester d'autres débits : 4800/19200/38400).
# =============================================================================

import sys
import time
import datetime

try:
    import serial
except ImportError:
    print("Le paquet pyserial n'est pas installé. Sur Raspberry Pi OS :")
    print("  sudo apt-get install -y python3-serial")
    sys.exit(1)

device = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyUSB0"
baudrate = int(sys.argv[2]) if len(sys.argv) > 2 else 9600
bytesize = int(sys.argv[3]) if len(sys.argv) > 3 else 8
parity_arg = (sys.argv[4] if len(sys.argv) > 4 else "E").upper()
stopbits = int(sys.argv[5]) if len(sys.argv) > 5 else 1

PARITY_MAP = {"N": serial.PARITY_NONE, "E": serial.PARITY_EVEN, "O": serial.PARITY_ODD}
STOPBITS_MAP = {1: serial.STOPBITS_ONE, 2: serial.STOPBITS_TWO}

# Temps-caractère approximatif (start + data + parité éventuelle + stop),
# suffisant pour calculer le seuil de silence — pas besoin d'exactitude au bit
# près pour détecter une coupure de trame.
bits_per_char = 1 + bytesize + (0 if parity_arg == "N" else 1) + stopbits
char_time_ms = (bits_per_char / baudrate) * 1000
silence_threshold_s = max(0.004, (char_time_ms * 3.5) / 1000)


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc


FUNCTION_NAMES = {
    1: "Read Coils", 2: "Read Discrete Inputs",
    3: "Read Holding Registers", 4: "Read Input Registers",
    5: "Write Single Coil", 6: "Write Single Register",
    15: "Write Multiple Coils", 16: "Write Multiple Registers",
}


def describe_function(fc: int) -> str:
    if fc & 0x80:
        base = FUNCTION_NAMES.get(fc & 0x7F, f"fonction {fc & 0x7F}")
        return f"EXCEPTION de {base}"
    return FUNCTION_NAMES.get(fc, f"fonction {fc}")


def flush_frame(buf: bytes, frame_count: int) -> int:
    if not buf:
        return frame_count
    frame_count += 1
    now = datetime.datetime.now().isoformat()

    if len(buf) < 4:
        print(f"[{now}] #{frame_count} trame trop courte ({len(buf)} octets) : {buf.hex()}")
        return frame_count

    payload, received_crc_bytes = buf[:-2], buf[-2:]
    received_crc = received_crc_bytes[0] | (received_crc_bytes[1] << 8)
    computed_crc = crc16_modbus(payload)
    crc_ok = received_crc == computed_crc

    addr = buf[0]
    fc = buf[1]
    data = buf[2:-2]

    print(
        f"[{now}] #{frame_count} addr={addr} (0x{addr:02x}) fc={fc} ({describe_function(fc)}) "
        f"data={data.hex()} crc={'OK' if crc_ok else 'INVALIDE'} raw={buf.hex()}"
    )
    return frame_count


def main():
    print(
        f"Écoute passive sur {device} @ {baudrate} {bytesize}{parity_arg}{stopbits} — "
        f"seuil de silence {silence_threshold_s * 1000:.1f}ms"
    )
    print("Ctrl+C pour arrêter. Aucune trame n'est émise sur le bus.\n")

    ser = serial.Serial(
        port=device,
        baudrate=baudrate,
        bytesize=bytesize,
        parity=PARITY_MAP.get(parity_arg, serial.PARITY_EVEN),
        stopbits=STOPBITS_MAP.get(stopbits, serial.STOPBITS_ONE),
        timeout=silence_threshold_s,
    )

    buf = bytearray()
    frame_count = 0
    last_byte_time = time.monotonic()

    try:
        while True:
            chunk = ser.read(256)  # bloque au plus `timeout` secondes
            now = time.monotonic()
            if chunk:
                if buf and (now - last_byte_time) > silence_threshold_s:
                    frame_count = flush_frame(bytes(buf), frame_count)
                    buf.clear()
                buf.extend(chunk)
                last_byte_time = now
            else:
                # Rien reçu pendant `timeout` — si un buffer est en attente,
                # le silence est déjà largement dépassé, on le vide.
                if buf:
                    frame_count = flush_frame(bytes(buf), frame_count)
                    buf.clear()
    except KeyboardInterrupt:
        print(f"\nArrêt — {frame_count} trame(s) capturée(s).")
    finally:
        ser.close()


if __name__ == "__main__":
    main()
