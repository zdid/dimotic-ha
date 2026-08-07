/**
 * UsbBridge
 *
 * Backend d'acquisition "usb" : BS500 branché en direct sur la machine hébergeant ws-ha (hors
 * Docker, arm/v6 ou arm/v7 uniquement — RPi 3/4/5 en distribution arm64 ne fonctionnent pas avec
 * ce binaire, incident connu et remonté à Arexx). Spawn du binaire ARM compilé `rf_usb_http.elf`
 * (vendored tel quel depuis arexx2hass, `rf_usb_http_rpi_0_6/`), qui lit le dongle USB et repousse
 * ses résultats en HTTP vers PushReceiver (démarré en parallèle par ArexxService en mode 'usb') —
 * port arexx2hass RfUsb.
 */

import { type ChildProcessWithoutNullStreams, exec, spawn } from 'node:child_process';
import * as path from 'node:path';
import type { Logger } from '../../../../core/dist/exports';
import type { ArexxConfig } from '../config-schema';

export class UsbBridge {
  private readonly binaryDir = path.join(__dirname, '..', '..', '..', 'rf_usb_http_rpi_0_6');
  private readonly binaryPath = path.join(this.binaryDir, 'rf_usb_http.elf');
  private readonly rulefilePath = path.join(this.binaryDir, 'rulefile.txt');
  private command?: ChildProcessWithoutNullStreams;

  constructor(
    private readonly config: ArexxConfig,
    private readonly logger: Logger
  ) {}

  start(): void {
    exec(`chmod +x ${this.binaryPath}`, (err) => {
      if (err) {
        this.logger.error('UsbBridge', `Impossible de rendre ${this.binaryPath} exécutable: ${err.message}`);
      }
      this.spawnProcess();
    });
  }

  private spawnProcess(): void {
    this.logger.info('UsbBridge', `Démarrage de ${this.binaryPath}`);
    this.command = spawn(this.binaryPath, ['-v', this.rulefilePath], { cwd: this.binaryDir });

    this.command.stderr.on('data', (data: Buffer) => {
      this.logger.error('UsbBridge', `stderr: ${data.toString().trim()}`);
    });
    this.command.stdout.on('data', (data: Buffer) => {
      this.logger.debug('UsbBridge', `stdout: ${data.toString().trim()}`);
    });
    this.command.on('close', (code) => {
      this.logger.info('UsbBridge', `rf_usb_http.elf terminé (code ${code})`);
      this.command = undefined;
    });
    this.command.on('error', (err) => {
      this.logger.error('UsbBridge', `Échec du démarrage de rf_usb_http.elf: ${err.message}`);
    });
  }

  stop(): void {
    if (this.command) {
      this.logger.info('UsbBridge', 'Arrêt de rf_usb_http.elf');
      this.command.kill('SIGKILL');
    }
  }
}
