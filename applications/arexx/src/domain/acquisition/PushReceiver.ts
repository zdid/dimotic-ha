/**
 * PushReceiver
 *
 * Backend d'acquisition "push" : serveur HTTP local (Express) recevant les relevés POSTés par un
 * BS1000 (configuré via son admin web pour pousser vers ce serveur, voir rulefile.txt) ou par le
 * binaire USB rf_usb_http.elf (mode 'usb', voir UsbBridge). Port arexx2hass HttpServ.
 *
 * Format du payload form-encoded (inchangé, matériel Arexx) :
 *   type=1&id=8962&time=501092328&v=20.3&rssi=-101&missing=501092328
 * `type==='3'` signifie humidité, tout le reste est température. `time` est en secondes depuis
 * l'an 2000 (offset 946684800 par rapport à l'epoch Unix), pas utilisé pour l'instant au-delà de
 * la validation de fraîcheur (voir ArexxRawReading.timestamp).
 */

import express, { type Express, type Request, type Response } from 'express';
import http from 'node:http';
import type { Logger } from '../../../../core/dist/exports';
import type { ArexxConfig } from '../config-schema';
import type { ArexxRawReading } from '../types';

const AREXX_EPOCH_OFFSET_SECONDS = 946684800; // 2000-01-01T00:00:00Z - 1970-01-01T00:00:00Z

export class PushReceiver {
  private app: Express;
  private server?: http.Server;

  constructor(
    private readonly config: ArexxConfig,
    private readonly logger: Logger,
    private readonly onReading: (reading: ArexxRawReading) => void
  ) {
    this.app = express();
    this.app.use(express.urlencoded({ extended: false }));
  }

  private handleIncoming(req: Request, res: Response): void {
    const body = req.body as Record<string, string>;
    this.logger.debug('PushReceiver', `Réception: ${JSON.stringify(body)}`);

    const typecapt = body.type;
    const value = parseFloat(body.v);
    const dbm = body.rssi ? parseFloat(body.rssi) : undefined;
    const time = parseFloat(body.time);
    const rawId = body.id;

    if (!rawId || Number.isNaN(value)) {
      this.logger.warn('PushReceiver', `Payload invalide, ignoré: ${JSON.stringify(body)}`);
      res.send('ko');
      return;
    }

    const reading: ArexxRawReading = {
      rawId,
      kind: typecapt === '3' ? 'humidity' : 'temperature',
      value,
      signalDbm: Number.isNaN(dbm as number) ? undefined : dbm,
      timestamp: Number.isNaN(time) ? new Date() : new Date((time + AREXX_EPOCH_OFFSET_SECONDS) * 1000)
    };

    this.onReading(reading);
    res.send('ok');
  }

  start(): void {
    const port = this.config.httpservPort;
    this.app.all('/', (req, res) => this.handleIncoming(req, res));
    this.app.all('/rules', (req, res) => this.handleIncoming(req, res));
    this.server = http.createServer(this.app).listen(port, () => {
      this.logger.info('PushReceiver', `Serveur HTTP AREXX en écoute sur le port ${port}`);
    });
  }

  stop(): void {
    this.server?.close();
    this.logger.info('PushReceiver', 'Serveur HTTP AREXX arrêté');
  }
}
