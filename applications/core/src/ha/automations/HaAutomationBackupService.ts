// src/ha/automations/HaAutomationBackupService.ts
// Sauvegarde et rechargement des automatisations HA, exposés en REST par PresentationServer.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../../infrastructure/logger/index';
import type { HaWsClient } from '../sync/HaWsClient';
import type { HaStructureRegistry } from '../sync/HaStructureRegistry';
import type { HaWsConfig } from '../../infrastructure/config/schema';

export interface AutomationBackupResult {
  success: boolean;
  filename?: string;
  count?: number;
  error?: string;
}

export interface AutomationReloadResult {
  success: boolean;
  error?: string;
}

/** Nombre de sauvegardes conservées (les plus anciennes sont supprimées au-delà). */
const MAX_BACKUPS_KEPT = 10;

/**
 * Sauvegarde/rechargement des automatisations HA — exposés en REST (POST /api/ha/automations/backup,
 * POST /api/ha/automations/reload), pensés pour être déclenchés depuis l'extérieur (script,
 * automatisation HA elle-même, cron), pas seulement depuis un navigateur connecté en Socket.io :
 * contrairement au reste du projet, la réponse HTTP porte donc directement le résultat réel plutôt
 * qu'un simple accusé de réception suivi d'un événement Socket.io asynchrone.
 *
 * HA n'expose aucune commande WebSocket pour lire la config brute d'une automatisation (seule
 * `automation.reload` — un vrai appel de service — l'est) : la lecture passe par la route REST HA
 * `GET /api/config/automation/config/{id}` (celle qu'utilise l'éditeur d'automatisations du
 * frontend HA lui-même), un appel par automatisation, avec le même jeton longue durée que le
 * WebSocket (voir HaWsConfig).
 */
export class HaAutomationBackupService {
  private readonly backupDir: string;

  constructor(
    private readonly haWsClient: HaWsClient,
    private readonly haStructureRegistry: HaStructureRegistry,
    private readonly haWsConfig: HaWsConfig,
    private readonly logger: Logger,
    projectRoot: string
  ) {
    this.backupDir = path.join(projectRoot, 'data', 'core', 'automations-backups');
  }

  async backup(): Promise<AutomationBackupResult> {
    try {
      const automations = this.haStructureRegistry.getAllEntities().filter((entity) => entity.domain === 'automation');

      const configs: Array<{ entity_id: string; id: string; friendly_name?: string; config: unknown }> = [];
      for (const automation of automations) {
        const automationId = automation.attributes?.id;
        if (typeof automationId !== 'string' && typeof automationId !== 'number') {
          this.logger.warn('HaAutomationBackupService', `Automatisation sans id exploitable, ignorée: ${automation.entity_id}`);
          continue;
        }

        const config = await this.fetchAutomationConfig(String(automationId));
        configs.push({
          entity_id: automation.entity_id,
          id: String(automationId),
          friendly_name: typeof automation.attributes?.friendly_name === 'string' ? automation.attributes.friendly_name : undefined,
          config
        });
      }

      fs.mkdirSync(this.backupDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `automations_backup_${timestamp}.json`;
      fs.writeFileSync(
        path.join(this.backupDir, filename),
        JSON.stringify({ timestamp: new Date().toISOString(), count: configs.length, automations: configs }, null, 2),
        'utf-8'
      );
      this.pruneOldBackups();

      this.logger.info('HaAutomationBackupService', `Sauvegarde de ${configs.length} automatisation(s) : ${filename}`);
      return { success: true, filename, count: configs.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('HaAutomationBackupService', `Échec de la sauvegarde des automatisations: ${message}`);
      return { success: false, error: message };
    }
  }

  async reload(): Promise<AutomationReloadResult> {
    try {
      await this.haWsClient.sendCommand('automation', 'reload', {});
      this.logger.info('HaAutomationBackupService', 'Rechargement des automatisations demandé à HA');
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('HaAutomationBackupService', `Échec du rechargement des automatisations: ${message}`);
      return { success: false, error: message };
    }
  }

  listBackups(): string[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.json')).sort().reverse();
  }

  private async fetchAutomationConfig(automationId: string): Promise<unknown> {
    const url = `http://${this.haWsConfig.host}:${this.haWsConfig.port}/api/config/automation/config/${encodeURIComponent(automationId)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.haWsConfig.token}` } });
    if (!response.ok) {
      throw new Error(`GET ${url} → HTTP ${response.status}`);
    }
    return response.json();
  }

  private pruneOldBackups(): void {
    const files = this.listBackups();
    for (const file of files.slice(MAX_BACKUPS_KEPT)) {
      try {
        fs.unlinkSync(path.join(this.backupDir, file));
      } catch {
        // Non bloquant : un fichier qu'on n'arrive pas à supprimer n'empêche pas la sauvegarde en cours.
      }
    }
  }
}
