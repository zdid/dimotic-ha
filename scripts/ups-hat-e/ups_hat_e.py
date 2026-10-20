#!/usr/bin/env python3
"""Lit le UPS HAT (E) (Waveshare, adresse I2C 0x2D) et le publie sur MQTT avec découverte Home Assistant.

LECTURE SEULE : ne jamais écrire dans le registre 0x01 (écrire 0x55 éteint la Raspberry).
Découverte publiée sous le préfixe « homeassist » (repris par nommage, qui ajoute la taxonomie).
Registres : voir specs/current/conception-ups-hat-e (0x02 charge, 0x10 VBUS, 0x20 batterie, 0x30 cellules).
"""
import json, os, sys, time
import smbus
import paho.mqtt.client as mqtt

ADRESSE = 0x2D
BUS = int(os.environ.get("UPS_I2C_BUS", "1"))
BROKER = os.environ.get("UPS_MQTT_HOST", "127.0.0.1")
PERIODE = int(os.environ.get("UPS_PERIODE_S", "10"))
NOM = os.environ.get("UPS_NOM_APPAREIL", "ups---ha2--infra")
ID = os.environ.get("UPS_ID", "ups_hat_e_ha2")
PREFIXE_DECOUVERTE = "homeassist"
T_ETAT, T_DISPO = f"ups-hat-e/{ID}/etat", f"ups-hat-e/{ID}/disponibilite"
ETATS_CHARGE = {0: "veille", 1: "charge d'entretien", 2: "courant constant", 3: "tension constante", 4: "en attente", 5: "pleine", 6: "timeout"}

bus = smbus.SMBus(BUS)

def mot(r):  # 2 octets little-endian
    return bus.read_byte_data(ADRESSE, r) | (bus.read_byte_data(ADRESSE, r + 1) << 8)

def signe(v):
    return v - 65536 if v > 32767 else v

def lire():
    charge = bus.read_byte_data(ADRESSE, 0x02)
    cellules = [mot(0x30 + 2 * i) for i in range(4)]
    restant = mot(0x28)
    return {
        "secteur": "ON" if charge & 0x20 else "OFF",
        "en_charge": "ON" if charge & 0x80 else "OFF",
        "etat_charge": ETATS_CHARGE.get(charge & 7, "inconnu"),
        "vbus_v": round(mot(0x10) / 1000, 2), "vbus_a": round(mot(0x12) / 1000, 3), "vbus_w": round(mot(0x14) / 1000, 2),
        "batterie_v": round(mot(0x20) / 1000, 2), "batterie_a": round(signe(mot(0x22)) / 1000, 3), "batterie_pct": mot(0x24),
        "capacite_mah": mot(0x26),
        "decharge_min": restant if restant != 65535 else None,
        "cellule_1_v": round(cellules[0] / 1000, 3), "cellule_2_v": round(cellules[1] / 1000, 3), "cellule_3_v": round(cellules[2] / 1000, 3), "cellule_4_v": round(cellules[3] / 1000, 3),
        "ecart_cellules_mv": max(cellules) - min(cellules),
    }

# (clé, nom, composant, device_class, unité, icône)
ENTITES = [
    ("batterie_pct", "Batterie", "sensor", "battery", "%", None),
    ("batterie_v", "Tension batterie", "sensor", "voltage", "V", None),
    ("batterie_a", "Courant batterie", "sensor", "current", "A", None),
    ("capacite_mah", "Capacité restante", "sensor", None, "mAh", "mdi:battery-high"),
    ("decharge_min", "Autonomie restante", "sensor", "duration", "min", "mdi:timer-sand"),
    ("vbus_v", "Tension secteur", "sensor", "voltage", "V", None),
    ("vbus_a", "Courant secteur", "sensor", "current", "A", None),
    ("vbus_w", "Puissance secteur", "sensor", "power", "W", None),
    ("etat_charge", "État de charge", "sensor", None, None, "mdi:battery-charging"),
    ("cellule_1_v", "Cellule 1", "sensor", "voltage", "V", None), ("cellule_2_v", "Cellule 2", "sensor", "voltage", "V", None),
    ("cellule_3_v", "Cellule 3", "sensor", "voltage", "V", None), ("cellule_4_v", "Cellule 4", "sensor", "voltage", "V", None),
    ("ecart_cellules_mv", "Écart entre cellules", "sensor", "voltage", "mV", "mdi:battery-alert-variant-outline"),
    ("secteur", "Secteur", "binary_sensor", "power", None, None),
    ("en_charge", "En charge", "binary_sensor", "battery_charging", None, None),
]

def decouverte(client):
    dev = {"identifiers": [ID], "name": NOM, "manufacturer": "Waveshare", "model": "UPS HAT (E)"}
    for cle, nom, comp, classe, unite, icone in ENTITES:
        p = {"name": nom, "unique_id": f"{ID}_{cle}", "state_topic": T_ETAT, "value_template": "{{ value_json.%s }}" % cle,
             "availability_topic": T_DISPO, "device": dev}
        if classe: p["device_class"] = classe
        if icone: p["icon"] = icone
        if comp == "sensor":
            if unite: p["unit_of_measurement"] = unite
            if cle not in ("etat_charge",): p["state_class"] = "measurement"
        client.publish(f"{PREFIXE_DECOUVERTE}/{comp}/{ID}/{cle}/config", json.dumps(p, ensure_ascii=False), retain=True)

def main():
    client = mqtt.Client(client_id=f"ups-hat-e-{ID}")
    client.will_set(T_DISPO, "offline", retain=True)
    client.connect(BROKER, 1883, 60)
    client.loop_start()
    decouverte(client)
    erreurs = 0
    while True:
        try:
            client.publish(T_ETAT, json.dumps(lire()), retain=True)
            client.publish(T_DISPO, "online", retain=True)
            erreurs = 0
        except OSError as e:
            erreurs += 1
            print(f"lecture I2C impossible ({erreurs}) : {e}", file=sys.stderr, flush=True)
            if erreurs >= 3:
                client.publish(T_DISPO, "offline", retain=True)
        time.sleep(PERIODE)

if __name__ == "__main__":
    main()
