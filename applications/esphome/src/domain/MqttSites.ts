/**
 * Connexions MQTT de l'application, une par site (sites étanches) — fonctionnelles-esphome_specs §3.2, §3.3, §7.
 *
 * - **Usine** : se connecte au broker de CHAQUE site servi (celui de noisy par le VPN) ; présence sur
 *   `dimotic/esphome/agent/<machine ESPHome>` de chacun.
 * - **Poseur** : se connecte au broker de SON site ; présence sur `dimotic/esphome/<site>/poseur`.
 *
 * Chaque connexion déclare sa présence « hors ligne » comme testament (charge JSON, voir AgentPresence).
 */

import * as os from 'node:os';
import { MqttTransport, type Logger } from '../../../core/dist/exports';
import type { EsphomeConfig, BrokerConfig } from './config-schema';
import { SiteBus, type Transport } from './bus';
import { AgentPresence } from './AgentPresence';
import { topics } from './messages';
import type { Identite } from './presence';

export type FabriqueTransport = (cfg: { clientId: string; broker: BrokerConfig; willTopic: string; willPayload: string }) => Transport;

/** Transport réel : MqttTransport du cœur (reconnexion avec backoff, abonnements rejoués, publications en attente). */
export const fabriqueMqtt = (logger?: Logger): FabriqueTransport => ({ clientId, broker, willTopic, willPayload }) =>
  new MqttTransport(
    {
      host: broker.hote,
      port: broker.port,
      clientId,
      username: broker.utilisateur,
      password: broker.motDePasse,
      keepalive: 60,
      reconnectDelay: 10,
      clean: true,
      willTopic,
      willPayload,
      protocolVersion: 4
    },
    logger
  );

export interface Role {
  bus: SiteBus[];
  presence: AgentPresence;
}

export interface Liaisons {
  usine?: Role & { machine: string };
  poseur?: Role;
}

export function nomMachine(config: EsphomeConfig): string {
  return config.usine.machine.trim() || os.hostname();
}

/** Construit (sans connecter) les bus et la présence des rôles activés. */
export function creerLiaisons(config: EsphomeConfig, moi: Identite, fabrique: FabriqueTransport, maintenant: () => Date = () => new Date()): Liaisons {
  const liaisons: Liaisons = {};
  const testament = AgentPresence.testament(moi, maintenant());

  if (config.usine.actif && config.usine.sites.length > 0) {
    const machine = nomMachine(config);
    const sujet = topics.usine(machine);
    const bus = config.usine.sites.map(
      (s) => new SiteBus(s.id, fabrique({ clientId: `esphome-usine-${moi.instance}-${s.id}`, broker: s.mqtt, willTopic: sujet, willPayload: testament }))
    );
    liaisons.usine = { machine, bus, presence: new AgentPresence(sujet, moi, bus, maintenant) };
  }

  if (config.poseur.actif) {
    const sujet = topics.poseur(config.site);
    const bus = [new SiteBus(config.site, fabrique({ clientId: `esphome-poseur-${moi.instance}`, broker: config.poseur.mqtt, willTopic: sujet, willPayload: testament }))];
    liaisons.poseur = { bus, presence: new AgentPresence(sujet, moi, bus, maintenant) };
  }

  return liaisons;
}
