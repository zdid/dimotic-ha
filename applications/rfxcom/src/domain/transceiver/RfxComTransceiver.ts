/**
 * RfxComTransceiver
 *
 * Enveloppe la bibliothèque npm `rfxcom` (v2.6.2, vérifiée directement dans node_modules —
 * voir types/rfxcom.d.ts pour le détail des écarts avec implementation-rfxcom_specs_v1.2.md).
 *
 * Écarts principaux constatés avec la spec :
 * - Pas d'événement générique 'device' : chaque protocole émet son propre événement nommé
 *   ('lighting1', 'lighting2', 'blinds1', 'temperaturehumidity1', ...).
 * - Cycle de vie réel : 'connecting' → 'ready' (succès) ou 'connectfailed'/'disconnect' (échec,
 *   avec message d'erreur) — pas de 'connect'/'error' comme décrit dans la spec. 'status' EXISTE
 *   bel et bien (contrairement à ce qu'affirmait cette note avant vérification en conditions
 *   réelles le 2026-07-26) : émis pendant initialise(), avant OU après 'ready' selon les cas (pas
 *   d'ordre garanti, voir onHardwareStatus) — porte receiverType/firmwareVersion/enabledProtocols.
 * - Signatures de commandes réelles très différentes (deviceId encodé en chaîne par protocole,
 *   pas de houseCode/unitCode en paramètres séparés) — voir buildCommandDeviceId().
 *
 * Couche : Domaine (dépend de la lib native `rfxcom`, mais pas de MQTT/EventBus — c'est
 * RfxComService qui fait le pont).
 */

import * as rfxcom from 'rfxcom';
import type { Logger } from '../../../../core/src/exports';
import type { RfxComRawMessage, RfxComDeviceType } from '../types';

export interface RfxComTransceiverOptions {
  port: string;
  baudRate: number;
  debug?: boolean;
}

/** Statut matériel du RFXtrx433, tel que rapporté par l'événement 'status' de la bibliothèque `rfxcom`. */
export interface RfxComHardwareStatus {
  receiverType: string;
  receiverTypeCode: number;
  firmwareVersion: number;
  firmwareType: string;
  /** Noms de protocoles activés, tels que rapportés par le matériel (casing de la lib, ex: "AC", "OREGON") — pas nos RfxComDeviceType internes. */
  enabledProtocols: string[];
  /** Catalogue complet des noms de protocoles gérables par ce type de récepteur (rfxcom.protocols[receiverTypeCode]), pas seulement ceux actuellement activés. */
  availableProtocols: string[];
}

type MessageCallback = (message: RfxComRawMessage) => void;
type ConnectionCallback = (connected: boolean, error?: string) => void;

/** Mapping événement rfxcom → { type interne, subtypeTable } (protocoles réellement gérés). */
const LIGHTING_EVENTS: Record<string, { type: RfxComDeviceType; table: rfxcom.ProtocolSubtypeTable }> = {
  lighting1: { type: 'Lighting1', table: rfxcom.lighting1 },
  lighting2: { type: 'Lighting2', table: rfxcom.lighting2 },
  lighting4: { type: 'Lighting4', table: rfxcom.lighting4 },
  lighting5: { type: 'Lighting5', table: rfxcom.lighting5 },
  lighting6: { type: 'Lighting6', table: rfxcom.lighting6 }
};

export class RfxComTransceiver {
  private device?: rfxcom.RfxCom;
  private connected = false;
  private messageCallbacks: MessageCallback[] = [];
  private connectionCallbacks: ConnectionCallback[] = [];
  // Transmitters mis en cache par "protocole:subtype" pour éviter d'en recréer un par commande
  private transmitters: Map<string, unknown> = new Map();
  // Protocoles réellement activés sur le matériel RFXtrx433 lui-même — reçus à la connexion via
  // l'événement 'status' de la bibliothèque `rfxcom` (statusMessageHandler, réponse à la commande
  // "mode"). C'est le SEUL filtre de protocoles restant (fonctionnelles-rfxcom_specs §8.2) : un
  // filtre logiciel séparé après décodage existait ici auparavant — retiré le 2026-07-26 (demande
  // utilisateur, complexité jugée trop élevée sans documentation) une fois le mécanisme matériel
  // vérifié en conditions réelles et jugé plus précis (granularité par marque de protocole).
  // ⚠️ Limitation connue acceptée par l'utilisateur : RFXMeter (compteurs élec, elec1/23/4/5) n'a
  // AUCUN bit correspondant dans la table de protocoles matériel RFXtrx433 (voir
  // node_modules/rfxcom/lib/index.js::protocols_RFXtrx433) — il n'existe donc plus aucun moyen de
  // filtrer ces messages, ni matériel ni logiciel, depuis ce retrait.
  private hardwareStatus: RfxComHardwareStatus | null = null;
  private hardwareStatusCallbacks: Array<(status: RfxComHardwareStatus) => void> = [];

  constructor(private readonly logger: Logger) {}

  /**
   * Notifié à chaque réception de l'événement 'status' matériel — pas de garantie d'ordre avec la
   * résolution de connect() (course constatée en conditions réelles : 'status' peut arriver avant
   * OU après 'ready'/le "start receiver" qui résout la promesse), donc ne pas se fier à
   * getHardwareStatus() juste après un await connect(), utiliser ce callback à la place.
   */
  onHardwareStatus(callback: (status: RfxComHardwareStatus) => void): void {
    this.hardwareStatusCallbacks.push(callback);
  }

  // ==========================================================================
  // Connexion
  // ==========================================================================

  connect(options: RfxComTransceiverOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.info('RfxComTransceiver', `Tentative de connexion au transceiver RFXCOM sur ${options.port}...`);

      const device = new rfxcom.RfxCom(options.port, { debug: options.debug ?? false });
      this.device = device;

      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        this.connected = true;
        this.logger.info('RfxComTransceiver', `Transceiver RFXCOM initialisé avec succès sur ${options.port}`);
        this.notifyConnection(true);
        resolve();
      };
      const onFailed = (message: string) => {
        if (settled) return;
        settled = true;
        this.connected = false;
        this.logger.warn('RfxComTransceiver', `Tentative de connexion RFXCOM échouée - Motif: ${message}`);
        this.notifyConnection(false, message);
        reject(new Error(message));
      };

      device.on('ready', onReady);
      device.on('status', (evt: any) => {
        // rfxcom.protocols n'est pas déclaré dans src/types/rfxcom.d.ts (jamais utilisé jusqu'ici) —
        // accès via `any`, table des descripteurs {bit,msg} par nom de protocole pour ce récepteur.
        const protocolTable = (rfxcom as any).protocols?.[evt.receiverTypeCode] || {};
        this.hardwareStatus = {
          receiverType: evt.receiverType,
          receiverTypeCode: evt.receiverTypeCode,
          firmwareVersion: evt.firmwareVersion,
          firmwareType: evt.firmwareType,
          enabledProtocols: evt.enabledProtocols ?? [],
          availableProtocols: Object.keys(protocolTable)
        };
        this.logger.info('RfxComTransceiver',
          `Statut matériel reçu : ${this.hardwareStatus.receiverType}, firmware ${this.hardwareStatus.firmwareType} v${this.hardwareStatus.firmwareVersion}, protocoles activés sur le matériel: ${this.hardwareStatus.enabledProtocols.join(', ') || 'aucun'}`);
        for (const callback of this.hardwareStatusCallbacks) callback(this.hardwareStatus);
      });
      device.on('connectfailed', (message: string) => onFailed(message));
      device.on('disconnect', (message: string) => {
        // Après une connexion déjà établie : ne rejette pas la promesse (déjà résolue),
        // juste notification de perte de connexion.
        if (settled) {
          this.connected = false;
          this.logger.warn('RfxComTransceiver', `Transceiver déconnecté: ${message || 'raison inconnue'}`);
          this.notifyConnection(false, message);
          return;
        }
        onFailed(message);
      });

      this.setupProtocolListeners(device);

      device.initialise(onReady);
    });
  }

  disconnect(): void {
    if (!this.device) return;
    try {
      this.device.close();
    } catch (error) {
      this.logger.error('RfxComTransceiver', `Erreur lors de la fermeture: ${error}`);
    }
    this.device = undefined;
    this.transmitters.clear();
    this.connected = false;
    this.notifyConnection(false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** null tant que l'événement 'status' n'a pas encore été reçu (juste après connect(), avant l'aller-retour avec le matériel). */
  getHardwareStatus(): RfxComHardwareStatus | null {
    return this.hardwareStatus;
  }

  /**
   * Pousse la liste de protocoles à activer AU MATÉRIEL — pour la session en cours uniquement,
   * en RAM (bibliothèque `rfxcom` : commande "mode"/configureRFX, PAS saveRFXProtocols). Rien
   * n'est jamais écrit en mémoire non volatile du RFXtrx433 par cette méthode ; à reposer à
   * chaque connexion, le matériel oublie ce choix à la prochaine coupure d'alimentation.
   * Nécessite le statut matériel déjà reçu (receiverTypeCode, pour résoudre les descripteurs
   * {bit,msg} attendus par la bibliothèque) — rejette sinon. Noms non reconnus pour ce type de
   * récepteur ignorés silencieusement (ex: un nom valide sur un autre modèle RFXtrx).
   */
  pushEnabledProtocols(names: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.device || !this.hardwareStatus) {
        reject(new Error('Transceiver non connecté ou statut matériel pas encore reçu'));
        return;
      }
      const protocolTable = (rfxcom as any).protocols?.[this.hardwareStatus.receiverTypeCode] || {};
      const descriptors = names.map((name) => protocolTable[name]).filter((d) => !!d);
      if (descriptors.length === 0) {
        this.logger.warn('RfxComTransceiver', 'Aucun protocole matériel valide à pousser (liste vide ou noms non reconnus pour ce récepteur).');
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('Pas d\'accusé de réception du matériel pour la mise à jour des protocoles (timeout)'));
      }, 5000);
      (this.device as any).enableRFXProtocols(descriptors, () => {
        clearTimeout(timeout);
        this.logger.info('RfxComTransceiver',
          `Protocoles matériel poussés pour la session (RAM, sans écriture EEPROM) : ${names.join(', ')}`);
        resolve();
      });
    });
  }

  /**
   * Redemande au matériel son statut (receiverType/firmware/protocoles actuellement actifs) sans
   * reconnexion complète — commande "get status" de la bibliothèque `rfxcom`. La réponse arrive de
   * façon asynchrone via le même événement 'status' que onHardwareStatus() écoute déjà ; getHardwareStatus()
   * reflète le nouveau statut une fois la réponse reçue.
   */
  refreshHardwareStatus(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.device) {
        reject(new Error('Transceiver non connecté'));
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('Pas de réponse du matériel à la demande de statut (timeout)'));
      }, 5000);
      (this.device as any).getRFXStatus(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  onMessage(callback: MessageCallback): void {
    this.messageCallbacks.push(callback);
  }

  onConnectionChange(callback: ConnectionCallback): void {
    this.connectionCallbacks.push(callback);
  }

  // ==========================================================================
  // Réception — écoute de chaque événement protocole et normalisation
  // ==========================================================================

  private setupProtocolListeners(device: rfxcom.RfxCom): void {
    for (const [eventName, { type, table }] of Object.entries(LIGHTING_EVENTS)) {
      device.on(eventName, (evt: any) => {
        const { sensorId, unitCode } = this.resolveSensorIdentity(type, evt);
        this.emitMessage({
          type,
          subType: table[evt.subtype] ?? String(evt.subtype),
          sensorId,
          unitCode,
          commandDeviceId: this.buildCommandDeviceId(type, evt),
          seqNbr: evt.seqnbr,
          signalLevel: evt.rssi ?? 0,
          batteryLevel: evt.battery ?? 0,
          data: { command: evt.command, level: evt.level },
          timestamp: new Date()
        });
      });
    }

    device.on('temperaturehumidity1', (evt: any) => {
      const base = {
        sensorId: evt.id,
        seqNbr: evt.seqnbr,
        signalLevel: evt.rssi ?? 0,
        batteryLevel: evt.batteryLevel ?? 0,
        timestamp: new Date()
      };
      this.emitMessage({ ...base, type: 'RFXSensor', subType: 'Temperature', data: { temperature: evt.temperature } });
      this.emitMessage({ ...base, type: 'RFXSensor', subType: 'Humidity', data: { humidity: evt.humidity, humidityStatus: evt.humidityStatus } });
    });

    device.on('temperature1', (evt: any) => {
      this.emitMessage({
        type: 'RFXSensor',
        subType: 'Temperature',
        sensorId: evt.id,
        seqNbr: evt.seqnbr,
        signalLevel: evt.rssi ?? 0,
        batteryLevel: evt.batteryLevel ?? 0,
        data: { temperature: evt.temperature },
        timestamp: new Date()
      });
    });

    device.on('humidity1', (evt: any) => {
      this.emitMessage({
        type: 'RFXSensor',
        subType: 'Humidity',
        sensorId: evt.id,
        seqNbr: evt.seqnbr,
        signalLevel: evt.rssi ?? 0,
        batteryLevel: evt.batteryLevel ?? 0,
        data: { humidity: evt.humidity },
        timestamp: new Date()
      });
    });

    device.on('security1', (evt: any) => {
      // La bibliothèque rfxcom ne distingue pas nativement motion/contact autrement que par le
      // nom du subtype (ex: "X10_PIR" vs "X10_DOOR") — heuristique sur ce nom, best-effort.
      const subtypeName = rfxcom.security1[evt.subtype] ?? String(evt.subtype);
      const isMotion = /PIR|MOTION/i.test(subtypeName);
      this.emitMessage({
        type: 'RFXSensor',
        subType: isMotion ? 'Motion' : 'Contact',
        sensorId: evt.id,
        seqNbr: evt.seqnbr,
        signalLevel: evt.rssi ?? 0,
        batteryLevel: evt.batteryLevel ?? 0,
        data: { deviceStatus: evt.deviceStatus, subtypeRaw: subtypeName },
        timestamp: new Date()
      });
    });

    device.on('elec1', (evt: any) => {
      this.emitMessage({
        type: 'RFXMeter',
        subType: 'Current',
        sensorId: evt.id,
        seqNbr: evt.seqnbr,
        signalLevel: evt.rssi ?? 0,
        batteryLevel: evt.batteryLevel ?? 0,
        data: { current: Array.isArray(evt.current) ? evt.current[0] : evt.current },
        timestamp: new Date()
      });
    });

    device.on('elec23', (evt: any) => {
      this.emitMessage({
        type: 'RFXMeter',
        subType: 'Power',
        sensorId: evt.id,
        seqNbr: evt.seqnbr,
        signalLevel: evt.rssi ?? 0,
        batteryLevel: evt.batteryLevel ?? 0,
        data: { power: evt.power, energy: evt.energy },
        timestamp: new Date()
      });
    });

    device.on('blinds1', (evt: any) => {
      this.emitMessage({
        type: 'Blinds1',
        subType: rfxcom.blinds1[evt.subtype] ?? String(evt.subtype),
        sensorId: evt.id,
        unitCode: evt.unitCode,
        commandDeviceId: evt.id,
        seqNbr: evt.seqnbr,
        signalLevel: evt.rssi ?? 0,
        batteryLevel: evt.battery ?? 0,
        data: { command: evt.command },
        timestamp: new Date()
      });
    });
  }

  private emitMessage(message: RfxComRawMessage): void {
    for (const callback of this.messageCallbacks) {
      try {
        callback(message);
      } catch (error) {
        this.logger.error('RfxComTransceiver', `Erreur dans callback de message: ${error}`);
      }
    }
  }

  private notifyConnection(connected: boolean, error?: string): void {
    for (const callback of this.connectionCallbacks) {
      try {
        callback(connected, error);
      } catch (err) {
        this.logger.error('RfxComTransceiver', `Erreur dans callback de connexion: ${err}`);
      }
    }
  }

  /**
   * Résout (sensorId, unitCode) selon le protocole — reproduit la règle observée dans le pont
   * MQTT rfxcom2hass précédemment en place (analysée en session avec l'utilisateur à partir de
   * sa découverte MQTT réelle et d'un extrait de son code) : la plupart des protocoles Lighting
   * ont un `id` (house code hex) et un `unitCode` séparés — mais Lighting1 (ARC) encode
   * `houseCode`+`unitCode` fusionnés en un seul identifiant sans séparateur (ex: "e2", pas
   * "e_2"), et Lighting4 n'a ni `id` ni `houseCode` du tout, seulement `data` (payload PT2262 brut
   * en hex) — cf. rfxcom.js::lighting1Handler/lighting4Handler. Sans ce cas particulier, Lighting1
   * utilisait par erreur le champ `id` (hex, présent mais qualifié de "Redundant?" dans la
   * librairie elle-même) au lieu du vrai house code lettré, et Lighting4 recevait un `sensorId`
   * `undefined` (pas de champ `id` du tout pour ce protocole).
   */
  private resolveSensorIdentity(type: RfxComDeviceType, evt: any): { sensorId: string; unitCode?: number } {
    switch (type) {
      case 'Lighting1':
        return { sensorId: `${evt.houseCode}${evt.unitCode}`.toLowerCase() };
      case 'Lighting4':
        return { sensorId: String(evt.data).toLowerCase() };
      default:
        return { sensorId: evt.id, unitCode: evt.unitCode };
    }
  }

  /**
   * Construit l'identifiant déjà prêt pour renvoyer une commande via la classe Transmitter
   * correspondante — le format diffère par protocole (voir types/rfxcom.d.ts).
   */
  private buildCommandDeviceId(type: RfxComDeviceType, evt: any): string | undefined {
    switch (type) {
      case 'Lighting1':
        return `${evt.houseCode}${evt.unitCode}`;
      case 'Lighting2':
        return `${evt.id}/${evt.unitCode}`;
      default:
        return undefined;
    }
  }

  // ==========================================================================
  // Envoi de commandes
  // ==========================================================================

  /**
   * Envoie une commande à un device physique. `subType` doit être le nom du sous-protocole
   * (ex: "AC" pour Lighting2), utilisé pour instancier le bon Transmitter.
   */
  sendCommand(
    protocole: string,
    subType: string,
    commandDeviceId: string,
    action: 'on' | 'off' | 'set_level' | 'open' | 'close' | 'stop',
    value?: number
  ): void {
    if (!this.device) {
      throw new Error('Transceiver non initialisé');
    }

    const transmitter = this.getOrCreateTransmitter(protocole, subType);
    if (!transmitter) {
      throw new Error(`Protocole non supporté pour l'envoi de commandes: ${protocole}`);
    }

    const ack = this.buildAckLogger(protocole, commandDeviceId, action);

    switch (protocole) {
      case 'lighting1': {
        const t = transmitter as rfxcom.Lighting1;
        if (action === 'on') t.switchOn(commandDeviceId, ack);
        else if (action === 'off') t.switchOff(commandDeviceId, ack);
        else throw new Error(`Action non supportée pour lighting1: ${action}`);
        break;
      }
      case 'lighting2': {
        const t = transmitter as rfxcom.Lighting2;
        if (action === 'on') t.switchOn(commandDeviceId, ack);
        else if (action === 'off') t.switchOff(commandDeviceId, ack);
        else if (action === 'set_level') {
          // Échelle RFXCOM native 0-15, value reçu en 0-100%
          const level = Math.max(0, Math.min(15, Math.round(((value ?? 100) / 100) * 15)));
          t.setLevel(commandDeviceId, level, ack);
        } else throw new Error(`Action non supportée pour lighting2: ${action}`);
        break;
      }
      case 'blinds1': {
        const t = transmitter as rfxcom.Blinds1;
        if (action === 'open') t.open(commandDeviceId, ack);
        else if (action === 'close') t.close(commandDeviceId, undefined, ack);
        else if (action === 'stop') t.stop(commandDeviceId, ack);
        else throw new Error(`Action non supportée pour blinds1: ${action}`);
        break;
      }
      default:
        throw new Error(`Protocole non supporté pour l'envoi de commandes: ${protocole}`);
    }
  }

  /**
   * Callback passé à la lib `rfxcom` — invoqué quand la trame a été écrite sur le port série
   * (confirmation d'écriture bas niveau, PAS une confirmation RF433 du récepteur physique : la
   * lib ne remonte pas cette dernière jusqu'à l'appelant, voir rfxcom.js::transmit). Pour
   * l'instant, on se contente de tracer — pas encore utilisé pour conditionner la publication
   * d'état (voir RfxComService.applyReceiverCommand, qui reste optimiste).
   */
  private buildAckLogger(protocole: string, commandDeviceId: string, action: string): rfxcom.TransmitCallback {
    return (error, response, seqnbr) => {
      if (error) {
        this.logger.warn('RfxComTransceiver', `ACK échoué pour ${protocole}/${commandDeviceId} (${action}), seqnbr=${seqnbr}: ${error.message}`);
      } else {
        this.logger.debug('RfxComTransceiver', `ACK reçu pour ${protocole}/${commandDeviceId} (${action}), seqnbr=${seqnbr}, réponse=${response}`);
      }
    };
  }

  private getOrCreateTransmitter(protocole: string, subType: string): unknown {
    if (!this.device) return undefined;

    const key = `${protocole}:${subType}`;
    const cached = this.transmitters.get(key);
    if (cached) return cached;

    let transmitter: unknown;
    switch (protocole) {
      case 'lighting1':
        transmitter = new rfxcom.Lighting1(this.device, rfxcom.lighting1[subType] ?? 0);
        break;
      case 'lighting2':
        transmitter = new rfxcom.Lighting2(this.device, rfxcom.lighting2[subType] ?? 0);
        break;
      case 'blinds1':
        transmitter = new rfxcom.Blinds1(this.device, rfxcom.blinds1[subType] ?? 0);
        break;
      default:
        return undefined;
    }

    this.transmitters.set(key, transmitter);
    return transmitter;
  }
}
