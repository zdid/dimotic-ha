/**
 * Génère le config.yaml de mqtt-io (flyte/mqtt-io, schéma vérifié sur
 * https://github.com/flyte/mqtt-io le 12/08/2026 — voir home_assistant.py) à partir des
 * définitions de pins stockées ici.
 *
 * Point clé : mqtt-io regroupe par défaut TOUTES les pins d'une même instance sous un seul
 * "device" HA (mqtt.ha_discovery.name + client_id partagés, voir home_assistant.py::
 * get_common_config). Ça casserait le parsing QUOI---OÙ de nommage (une entité par device, pas
 * un device unique pour toute la carte) — chaque pin reçoit donc son propre override
 * `ha_discovery.device` (name = chaîne QUOI---OÙ, identifiers uniques), qui REMPLACE
 * entièrement le device par défaut (config.update(...) côté mqtt-io, pas une fusion profonde).
 */

import * as yaml from 'js-yaml';
import type { PinDefinition } from './storage-schema';
import type { RpigpioConfig, RpigpioTargetConfig } from './config-schema';

const GPIO_MODULE_NAME = 'rpi';

/**
 * Construit la chaîne "QUOI---OÙ" au même format que nommage (nommage_specs §2,
 * NommageService.parseDiscoveryName) : lieu_precis omis s'il est identique à lieu (même règle
 * que rfxcom/nommage, évite la redondance dans le nom affiché).
 */
export function buildQuoiOuName(pin: PinDefinition): string {
  const segments: string[] = [];
  const precisDistinct = pin.lieuPrecis && pin.lieuPrecis.toLowerCase() !== pin.lieu.toLowerCase();
  if (precisDistinct) segments.push(pin.lieuPrecis!);
  segments.push(pin.lieu);
  if (pin.lieuPere) segments.push(pin.lieuPere);
  if (pin.lieuGrandPere) segments.push(pin.lieuGrandPere);
  return `${pin.quoi}---${segments.join('--')}`;
}

function buildHaDiscoveryDevice(pin: PinDefinition): Record<string, unknown> {
  return {
    name: buildQuoiOuName(pin),
    identifiers: [`rpigpio_${pin.id}`],
    manufacturer: 'RPI GPIO',
    model: 'mqtt-io'
  };
}

/**
 * ⭐ 13/09/2026 (bug réel constaté sur noisy — les 12 sorties basculaient à un état électrique
 * arbitraire à chaque redémarrage du conteneur mqtt-io) : traduit `pin.initial` ("on"/"off",
 * logique, même convention que PAYLOAD_ON/PAYLOAD_OFF de gpiobridge.js) vers `initial`
 * ("high"/"low", électrique — ce que mqtt-io attend réellement, voir mqtt_io/config/
 * config.schema.yml) en tenant compte de `inverted`, exactement comme le fait déjà `write()` côté
 * gpiobridge.js pour les commandes ON/OFF elles-mêmes. `publish_initial: true` republie cet état
 * en MQTT dès le démarrage (utile pour resynchroniser HA/le reste du système sans attendre une
 * commande). Seulement pertinent pour une sortie (`direction: output`) : mqtt-io n'a pas ce
 * concept pour une entrée. Ne couvre que le TOUT premier démarrage (rien encore en MQTT) — les
 * redémarrages suivants sont couverts par le message MQTT retenu que publie gpiobridge.js
 * (`retain: true`), qui restaure le dernier état RÉEL plutôt qu'une valeur figée en config.
 */
function buildInitialFields(pin: PinDefinition): { initial?: 'high' | 'low'; publish_initial?: boolean } {
  if (pin.direction !== 'output' || !pin.initial) return {};
  const isHigh = pin.inverted ? pin.initial === 'off' : pin.initial === 'on';
  return { initial: isHigh ? 'high' : 'low', publish_initial: true };
}

function buildPinEntry(pin: PinDefinition): Record<string, unknown> {
  return {
    name: pin.id,
    module: GPIO_MODULE_NAME,
    pin: pin.pin,
    inverted: pin.inverted,
    ...buildInitialFields(pin),
    ha_discovery: {
      device: buildHaDiscoveryDevice(pin)
    }
  };
}

/**
 * Génère le contenu YAML complet du config.yaml mqtt-io — déployé tel quel sur la machine cible
 * (voir DeployService).
 *
 * @param effectiveBridgeInstance `<config.bridgeInstance (préfixe)>_<machineId>` déjà calculé par
 *   l'appelant (voir RpigpioService.effectiveBridgeInstance/computeBridgeInstance, core/ha-mqtt.ts)
 *   — jamais `config.bridgeInstance` seul, qui n'est plus qu'un préfixe duplicable entre machines
 *   depuis le 06/09/2026 (voir config-schema.ts).
 */
export function generateMqttIoConfig(config: RpigpioConfig, pins: PinDefinition[], effectiveBridgeInstance: string): string {
  const digitalInputs = pins.filter((p) => p.direction === 'input').map(buildPinEntry);
  const digitalOutputs = pins.filter((p) => p.direction === 'output').map(buildPinEntry);

  // ⭐ fonctionnelles-supervisor_specs v2.3 §9.2 : bridgeInstance injecté dans `topic_prefix` — sans
  // ça, deux instances rpigpio (deux machines) partagent réellement le même topicPrefix mqtt-io par
  // défaut (aucune convention de bridgeInstance ici avant ce correctif, contrairement à
  // rfxcom/evoo7/arexx qui embarquent bridgeInstance dans leurs topics via getStateTopic()/
  // getCommandTopic() du socle). `topic_prefix` ne concerne que les topics état/commande internes
  // (mqttio/rpigpio/...), aucune contrainte de format là-dessus.
  //
  // ⭐ 14/09/2026 (trouvé en conditions réelles, noisy2) : la MÊME disambiguïsation avait été
  // appliquée par erreur à `ha_discovery.prefix` — décale le format du topic de DÉCOUVERTE HA d'un
  // segment (`prefix/bridgeInstance/component/node_id/object_id/config`, 4 niveaux), alors que HA
  // lui-même (et notre `nommage`) n'acceptent que le format officiel à 2-3 niveaux
  // (`prefix/component/[node_id/]object_id/config`). Corrigé en laissant `ha_discovery.prefix`
  // intact et en fournissant `client_id` explicitement à la place : mqtt-io l'utilise déjà nativement
  // comme `node_id` du topic de découverte ET comme base de `unique_id` (voir home_assistant.py,
  // `mqtt_options.client_id`) — donc la même désambiguïsation multi-machines est obtenue SANS
  // segment de topic supplémentaire. Sans `client_id` explicite, mqtt-io serait retombé sur un hash
  // SHA1 opaque de `topic_prefix` (`server.py::_run()`, `"mqtt-io-%s" % sha1(topic_prefix)...`) —
  // fonctionnellement correct (déjà unique) mais illisible en debug.
  const doc = {
    mqtt: {
      host: config.mqtt.host,
      port: config.mqtt.port,
      user: config.mqtt.user,
      password: config.mqtt.password,
      client_id: effectiveBridgeInstance,
      topic_prefix: `${config.mqtt.topicPrefix}/${effectiveBridgeInstance}`,
      ha_discovery: {
        enabled: true,
        prefix: config.mqtt.discoveryPrefix,
        name: 'RPI GPIO'
      }
    },
    gpio_modules: [
      { name: GPIO_MODULE_NAME, module: 'raspberrypi' }
    ],
    digital_inputs: digitalInputs,
    digital_outputs: digitalOutputs
  };

  return yaml.dump(doc, { lineWidth: -1 });
}

/**
 * Génère le compose.yaml du conteneur mqtt-io — déployé une seule fois aux côtés de config.yml
 * dans target.hostDir (voir DeployService). `privileged: true` + `network_mode: host` : même
 * convention que le conteneur dimotic-ha lui-même (Dockerfile racine du projet, nécessaire pour
 * RFXCOM/USB dynamique) — ici pour l'accès GPIO, la doc officielle mqtt-io (docs_src/deployment/
 * docker.md, marquée "experimental and unmaintained") ne documente que --privileged de façon
 * fiable, pas de mapping /dev/gpiomem confirmé multi-plateforme (Pi 3/4/5, Orange Pi).
 *
 * ⭐ 12/08/2026 — `privileged: true` seul NE SUFFIT PAS : l'image bascule sur l'utilisateur non-
 * root `mqtt_io` (`USER mqtt_io` dans son Dockerfile), qui n'a pas accès à /dev/mem même dans un
 * conteneur privilégié (permissions du fichier, pas des capacités du conteneur) — constaté en
 * conditions réelles sur ha2 : `RuntimeError: No access to /dev/mem. Try running as root!`.
 * `user: "0:0"` court-circuite le USER de l'image.
 */
export function generateComposeFile(target: RpigpioTargetConfig): string {
  const doc = {
    services: {
      [target.containerName]: {
        image: target.image,
        container_name: target.containerName,
        restart: 'unless-stopped',
        network_mode: 'host',
        privileged: true,
        user: '0:0',
        volumes: [
          './config.yml:/config.yml:ro'
        ]
      }
    }
  };

  return yaml.dump(doc, { lineWidth: -1 });
}
