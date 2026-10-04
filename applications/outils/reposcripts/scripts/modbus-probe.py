#!/usr/bin/env python3
# Sonde LECTURE SEULE d'un compteur Chint/Huawei DDSU666(-H) sur RS485 : cherche l'adresse Modbus et la parité qui
# répondent, puis affiche tension, courant, puissance et fréquence. N'émet que des requêtes de lecture (fonction 3),
# rien n'est jamais écrit dans le compteur. À lancer quand aucun autre programme n'utilise le port.
#
# Carte de registres du DDSU666-H (Huawei), vérifiée en réel le 14/09/2026 sur noisy2 (voir TODO.md, « carte de registres
# DDSU666H complète et vérifiée ») : flottants 32 bits, 2 registres chacun, octets de poids fort d'abord, fonction 3 :
#   0x2000 tension (V)  0x2002 courant (A)  0x2006 puissance active (kW)  0x200C réactive (kvar)  0x2012 apparente (kVA)
#   0x2018 facteur de puissance  0x2020 fréquence (Hz)  0x4000 énergie totale  0x400A importée  0x4014 exportée (kWh)
#   Puissance active : négative = injectée au réseau, positive = tirée. Lecture valide de 0x2000 à 0x2023 environ.
#
# Usage : python3 modbus-probe.py [device] [baudrate] [adresse ...]
#   défaut : /dev/ttyUSB0 9600 11 1   (11 = réglage usine des compteurs Huawei, 1 = réglage usine Chint)
# Aucune dépendance : python3 seul (termios de la bibliothèque standard, pas de pyserial).

import os
import select
import struct
import sys
import termios
import time


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def read_request(addr: int, start: int, count: int) -> bytes:
    body = struct.pack(">BBHH", addr, 3, start, count)
    return body + struct.pack("<H", crc16_modbus(body))


def parse_response(buf: bytes, addr: int, count: int):
    """Liste de flottants si `buf` est une réponse valide de lecture (fonction 3) de count/2 flottants, sinon None."""
    need = 5 + 2 * count
    if len(buf) < need or buf[0] != addr or buf[1] != 3 or buf[2] != 2 * count:
        return None
    if crc16_modbus(buf[:need - 2]) != (buf[need - 2] | (buf[need - 1] << 8)):
        return None
    return list(struct.unpack(">" + "f" * (count // 2), buf[3:3 + 2 * count]))


BAUDS = {1200: termios.B1200, 2400: termios.B2400, 4800: termios.B4800, 9600: termios.B9600,
         19200: termios.B19200, 38400: termios.B38400, 57600: termios.B57600, 115200: termios.B115200}


def open_serial(dev: str, baud: int, parity: str) -> int:
    """Ouvre `dev` en 8 bits, 1 bit d'arrêt, parité 'N' ou 'E', mode brut (sans pyserial)."""
    fd = os.open(dev, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    iflag, oflag, cflag, lflag, _, _, cc = attrs
    iflag = 0
    oflag = 0
    lflag = 0
    cflag = (cflag & ~(termios.CSIZE | termios.PARENB | termios.PARODD | termios.CSTOPB | termios.CRTSCTS)) | termios.CS8 | termios.CREAD | termios.CLOCAL
    if parity == "E":
        cflag |= termios.PARENB
    termios.tcsetattr(fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, BAUDS[baud], BAUDS[baud], cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def exchange(fd: int, request: bytes, wait: float = 0.6) -> bytes:
    termios.tcflush(fd, termios.TCIFLUSH)
    os.write(fd, request)
    raw = b""
    end = time.time() + wait
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            raw += os.read(fd, 64)
    return raw


def main() -> None:
    args = sys.argv[1:]
    dev = args[0] if len(args) > 0 else "/dev/ttyUSB0"
    baud = int(args[1]) if len(args) > 1 else 9600
    addrs = [int(a) for a in args[2:]] or [11, 1]
    if baud not in BAUDS:
        print(f"Vitesse non gérée : {baud} (possibles : {sorted(BAUDS)})")
        sys.exit(1)
    print(f"Sonde (lecture seule) sur {dev} @ {baud} — adresses {addrs}, parités N puis E")
    found = False
    for parity in ("N", "E"):
        fd = open_serial(dev, baud, parity)
        try:
            for addr in addrs:
                raw = exchange(fd, read_request(addr, 0x2000, 28))     # 0x2000 à 0x201B : mesures instantanées
                values = parse_response(raw, addr, 28)
                if values is None:
                    print(f"  8{parity}1 adresse {addr:>3} : " + ("réponse invalide : " + raw.hex() if raw else "pas de réponse"))
                    continue
                found = True
                v = lambda reg: values[(reg - 0x2000) // 2]
                print(f"  8{parity}1 adresse {addr:>3} : RÉPOND")
                print(f"      tension {v(0x2000):.1f} V, courant {v(0x2002):.3f} A, puissance active {v(0x2006) * 1000:.0f} W "
                      f"({'injectée' if v(0x2006) < 0 else 'tirée du réseau'}), réactive {v(0x200C) * 1000:.0f} var, apparente {v(0x2012) * 1000:.0f} VA, "
                      f"facteur de puissance {v(0x2018):.3f}")
                extra = {}
                for name, reg in (("fréquence (Hz)", 0x2020), ("énergie totale (kWh)", 0x4000), ("énergie importée (kWh)", 0x400A), ("énergie exportée (kWh)", 0x4014)):
                    r = parse_response(exchange(fd, read_request(addr, reg, 2)), addr, 2)
                    extra[name] = f"{r[0]:.2f}" if r else "pas de réponse"
                print("      " + ", ".join(f"{k} {x}" for k, x in extra.items()))
        finally:
            os.close(fd)
        if found:
            break
    if not found:
        print("Aucune réponse. Vérifier : câblage A/B (essayer de les inverser), vitesse et adresse réglées sur l'afficheur, port utilisé par un autre programme.")


if __name__ == "__main__":
    main()
