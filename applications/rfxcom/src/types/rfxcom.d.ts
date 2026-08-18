/**
 * Déclarations TypeScript minimales pour la bibliothèque npm `rfxcom` (v2.6.2).
 *
 * Le package ne fournit pas ses propres types. Cette déclaration ne couvre QUE la surface
 * réellement utilisée par RfxComTransceiver.ts — vérifiée directement dans le code source
 * installé (node_modules/rfxcom/lib/), car implementation-rfxcom_specs_v1.2.md décrit une API
 * qui ne correspond PAS à la version réellement publiée (pas d'événement générique 'device',
 * signatures de commandes différentes — voir le plan d'implémentation pour le détail).
 */

declare module 'rfxcom' {
  import { EventEmitter } from 'node:events';

  export interface RfxComOptions {
    debug?: boolean;
    deviceParameters?: Record<string, unknown>;
  }

  /**
   * Table de correspondance numéro↔nom pour un protocole (ex: rfxcom.lighting2[0] === 'AC',
   * rfxcom.lighting2['AC'] === 0) — produite par reflect() dans la bibliothèque.
   */
  export type ProtocolSubtypeTable = Record<number, string> & Record<string, number>;

  export class RfxCom extends EventEmitter {
    constructor(device: string, options?: RfxComOptions);

    /** Démarre la connexion série + la séquence de handshake. Callback appelé sans argument au succès. */
    initialise(callback?: () => void): void;
    close(): void;

    // Événements de cycle de vie réels (voir rfxcom.js) :
    //   'connecting'                → port ouvert, handshake démarré
    //   'ready'                     → transceiver prêt à émettre/recevoir
    //   'disconnect'  (message: string) → perte de connexion après avoir été connecté
    //   'connectfailed' (message: string) → échec de connexion initiale
    //   'receiverstarted'           → confirmation de démarrage de la réception
    //   'response' (message: string, seqnbr: number, cmd: number) → accusé de réception de commande
    // Événements par protocole (payload différent par type, voir chaque Handler dans rfxcom.js) :
    //   'lighting1', 'lighting2', 'lighting4', 'lighting5', 'lighting6', 'blinds1',
    //   'temperature1', 'humidity1', 'temperaturehumidity1', 'elec1', 'elec23', 'security1', ...
    on(event: string, listener: (...args: any[]) => void): this;

    static dumpHex(buffer: number[] | Buffer, prefix?: boolean): string[];
  }

  // Payloads réels des événements protocole utilisés (vérifiés dans rfxcom.js) -----------------

  export interface Lighting1Event {
    subtype: number;
    seqnbr: number;
    id: string;             // "0x.." — house code encodé, cf. lighting1Handler
    unitCode: number;
    command: string;
    commandNumber: number;
    rssi: number;            // 0-15
  }

  export interface Lighting2Event {
    subtype: number;
    seqnbr: number;
    id: string;              // "0x.."
    unitCode: number;
    command: string;
    commandNumber: number;
    level: number;           // 0-15
    rssi: number;            // 0-15
  }

  export interface Blinds1Event {
    subtype: number;
    seqnbr: number;
    id: string;
    unitCode: number;
    command: string;
    battery?: number;
    rssi: number;
  }

  export interface TemperatureHumidity1Event {
    subtype: number;
    seqnbr: number;
    id: string;
    temperature: number;     // °C
    humidity: number;        // %
    humidityStatus: number;
    batteryLevel: number;    // 0-9 (nibble bas)
    rssi: number;            // 0-15 (nibble haut)
  }

  export interface Temperature1Event {
    subtype: number;
    seqnbr: number;
    id: string;
    temperature: number;
    batteryLevel: number;
    rssi: number;
  }

  export interface Elec1Event {
    subtype: number;
    seqnbr: number;
    id: string;
    current: [number, number, number];
    batteryLevel: number;
    rssi: number;
  }

  // Transmitters ---------------------------------------------------------------------------

  export abstract class Transmitter {
    constructor(rfxcom: RfxCom, subtype: number, options?: Record<string, unknown>);
  }

  /** Signature réelle du callback passé aux méthodes de transmission — voir rfxcom.js::transmit,
   *  invoqué une fois la trame écrite sur le port série (pas une confirmation RF433 du récepteur). */
  export type TransmitCallback = (err: Error | null, response: string, seqnbr: number) => void;

  export class Lighting1 extends Transmitter {
    switchOn(deviceId: string, callback?: TransmitCallback): void;
    switchOff(deviceId: string, callback?: TransmitCallback): void;
  }

  export class Lighting2 extends Transmitter {
    /** deviceId au format "0xID/unitCode" (unitCode 0 = commande de groupe). */
    switchOn(deviceId: string, callback?: TransmitCallback): void;
    switchOff(deviceId: string, callback?: TransmitCallback): void;
    /** level: 0-15 (échelle native RFXCOM, PAS 0-100). */
    setLevel(deviceId: string, level: number, callback?: TransmitCallback): void;
  }

  export class Lighting4 extends Transmitter {
    sendData(data: string, pulseWidth: number, callback?: TransmitCallback): void;
  }

  export class Blinds1 extends Transmitter {
    open(deviceId: string, callback?: TransmitCallback): void;
    close(deviceId: string, direction?: number, callback?: TransmitCallback): void;
    stop(deviceId: string, callback?: TransmitCallback): void;
  }

  /** Volets Somfy RTS — jamais d'événement reçu (voir Rfy.js, aucun décodeur de réception dans la
   *  lib), seulement des commandes. deviceId au format "id/unitCode" (identique à Lighting2). */
  export class Rfy extends Transmitter {
    up(deviceId: string, callback?: TransmitCallback): void;
    down(deviceId: string, callback?: TransmitCallback): void;
    stop(deviceId: string, callback?: TransmitCallback): void;
  }

  // Tables de protocoles (numéro ↔ nom), une par famille -------------------------------------
  export const lighting1: ProtocolSubtypeTable;
  export const lighting2: ProtocolSubtypeTable;
  export const lighting4: ProtocolSubtypeTable;
  export const lighting5: ProtocolSubtypeTable;
  export const lighting6: ProtocolSubtypeTable;
  export const blinds1: ProtocolSubtypeTable;
  export const rfy: ProtocolSubtypeTable;
  export const security1: ProtocolSubtypeTable;

  /** hex packetType (ex: 0x11) → nom (ex: "lighting2"), et l'inverse. */
  export const packetNames: Record<number, string> & Record<string, number>;
}
