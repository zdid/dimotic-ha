#!/usr/bin/env python3
# Identifie, par ÉCOUTE PASSIVE (n'émet jamais), ce qui est branché sur chaque adaptateur USB-RS485 d'une machine :
# le compteur DDZY422-D2 (module Wi-Fi Solarman qui l'interroge : adresse 1, lecture de 0x0000×34 toutes les ~61 s)
# ou un bus muet (ex. un DDSU666-H qu'aucun maître n'interroge). Sert à savoir quel adaptateur porte quel compteur
# quand plusieurs sont branchés, SANS risquer de collision : à faire avant toute sonde active (modbus-probe.py).
#
# Les ports sont écoutés en parallèle pendant `secondes` (défaut 75 > un cycle de 61 s), en 9600 8E1 puis, si rien ne
# passe, en 9600 8N1 (le DDSU666 est réglé en 8N1 par défaut).
#
# Usage : python3 rs485-identify.py [secondes] [port ...]      défaut : tous les /dev/ttyUSB*
# Aucune dépendance (python3 seul).

import glob
import os
import select
import struct
import sys
import termios
import time

B9600 = termios.B9600


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def find_frame(buf: bytes):
    if len(buf) < 5:
        return None
    fc = buf[1]
    lengths = []
    if fc & 0x80:
        lengths.append(5)
    if fc in (3, 4):
        lengths += [8, 5 + buf[2]]
    if fc in (5, 6):
        lengths.append(8)
    if fc == 16:
        lengths.append(8)
        if len(buf) >= 7:
            lengths.append(9 + buf[6])
    for n in lengths:
        if len(buf) >= n and crc16_modbus(buf[:n - 2]) == (buf[n - 2] | (buf[n - 1] << 8)):
            return n
    return None


def open_serial(dev: str, parity: str) -> int:
    fd = os.open(dev, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)      # lecture seule : on ne peut rien émettre
    iflag, oflag, cflag, lflag, _, _, cc = termios.tcgetattr(fd)
    cflag = (cflag & ~(termios.CSIZE | termios.PARENB | termios.PARODD | termios.CSTOPB | termios.CRTSCTS)) | termios.CS8 | termios.CREAD | termios.CLOCAL
    if parity == "E":
        cflag |= termios.PARENB
    termios.tcsetattr(fd, termios.TCSANOW, [0, 0, cflag, 0, B9600, B9600, cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def listen(ports, seconds: float, parity: str):
    """{port: bytes} reçus sur chaque port pendant `seconds`, en parallèle."""
    fds = {open_serial(p, parity): p for p in ports}
    got = {p: b"" for p in ports}
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select(list(fds), [], [], 0.5)
        for fd in ready:
            got[fds[fd]] += os.read(fd, 256)
    for fd in fds:
        os.close(fd)
    return got


def analyse(raw: bytes):
    """(trames valides, ensemble de requêtes de lecture vues sous la forme (adresse, début, nombre))."""
    frames, reads, i = 0, set(), 0
    while i < len(raw) - 4:
        n = find_frame(raw[i:])
        if n:
            fr = raw[i:i + n]
            frames += 1
            if fr[1] in (3, 4) and n == 8:
                reads.add((fr[0], struct.unpack(">H", fr[2:4])[0], struct.unpack(">H", fr[4:6])[0]))
            i += n
        else:
            i += 1
    return frames, reads


def verdict(frames: int, reads, nbytes: int) -> str:
    if nbytes == 0:
        return "SILENCE — aucun maître n'interroge ce bus (compatible avec un DDSU666-H seul, ou avec un câble débranché)"
    if frames == 0:
        return f"{nbytes} octets mais aucune trame Modbus valide — mauvaise vitesse/parité, ou A/B inversés"
    if (1, 0x0000, 34) in reads or (1, 0x400C, 2) in reads:
        return "DDZY422-D2 (module Wi-Fi Solarman) — adresse 1, lecture de 0x0000×34 / 0x400C"
    return "trafic Modbus d'un autre équipement (voir les requêtes)"


def main() -> None:
    args = sys.argv[1:]
    seconds = float(args[0]) if args else 75.0
    ports = args[1:] or sorted(glob.glob("/dev/ttyUSB*"))
    if not ports:
        print("Aucun /dev/ttyUSB* trouvé.")
        sys.exit(1)
    print(f"Écoute passive de {', '.join(ports)} pendant {seconds:.0f} s (aucune émission possible : ports ouverts en lecture seule)")
    results = {}
    for parity in ("E", "N"):
        pending = [p for p in ports if p not in results]
        if not pending:
            break
        for p, raw in listen(pending, seconds, parity).items():
            frames, reads = analyse(raw)
            if frames or parity == "N":                      # 8E1 sans trame : on retente en 8N1 avant de conclure
                results[p] = (parity, raw, frames, reads)
    for p in ports:
        parity, raw, frames, reads = results[p]
        print(f"\n{p}  (8{parity}1) : {len(raw)} octets, {frames} trames valides")
        print("   → " + verdict(frames, reads, len(raw)))
        for a, start, n in sorted(reads)[:6]:
            print(f"     requête lecture : adresse {a}, registre 0x{start:04x} × {n}")
    print("\nPar nom stable :")
    for d in ("/dev/serial/by-path", "/dev/serial/by-id"):
        for link in sorted(glob.glob(d + "/*")):
            print(f"   {link} -> {os.path.realpath(link)}")


if __name__ == "__main__":
    main()
