#!/usr/bin/env python3
# =============================================================================
# Interrogation ACTIVE périodique du compteur DDZY422-D2 en coexistence avec son module Wi-Fi.
#
# Le module Wi-Fi parle par cycles de ~61 s, repérés à partir de sa lecture des 34 registres (T0) :
#   T0        rafale (lecture 0x0000 + 0x400c + 0x5000 + 0x5020 : ~0,8 s)
#   T0+23 s   battement (lecture 0x400c + écriture 0x013a)
#   T0+54 s   battement
# Ce script se cale sur T0 (requête vue sur le fil), n'émet jamais dans les fenêtres du module (marge
# incluse), toutes les EVERY secondes, avec écoute préalable (silence ≥ 150 ms).
#
# ⚠️ LECTURE SEULE : requête fonction 3, adresse 1, 34 registres depuis 0x0000. Aucune écriture.
#
# Usage : python3 ddzy422-poll.py [device] [every_s] [duration_s] [csv]
#   python3 ddzy422-poll.py /dev/ttyUSB0 5 300 /root/ddzy-5s.csv
# =============================================================================
import sys, time, serial

DEV = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyUSB0'
EVERY = float(sys.argv[2]) if len(sys.argv) > 2 else 5
DURATION = float(sys.argv[3]) if len(sys.argv) > 3 else 300
CSV = sys.argv[4] if len(sys.argv) > 4 else None
PERIOD = 61.0
# Fenêtres interdites (secondes après T0, modulo PERIOD) : rafale, 2 battements.
FORBIDDEN = ((-1.5, 2.0), (21.5, 25.0), (52.5, 56.0))
SILENCE_MS = 150
REQ = bytes.fromhex('010300000022c5d3')


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def decode(frame):
    if len(frame) != 73 or frame[:3] != bytes([1, 3, 68]) or crc16(frame[:-2]) != int.from_bytes(frame[-2:], 'little'):
        return None
    w = [int.from_bytes(frame[3 + i * 2:5 + i * 2], 'big') for i in range(34)]
    sg = lambda i, sc: (-1 if w[i] == 0x8000 else 1) * w[i + 1] * sc
    pf = (w[0x0c] & 0x7fff) * 0.001 * (-1 if w[0x0c] & 0x8000 else 1)
    return dict(V=round(w[1] * 0.1, 1), I=round(sg(2, 0.001), 3), P=sg(6, 1), Q=sg(8, 1), S=w[0x0b],
                PF=round(pf, 3), F=round(w[0x0d] * 0.01, 2), E=round(((w[0x0e] << 16) | w[0x0f]) * 0.01, 2),
                E2=round(((w[0x18] << 16) | w[0x19]) * 0.01, 2))


ser = serial.Serial(DEV, 9600, bytesize=8, parity='E', stopbits=1, timeout=0.02)
now = time.time
t0 = None
buf = b''


def listen():
    """Lit le bus ; met à jour T0 quand la requête du module est vue. Renvoie l'heure du dernier octet."""
    global t0, buf
    d = ser.read(64)
    if d:
        buf = (buf + d)[-64:]
        if buf.endswith(REQ):
            t0 = now()
            print(f"--- lecture du module vue à {time.strftime('%H:%M:%S', time.localtime(t0))}", flush=True)
        return now()
    return None


def in_forbidden(t):
    if t0 is None:
        return True
    ph = (t - t0) % PERIOD
    if ph > PERIOD - 2.0:
        ph -= PERIOD
    return any(a <= ph <= b for a, b in FORBIDDEN)


out = open(CSV, 'a') if CSV else None
if out and out.tell() == 0:
    out.write('heure,V,I,P,Q,S,PF,F,E,E2\n')
print(f"Cale sur le module ({DEV}) — toutes les {EVERY:g} s pendant {DURATION:g} s", flush=True)
while t0 is None:
    listen()
end = now() + DURATION
nxt = now()
ok = ko = skipped = 0
while now() < end:
    listen()
    if now() < nxt:
        continue
    if in_forbidden(now()):
        skipped += 1
        nxt += EVERY
        continue
    last = now()
    while now() - last < SILENCE_MS / 1000:
        if listen():
            last = now()
    if in_forbidden(now()):
        skipped += 1
        nxt += EVERY
        continue
    ser.reset_input_buffer()
    buf = b''
    t = now()
    ser.write(REQ)
    ser.flush()
    r = b''
    while now() - t < 0.6 and len(r) < 73:
        r += ser.read(128)
    d = decode(r[-73:]) if len(r) >= 73 else None
    h = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t))
    if d:
        ok += 1
        print(f"{h} {d}", flush=True)
        if out:
            out.write(f"{h},{d['V']},{d['I']},{d['P']},{d['Q']},{d['S']},{d['PF']},{d['F']},{d['E']},{d['E2']}\n")
            out.flush()
    else:
        ko += 1
        print(f"{h} ECHEC ({len(r)} o) {r.hex()}", flush=True)
    nxt += EVERY
print(f"Fin : {ok} réponses valides, {ko} échecs, {skipped} créneaux évités (fenêtres du module).", flush=True)
