// src/ha/HaRestBridge.ts
//
// Pont générique entre les apps en process séparé et l'API REST config de HA
// (GET/POST/DELETE /api/config/{domain}/config/{id}, voir HaWsClient.getDomainConfig/
// setDomainConfig/deleteDomainConfig) — cette API n'est joignable que depuis le process `core`
// (seul détenteur de HaWsClient/du jeton HA), alors que le CRUD lui-même peut être demandé par une
// app tournant dans un autre process (ex: applications/scriptsha).
//
// Générique par construction : ce fichier ne connaît AUCUN nom d'app. Sens app→core est automatique
// (tout process.send() d'un enfant arrive au bus local du core via SupervisorEventBridge), sens
// core→app est explicite — chaque app intéressée doit déclarer `<appId>:ha:rest:result` dans son
// propre `bridgedEvents` (ApplicationModule), exactement comme espdisplay le fait déjà pour
// `espdisplay:deploy-floorplan` (voir guide-nouvelle-application_specs).

import type { IEventBus } from '../application/IEventBus';
import type { HaWsClient } from './sync/HaWsClient';
import type { Logger } from '../infrastructure/logger/index';

export interface HaRestRequest {
  appId: string;
  method: 'set' | 'delete' | 'get';
  domain: string;
  id: string;
  config?: unknown;
}

export interface HaRestResult {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export class HaRestBridge {
  constructor(
    private readonly eventBus: IEventBus,
    private readonly haWsClient: HaWsClient | undefined,
    private readonly logger: Logger
  ) {
    this.eventBus.onGeneric<HaRestRequest>('ha:rest:request', (req) => {
      void this.handleRequest(req);
    });
  }

  private async handleRequest(req: HaRestRequest): Promise<void> {
    const replyEvent = `${req.appId}:ha:rest:result`;

    if (!this.haWsClient) {
      this.eventBus.emitGeneric<HaRestResult>(replyEvent, { id: req.id, success: false, error: 'HA non connecté' });
      return;
    }

    try {
      let result: unknown;
      if (req.method === 'set') {
        await this.haWsClient.setDomainConfig(req.domain, req.id, req.config);
        await this.haWsClient.sendCommand(req.domain, 'reload', {});
      } else if (req.method === 'delete') {
        await this.haWsClient.deleteDomainConfig(req.domain, req.id);
      } else {
        result = await this.haWsClient.getDomainConfig(req.domain, req.id);
      }
      this.eventBus.emitGeneric<HaRestResult>(replyEvent, { id: req.id, success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('HaRestBridge', `Échec ${req.method} ${req.domain}/${req.id} pour ${req.appId}: ${message}`);
      this.eventBus.emitGeneric<HaRestResult>(replyEvent, { id: req.id, success: false, error: message });
    }
  }
}
