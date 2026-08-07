/**
 * PollClient
 *
 * Backend d'acquisition "poll" : va chercher les relevés directement sur la page web intégrée du
 * BS1000 (`GET /sdata_table.txt`) à intervalle régulier, au lieu d'attendre un push. Port
 * arexx2hass FromHttp — y compris son parsing HTML par remplacements de chaînes successifs (le
 * BS1000 renvoie un pseudo-tableau HTML, pas du JSON ; ce parsing est fragile mais fidèle à
 * l'original, aucun format alternatif documenté par Arexx).
 *
 * Contrairement au mode push, la nature du capteur (température/humidité) n'est pas donnée par un
 * code `type` mais déduite de l'unité renvoyée par le BS1000 lui-même.
 */

import http from 'node:http';
import type { Logger } from '../../../../core/dist/exports';
import type { ArexxConfig } from '../config-schema';
import type { ArexxRawReading } from '../types';

const AREXX_EPOCH_OFFSET_SECONDS = 946684800; // 2000-01-01T00:00:00Z - 1970-01-01T00:00:00Z
const MAX_CONSECUTIVE_ANOMALIES = 3;

interface ParsedRow {
  valtime: number;
  value: number;
  unit: string;
  dbm?: number;
}

export class PollClient {
  private timer?: NodeJS.Timeout;
  private consecutiveErrors = 0;

  constructor(
    private readonly config: ArexxConfig,
    private readonly logger: Logger,
    private readonly onReading: (reading: ArexxRawReading) => void
  ) {}

  async start(): Promise<void> {
    if (!this.config.bs1000Address) {
      this.logger.error('PollClient', 'Mode poll sélectionné sans bs1000Address configurée');
      return;
    }
    this.consecutiveErrors = 0;
    this.timer = setInterval(() => this.poll(), this.config.pollIntervalSeconds * 1000);
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private poll(): void {
    http
      .get(
        { host: this.config.bs1000Address, port: this.config.bs1000Port, path: '/sdata_table.txt' },
        (response) => this.handleResponse(response)
      )
      .on('error', (err) => {
        this.consecutiveErrors++;
        this.logger.warn('PollClient', `Erreur GET vers ${this.config.bs1000Address}: ${err.message} (${this.consecutiveErrors})`);
        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ANOMALIES) {
          this.logger.error('PollClient', `${MAX_CONSECUTIVE_ANOMALIES} échecs consécutifs, BS1000 injoignable`);
        }
      });
  }

  private handleResponse(response: http.IncomingMessage): void {
    let body = '';
    response.on('data', (chunk: string) => {
      body += chunk;
    });
    response.on('end', () => {
      const rows = this.parseTable(body);
      if (Object.keys(rows).length === 0) {
        this.consecutiveErrors++;
        return;
      }
      this.consecutiveErrors = 0;
      for (const [rawId, row] of Object.entries(rows)) {
        this.onReading({
          rawId,
          kind: row.unit.toUpperCase().includes('RH') || row.unit.includes('%') ? 'humidity' : 'temperature',
          value: row.value,
          signalDbm: row.dbm,
          timestamp: new Date((row.valtime + AREXX_EPOCH_OFFSET_SECONDS) * 1000)
        });
      }
    });
  }

  /** Parsing fidèle à arexx2hass FromHttp.traitReponse — pseudo-HTML transformé en JSON. */
  private parseTable(body: string): Record<string, ParsedRow> {
    if (!body) return {};
    let transformed = body;
    while (transformed.indexOf('<tr>') > -1) {
      transformed = transformed
        .replace('<tr>', '')
        .replace('</tr>', ',')
        .replace('<td>', '"')
        .replace('</td>', '": {')
        .replace('<td t="', '"valtime" :')
        .replace('"></td>', ',')
        .replace('<td>', '"value" :')
        .replace('</td>', ',')
        .replace('<td>', '"unit" :"')
        .replace('</td>', '",')
        .replace('<td title="', '"dbm" :')
        .replace('dBm">', ',')
        .replace('<div class="rssi" style="width:', '"rssi" :')
        .replace('%;"></div></td>', '}')
        .replace('&#176;', '°');
    }
    if (!transformed) return {};
    transformed = `{${transformed}}`.replace(',}', '}');
    try {
      return JSON.parse(transformed) as Record<string, ParsedRow>;
    } catch (error) {
      this.logger.warn('PollClient', `Réponse BS1000 non parsable: ${error}`);
      return {};
    }
  }
}
