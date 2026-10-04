#!/usr/bin/env python3
# =============================================================================
# Essai d'interrogation ACTIVE du compteur DDZY422-D2, décalée par rapport au module Wi-Fi.
#
# Contexte (04/10/2026) : le module Wi-Fi du compteur lit les 34 registres 0x0000-0x0021 une fois par
# minute (~61 s) ; entre-temps il envoie un « battement » toutes les 30 s (lecture 0x400c + écriture de
# 0x0025 en 0x013a). Pour piloter une batterie il faut la puissance du réseau plus souvent : on se cale
# sur la lecture du module (T0) et on interroge à T0+15, T0+30, T0+45 s.
#
# ⚠️ LECTURE SEULE : une seule requête, fonction 3, adresse 1, 34 registres depuis 0x0000 (la même que
# celle du module). AUCUNE écriture (surtout pas 0x013a). On n'émet que si le bus est silencieux depuis
# ≥ SILENCE_MS, jamais pendant une trame du module.
#
# Usage : python3 ddzy422-poll-test.py [device] [cycles]
#   python3 ddzy422-poll-test.py /dev/ttyUSB0 3
# =============================================================================
import sys, time, serial

DEV = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyUSB0'
CYCLES = int(sys.argv[2]) if len(sys.argv) > 2 else 3
OFFSETS = (15, 30, 45)
SILENCE_MS = 150
REQ = bytes.fromhex('010300000022c5d3')  # requête identique à celle du module (CRC inclus)


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def decode(frame):
    if len(frame) != 73 or frame[0] != 1 or frame[1] != 3 or frame[2] != 68:
        return None
    if crc16(frame[:-2]) != int.from_bytes(frame[-2:], 'little'):
        return None
    w = [int.from_bytes(frame[3 + i * 2:5 + i * 2], 'big') for i in range(34)]
    sg = lambda i, sc: (-1 if w[i] == 0x8000 else 1) * w[i + 1] * sc
    pf = (w[0x0c] & 0x7fff) * 0.001 * (-1 if w[0x0c] & 0x8000 else 1)
    return (f"V={w[1]*0.1:.1f} I={sg(2,0.001):.3f} P={sg(6,1):.0f}W Q={sg(8,1):.0f} S={w[0x0b]} "
            f"PF={pf:.3f} F={w[0x0d]*0.01:.2f} Etot={((w[0x0e]<<16)|w[0x0f])*0.01:.2f}")


ser = serial.Serial(DEV, 9600, bytesize=8, parity='E', stopbits=1, timeout=0.02)
now = time.time


def wait_module_read():
    """Bloque jusqu'à la requête de lecture du module (REQ vue sur le fil) ; renvoie son heure."""
    buf = b''
    while True:
        buf = (buf + ser.read(64))[-64:]
        if buf.endswith(REQ):
            return now()


def quiet_then_query():
    """Attend SILENCE_MS de silence, émet REQ, lit la réponse (73 octets ou délai 1 s)."""
    last = now()
    while now() - last < SILENCE_MS / 1000:
        if ser.read(64):
            last = now()
    ser.reset_input_buffer()
    t = now()
    ser.write(REQ)
    ser.flush()
    buf = b''
    while now() - t < 1.0 and len(buf) < 8 + 73:
        buf += ser.read(128)
    return t, buf


print(f"Cale sur la lecture du module ({DEV}, 9600 8E1) — {CYCLES} cycle(s), décalages {OFFSETS} s", flush=True)
for c in range(CYCLES):
    t0 = wait_module_read()
    print(f"[cycle {c+1}] lecture du module vue à {time.strftime('%H:%M:%S', time.localtime(t0))}", flush=True)
    for off in OFFSETS:
        while now() < t0 + off:
            ser.read(64)  # on continue d'écouter (vide le tampon)
        t, buf = quiet_then_query()
        echo = buf[:8] if buf.startswith(REQ) else b''
        resp = buf[len(REQ):] if buf.startswith(REQ) else buf  # l'adaptateur peut renvoyer notre écho
        d = decode(resp[-73:]) if len(resp) >= 73 else None
        print(f"  +{off:>2}s {time.strftime('%H:%M:%S', time.localtime(t))} "
              f"écho={'oui' if echo else 'non'} réponse={len(resp)}o  "
              f"{d if d else 'ILLISIBLE : ' + resp.hex()}", flush=True)
