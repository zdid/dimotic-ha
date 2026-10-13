/**
 * Script Python memoire.py déployé à côté de config.yml : mémoire des derniers états des pins (13/10/2026, spec v1.7 §4.3).
 * Source de référence du script ; copié tel quel par DeployService, lancé dans le conteneur mqtt-io à la place de mqtt-io.
 */
export const MEMOIRE_SCRIPT = String.raw`#!/usr/bin/env python3
"""Mémoire des derniers états des pins (rpigpio, 13/10/2026) — lancé À LA PLACE de mqtt-io dans son conteneur.

1. Au démarrage : lit /data/etats.json (derniers états connus, logiques ON/OFF) et en déduit l''initial' électrique de chaque
   sortie dans une copie de /config.yml (/tmp/config.yml) — l'état est donc appliqué dès l'initialisation de la broche,
   sans attendre de commande MQTT. Aucune commande retenue n'est nécessaire.
2. Lance mqtt-io sur cette copie.
3. Quand Home Assistant annonce son démarrage (homeassistant/status = online), republie l'état de chaque pin sur son topic d'état
   (mqtt-io ne publie que lors d'un changement : sans cela les entités restent « inconnu » jusqu'au prochain changement).
4. Écoute les topics d'état de mqtt-io (<topic_prefix>/output/<nom>, <topic_prefix>/input/<nom>), écrit /data/etats.json
   (écriture atomique) et publie le résumé de toutes les pins sur <topic_prefix>/memoire/etats (JSON, NON retenu).
"""
import json
import os
import signal
import subprocess
import sys
import threading

import yaml
import paho.mqtt.client as mqtt

CONFIG_IN = '/config.yml'
CONFIG_OUT = '/tmp/config.yml'
ETATS = '/data/etats.json'
VALIDES = ('ON', 'OFF')

verrou = threading.Lock()
etats = {}


def charger():
    try:
        with open(ETATS) as f:
            brut = json.load(f)
        return {str(k): v for k, v in brut.items() if v in VALIDES}
    except FileNotFoundError:
        return {}
    except Exception as e:  # fichier abîmé : on repart sans mémoire plutôt que de ne pas démarrer
        print('memoire: %s illisible (%s), ignoré' % (ETATS, e), flush=True)
        return {}


def ecrire():
    os.makedirs(os.path.dirname(ETATS), exist_ok=True)
    tmp = ETATS + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(etats, f, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, ETATS)


def appliquer(config, memoire):
    """'initial' électrique (high/low) des sorties d'après l'état logique mémorisé (même règle que generator.ts)."""
    n = 0
    for sortie in config.get('digital_outputs') or []:
        etat = memoire.get(str(sortie['name']))
        if etat is None:
            continue
        haut = (etat == 'OFF') if sortie.get('inverted') else (etat == 'ON')
        sortie['initial'] = 'high' if haut else 'low'
        sortie['publish_initial'] = True
        n += 1
    return n


config = yaml.safe_load(open(CONFIG_IN))
etats.update(charger())
n = appliquer(config, etats)
with open(CONFIG_OUT, 'w') as f:
    yaml.safe_dump(config, f, allow_unicode=True)
print('memoire: %d état(s) rejoué(s) au démarrage : %s' % (n, json.dumps(etats, sort_keys=True)), flush=True)

m = config['mqtt']
prefixe = m['topic_prefix']
sujets = [prefixe + '/output/+', prefixe + '/input/+', 'homeassistant/status']
sorties = {str(o['name']) for o in config.get('digital_outputs') or []}
entrees = {str(o['name']) for o in config.get('digital_inputs') or []}


def republier(client):
    with verrou:
        for nom, valeur in etats.items():
            genre = 'output' if nom in sorties else 'input' if nom in entrees else None
            if genre:
                client.publish('%s/%s/%s' % (prefixe, genre, nom), valeur, retain=False)
    print('memoire: états republiés pour Home Assistant', flush=True)


def sur_message(client, _ud, msg):
    if msg.topic == 'homeassistant/status':
        if msg.payload.decode('utf-8', 'replace').strip() == 'online':
            threading.Timer(8.0, republier, args=(client,)).start()  # laisser HA créer ses entités MQTT
        return
    nom = msg.topic.rsplit('/', 1)[-1]
    valeur = msg.payload.decode('utf-8', 'replace').strip().upper()
    if valeur not in VALIDES:
        return
    with verrou:
        if etats.get(nom) == valeur:
            return
        etats[nom] = valeur
        try:
            ecrire()
        except Exception as e:
            print('memoire: écriture impossible : %s' % e, flush=True)
        client.publish(prefixe + '/memoire/etats', json.dumps(etats, sort_keys=True), retain=False)


def sur_connexion(client, _ud, _flags, rc, _props=None):
    client.subscribe([(s, 0) for s in sujets])
    with verrou:
        client.publish(prefixe + '/memoire/etats', json.dumps(etats, sort_keys=True), retain=False)


client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id='%s_memoire' % m.get('client_id', 'rpigpio'))
if m.get('user'):
    client.username_pw_set(m['user'], m.get('password') or None)
client.on_connect = sur_connexion
client.on_message = sur_message
client.connect_async(m['host'], int(m.get('port', 1883)), 60)
client.loop_start()

enfant = subprocess.Popen(['venv/bin/python', '-m', 'mqtt_io', CONFIG_OUT])


def arret(signum, _frame):
    enfant.send_signal(signum)


signal.signal(signal.SIGTERM, arret)
signal.signal(signal.SIGINT, arret)
code = enfant.wait()
client.loop_stop()
sys.exit(code)
`;
