#!/usr/bin/env python3
# Tableau de bord terminal du compteur DDZY422-D2, en ÉCOUTE PASSIVE du bus RS485 (n'émet jamais).
#
# Complète rs485-sniffer.py (capture brute) : celui-ci n'affiche que l'état courant, décodé, pour comparer avec
# l'afficheur du compteur ou l'application Solarman. Les décodages viennent de l'analyse de la capture du 30/09/2026
# (voir TODO.md) ; ceux qui ne sont pas confirmés sont marqués « ? ». Les registres sans interprétation sont montrés
# bruts (hexa + décimal) pour pouvoir les rapprocher d'une valeur vue dans l'application.
#
# ⚠️ Un seul programme à la fois sur le port : ne pas lancer en même temps que rs485-sniffer.py (les octets seraient
# partagés entre les deux).
#
# Usage :
#   python3 rs485-dashboard.py [device] [baudrate] [bytesize] [parity] [stopbits]     (défaut : /dev/ttyUSB0 9600 8 E 1)
#   python3 rs485-dashboard.py --replay capture.txt     (rejoue une capture de rs485-sniffer.py, affiche l'état final)
# Nécessite python3-serial (sauf --replay). Ctrl+C pour quitter.

import sys
import time
import datetime


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def find_frame(buf: bytes):
    """Longueur de la trame Modbus RTU valide (CRC) au début de buf, ou None."""
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


class State:
    """Dernier contenu connu des registres + statistiques du bus."""

    def __init__(self):
        self.regs = {}          # adresse -> (valeur 16 bits, instant de lecture)
        self.frames = 0
        self.skipped = 0        # octets qui n'appartiennent à aucune trame valide
        self.pending = None     # (adresse de départ, nombre) de la dernière requête de lecture
        self.cycle_times = []   # instants des lectures de 0x0000×34
        self.writes = []        # (instant, adresse, données hexa)
        self.started = time.time()
        self.last_frame = None

    def on_frame(self, fr: bytes, now: float):
        self.frames += 1
        self.last_frame = now
        fc = fr[1]
        if fc in (3, 4):
            if len(fr) == 8:
                self.pending = (int.from_bytes(fr[2:4], "big"), int.from_bytes(fr[4:6], "big"))
            elif self.pending and len(fr) == 5 + fr[2] and fr[2] // 2 == self.pending[1]:
                start, n = self.pending
                for i in range(n):
                    self.regs[start + i] = (int.from_bytes(fr[3 + 2 * i:5 + 2 * i], "big"), now)
                if start == 0 and n >= 34:
                    self.cycle_times.append(now)
                    self.cycle_times = self.cycle_times[-10:]
                self.pending = None
        elif fc == 16 and len(fr) >= 9:
            self.writes.append((now, int.from_bytes(fr[2:4], "big"), fr[7:-2].hex()))
            self.writes = self.writes[-5:]

    def feed(self, buf: bytearray, now: float):
        """Extrait de buf toutes les trames valides (avec resynchronisation octet par octet)."""
        while len(buf) >= 5:
            n = find_frame(bytes(buf)) if buf[0] == 1 else None
            if n:
                self.on_frame(bytes(buf[:n]), now)
                del buf[:n]
            elif len(buf) >= 80 or (buf[0] != 1):
                del buf[0]            # pas une trame à cet endroit : on resynchronise
                self.skipped += 1
            else:
                break                 # trame peut-être incomplète : on attend la suite

    # --- accès aux valeurs ---
    def w(self, a):
        v = self.regs.get(a)
        return None if v is None else v[0]

    def d32(self, a):
        hi, lo = self.w(a), self.w(a + 1)
        return None if hi is None or lo is None else (hi << 16) | lo

    def text(self, start, n):
        raw = b"".join(self.regs[a][0].to_bytes(2, "big") for a in range(start, start + n) if a in self.regs)
        segs = [s.decode("ascii") for s in raw.split(b"\x00") if len(s) >= 4 and all(32 <= c < 127 for c in s)]
        return " | ".join(segs) if segs else None


RESET, BOLD, DIM, GREEN, YELLOW, CYAN, RED = "\033[0m", "\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[36m", "\033[31m"


def fmt(v, scale, unit, digits):
    return "—" if v is None else f"{v * scale:,.{digits}f} {unit}".replace(",", " ")


def render(st: State, port: str, now: float) -> str:
    L = []
    W = 78

    def line(s=""):
        L.append(s)

    def title(s):
        line(f"{BOLD}{CYAN}── {s} " + "─" * max(0, W - len(s) - 4) + RESET)

    def row(label, value, raw="", note=""):
        line(f"  {label:<24}{BOLD}{value:>16}{RESET}  {DIM}{raw:<22}{note}{RESET}")

    up = int(now - st.started)
    age = "aucune trame" if st.last_frame is None else f"dernière trame il y a {now - st.last_frame:4.0f} s"
    line(f"{BOLD}Compteur DDZY422-D2 — écoute passive {port}{RESET}   {datetime.datetime.now():%H:%M:%S}")
    line(f"{DIM}{st.frames} trames valides · {st.skipped} octets ignorés · {age} · en écoute depuis {up} s{RESET}")
    line()

    title("Mesures instantanées")
    u, i, p, s, pf, f = (st.w(a) for a in (1, 3, 7, 11, 12, 13))
    row("Tension", fmt(u, 0.1, "V", 1), f"0x0001 = {u}" if u is not None else "", "×0,1")
    row("Courant", fmt(i, 0.001, "A", 3), f"0x0003 = {i}" if i is not None else "", "×0,001")
    row("Puissance active", fmt(p, 1, "W", 0), f"0x0007 = {p}" if p is not None else "")
    row("Puissance apparente", fmt(s, 1, "VA", 0), f"0x000B = {s}" if s is not None else "", "= U × I ✓" if u and i else "")
    row("Facteur de puissance", "—" if pf is None else f"{pf * 0.001:.3f}", f"0x000C = {pf}" if pf is not None else "", "×0,001")
    row("Fréquence", fmt(f, 0.01, "Hz", 2), f"0x000D = {f}" if f is not None else "", "×0,01")
    line()

    title("Énergies (×0,01 kWh)")
    tot = st.d32(0x0E)
    row("Énergie totale", fmt(tot, 0.01, "kWh", 2), f"0x000E-0F = {tot}" if tot is not None else "")
    tar = [st.d32(a) for a in (0x10, 0x12, 0x14, 0x16)]
    for k, v in enumerate(tar, 1):
        row(f"  tarif {k} ?", fmt(v, 0.01, "kWh", 2), f"0x{0x10 + 2 * (k - 1):04X}-.. = {v}" if v is not None else "")
    if tot is not None and all(v is not None for v in tar):
        ok = sum(tar) == tot
        line(f"  {'somme des 4 tarifs':<24}{GREEN if ok else RED}{'= total ✓' if ok else '≠ total ✗'}{RESET}")
    tot2 = st.d32(0x18)
    row("Second total ?", fmt(tot2, 0.01, "kWh", 2), f"0x0018-19 = {tot2}" if tot2 is not None else "", "export ? inconnu")
    tar2 = [st.d32(a) for a in (0x1A, 0x1C, 0x1E, 0x20)]
    for k, v in enumerate(tar2, 1):
        row(f"  tarif {k} ?", fmt(v, 0.01, "kWh", 2), f"0x{0x1A + 2 * (k - 1):04X}-.. = {v}" if v is not None else "")
    if tot2 is not None and all(v is not None for v in tar2):
        ok = sum(tar2) == tot2
        line(f"  {'somme des 4 tarifs':<24}{GREEN if ok else RED}{'= second total ✓' if ok else '≠ second total ✗'}{RESET}")
    line()

    title("Registres non interprétés (à rapprocher de l'application)")
    r9 = st.w(9)
    row("0x0009", "—" if r9 is None else str(r9), "" if r9 is None else f"hexa {r9:04x}",
        "= S − P ✓ (14/14 relevés)" if r9 is not None and p is not None and s is not None and r9 == s - p else "S − P ? (à confirmer)")
    for a in (0x0002, 0x0004, 0x0005, 0x0006, 0x0008, 0x000A):
        v = st.w(a)
        row(f"0x{a:04X}", "—" if v is None else str(v), "" if v is None else f"hexa {v:04x}")
    v = st.w(0x400C), st.w(0x400D)
    row("0x400C-0D", "—" if v[0] is None else f"{v[0]} / {v[1]}", "" if v[0] is None else f"hexa {v[0]:04x} {v[1]:04x}")
    line()

    title("Identité et bus")
    c = [st.w(a) for a in (0x105, 0x106, 0x107)]
    if None not in c:
        line(f"  Horloge du compteur : 20{c[0] >> 8:02d}-{c[0] & 255:02d}-{c[1] >> 8:02d} {c[1] & 255:02d}:{c[2] >> 8:02d}:{c[2] & 255:02d}"
             f"   {DIM}(0x0105-07, lue toutes les ~5 min){RESET}")
    line(f"  Modèle      : {st.text(0x5000, 8) or '—'}")
    line(f"  Matériel    : {st.text(0x5020, 32) or '—'}")
    if len(st.cycle_times) >= 2:
        d = [b - a for a, b in zip(st.cycle_times, st.cycle_times[1:])]
        line(f"  Cycle de lecture du module : toutes les {sum(d) / len(d):.0f} s ({len(st.cycle_times)} vus)")
    if st.cycle_times:
        line(f"  Dernière lecture des mesures : il y a {now - st.cycle_times[-1]:.0f} s")
    for t, a, data in st.writes[-1:]:
        line(f"  Dernière écriture vue : 0x{a:04X} = {data} (il y a {now - t:.0f} s)")
    line()
    line(f"{DIM}Les valeurs ne se rafraîchissent qu'au rythme du module Wi-Fi (~ toutes les 60 s). « ? » = interprétation non confirmée.{RESET}")
    return "\n".join(L)


def replay(path: str):
    """Rejoue les trames `raw=…` d'une capture de rs485-sniffer.py."""
    st = State()
    t = 0.0
    with open(path, encoding="utf-8") as fh:
        for ln in fh:
            if "raw=" not in ln:
                continue
            fr = bytes.fromhex(ln.rsplit("raw=", 1)[1].strip())
            try:
                stamp = ln[1:ln.index("]")]
                t = datetime.datetime.fromisoformat(stamp).timestamp()
            except ValueError:
                t += 1
            if st.frames == 0:
                st.started = t
            st.on_frame(fr, t)
    print(render(st, path, t))


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--replay":
        replay(sys.argv[2])
        return
    try:
        import serial
    except ImportError:
        print("Le paquet pyserial n'est pas installé : sudo apt-get install -y python3-serial")
        sys.exit(1)
    a = sys.argv[1:]
    dev = a[0] if len(a) > 0 else "/dev/ttyUSB0"
    baud = int(a[1]) if len(a) > 1 else 9600
    size = int(a[2]) if len(a) > 2 else 8
    par = {"N": serial.PARITY_NONE, "E": serial.PARITY_EVEN, "O": serial.PARITY_ODD}[(a[3] if len(a) > 3 else "E").upper()]
    stop = serial.STOPBITS_TWO if len(a) > 4 and a[4] == "2" else serial.STOPBITS_ONE
    ser = serial.Serial(port=dev, baudrate=baud, bytesize=size, parity=par, stopbits=stop, timeout=0.2)
    st, buf, last_draw, last_rx = State(), bytearray(), 0.0, 0.0
    sys.stdout.write("\033[?25l\033[2J")     # curseur masqué, écran effacé
    try:
        while True:
            data = ser.read(256)
            now = time.time()
            if data:
                buf += data
                last_rx = now
                st.feed(buf, now)
            elif buf and now - last_rx > 2:
                st.skipped += len(buf)
                buf.clear()
            if now - last_draw >= 1:
                sys.stdout.write("\033[H" + "\n".join(x + "\033[K" for x in render(st, dev, now).split("\n")) + "\033[J")
                sys.stdout.flush()
                last_draw = now
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\033[?25h\n")


if __name__ == "__main__":
    main()
