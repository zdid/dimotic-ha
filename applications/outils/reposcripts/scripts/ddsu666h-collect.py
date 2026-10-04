#!/usr/bin/env python3
# Collecte du DDSU666-H : lit les messages MQTT `ddsu666h/noisy/state` (lignes « topic json » sur stdin,
# produites par mosquitto_sub -v) et écrit un CSV horodaté (une ligne par message, ~5 s).
# Usage : mosquitto_sub -t ddsu666h/noisy/state -v | python3 ddsu666h-collect.py fichier.csv
import sys, json, time, os

path = sys.argv[1]
new = not os.path.exists(path) or os.path.getsize(path) == 0
out = open(path, 'a')
if new:
    out.write('heure,V,I,P,Q,S,PF,F,E_import,E_export,E_total\n')
for line in sys.stdin:
    try:
        d = json.loads(line.split(' ', 1)[1])
        out.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')},{d['voltage']},{d['current']},{d['power']},{d['reactive_power']},"
                  f"{d['apparent_power']},{d['power_factor']},{d['frequency']},{d['energy_import']},{d['energy_export']},{d['energy_total']}\n")
        out.flush()
    except Exception as e:
        print('ligne ignorée :', e, line[:80], file=sys.stderr, flush=True)
