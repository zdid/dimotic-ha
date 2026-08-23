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

function buildPinEntry(pin: PinDefinition): Record<string, unknown> {
  return {
    name: pin.id,
    module: GPIO_MODULE_NAME,
    pin: pin.pin,
    inverted: pin.inverted,
    ha_discovery: {
      device: buildHaDiscoveryDevice(pin)
    }
  };
}

/**
 * Génère le contenu YAML complet du config.yaml mqtt-io — déployé tel quel sur la machine cible
 * (voir DeployService).
 */
export function generateMqttIoConfig(config: RpigpioConfig, pins: PinDefinition[]): string {
  const digitalInputs = pins.filter((p) => p.direction === 'input').map(buildPinEntry);
  const digitalOutputs = pins.filter((p) => p.direction === 'output').map(buildPinEntry);

  // ⭐ fonctionnelles-supervisor_specs v2.3 §9.2 : bridgeInstance injecté en segment final des deux
  // préfixes — sans ça, deux instances rpigpio (deux machines) partagent réellement le même
  // topicPrefix/discoveryPrefix mqtt-io par défaut (aucune convention de bridgeInstance ici avant
  // ce correctif, contrairement à rfxcom/evoo7/arexx qui embarquent bridgeInstance dans leurs
  // topics via getStateTopic()/getCommandTopic() du socle).
  const doc = {
    mqtt: {
      host: config.mqtt.host,
      port: config.mqtt.port,
      user: config.mqtt.user,
      password: config.mqtt.password,
      topic_prefix: `${config.mqtt.topicPrefix}/${config.bridgeInstance}`,
      ha_discovery: {
        enabled: true,
        prefix: `${config.mqtt.discoveryPrefix}/${config.bridgeInstance}`,
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
