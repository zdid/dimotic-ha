// src/application/__tests__/TargetGossipService.test.ts
// Tests unitaires pour la réconciliation/présence/suppression de TargetGossipService (⭐ 31/08/2026)
// — voir l'en-tête de TargetGossipService.ts pour le contexte (bug réel : un changement d'IP ne se
// propageait jamais aux autres machines).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TargetGossipService } from '../TargetGossipService';
import type { ConfigService } from '../../infrastructure/config/ConfigService';
import type { IEventBus } from '../IEventBus';
import type { Logger } from '../../infrastructure/logger';
import type { DeploymentTargetConfig } from '../../infrastructure/config/schema';

function makeMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    getLevel: vi.fn().mockReturnValue('info'),
    setLevel: vi.fn(),
  } as unknown as Logger;
}

function makeMockEventBus(): IEventBus {
  return {
    on: vi.fn(),
    emit: vi.fn(),
    onAll: vi.fn(),
    onGeneric: vi.fn(),
    emitGeneric: vi.fn(),
    offGeneric: vi.fn(),
    onceGeneric: vi.fn(),
  } as unknown as IEventBus;
}

/** Cible locale minimale, prête à être filtrée/renommée par mergeTargets. */
function target(id: string, host: string, origin: 'local' | 'gossip' = 'local'): DeploymentTargetConfig {
  return { id, host, remoteDir: '/docker/dimotic-ha', origin } as DeploymentTargetConfig;
}

describe('TargetGossipService', () => {
  let configService: ConfigService;
  let eventBus: IEventBus;
  let logger: Logger;
  let service: TargetGossipService;
  let coreTargets: DeploymentTargetConfig[];
  let mockTransport: { publish: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    coreTargets = [target('ha2', '192.168.1.51')];
    logger = makeMockLogger();
    eventBus = makeMockEventBus();

    configService = {
      getConfig: vi.fn().mockReturnValue({ core: { machineId: 'stfort' } }),
      getTargets: vi.fn(() => coreTargets),
      setTargets: vi.fn((list: DeploymentTargetConfig[]) => {
        coreTargets = list;
        return { success: true };
      }),
      getHaStackTargets: vi.fn(() => []),
      setHaStackTargets: vi.fn(() => ({ success: true })),
      getZigbee2mqttTargets: vi.fn(() => []),
      setZigbee2mqttTargets: vi.fn(() => ({ success: true })),
    } as unknown as ConfigService;

    service = new TargetGossipService(configService, eventBus, logger);
    // Contourne start() (connexion MQTT réelle) — les méthodes testées ici n'ont besoin que
    // d'un transport mocké pour purgeMachine, le reste (mergeTargets/handleStatusMessage/
    // handleRemovedMessage) ne touche pas au transport du tout.
    mockTransport = { publish: vi.fn() };
    (service as any).transport = mockTransport;
  });

  describe('mergeTargets (réconciliation)', () => {
    it('ajoute une cible d\'une nouvelle source', () => {
      (service as any).mergeTargets('orangepi', [{ id: 'orangepi', host: '192.168.1.130', remoteDir: '/docker/dimotic-ha' }], 'core');

      expect(configService.setTargets).toHaveBeenCalledWith([
        target('ha2', '192.168.1.51'),
        expect.objectContaining({ id: 'orangepi::orangepi', host: '192.168.1.130', origin: 'gossip' })
      ]);
    });

    it('met à jour l\'hôte d\'une cible déjà apprise de la même source — le bug réel du 30-31/08/2026', () => {
      coreTargets = [
        target('ha2', '192.168.1.51'),
        target('orangepi::orangepi', '192.168.1.32', 'gossip')
      ];

      (service as any).mergeTargets('orangepi', [{ id: 'orangepi', host: '192.168.1.130', remoteDir: '/docker/dimotic-ha' }], 'core');

      expect(configService.setTargets).toHaveBeenCalledWith([
        target('ha2', '192.168.1.51'),
        expect.objectContaining({ id: 'orangepi::orangepi', host: '192.168.1.130', origin: 'gossip' })
      ]);
    });

    it('retire une cible que la source a elle-même retirée de sa liste', () => {
      coreTargets = [
        target('ha2', '192.168.1.51'),
        target('orangepi::orangepi', '192.168.1.130', 'gossip')
      ];

      (service as any).mergeTargets('orangepi', [], 'core');

      expect(configService.setTargets).toHaveBeenCalledWith([target('ha2', '192.168.1.51')]);
    });

    it('ne touche pas aux cibles locales ni à celles apprises d\'une AUTRE source', () => {
      coreTargets = [
        target('ha2', '192.168.1.51'),
        target('stfort::autre', '192.168.1.99', 'gossip')
      ];

      (service as any).mergeTargets('orangepi', [{ id: 'orangepi', host: '192.168.1.130', remoteDir: '/docker/dimotic-ha' }], 'core');

      const merged = (configService.setTargets as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(merged).toContainEqual(target('ha2', '192.168.1.51'));
      expect(merged).toContainEqual(target('stfort::autre', '192.168.1.99', 'gossip'));
    });

    it('ne réécrit rien ni n\'émet de changement sur un rejeu identique (ex: reconnexion du client gossip)', () => {
      coreTargets = [
        target('ha2', '192.168.1.51'),
        target('orangepi::orangepi', '192.168.1.130', 'gossip')
      ];

      (service as any).mergeTargets('orangepi', [{ id: 'orangepi', host: '192.168.1.130', remoteDir: '/docker/dimotic-ha' }], 'core');

      expect(configService.setTargets).not.toHaveBeenCalled();
      expect(eventBus.emitGeneric).not.toHaveBeenCalledWith('core:deployment:gossip:changed', undefined);
    });
  });

  describe('handleStatusMessage (présence)', () => {
    it('notifie sur une transition online → offline', () => {
      (service as any).handleStatusMessage('orangepi', { payload: Buffer.from('online') });
      (eventBus.emit as ReturnType<typeof vi.fn>).mockClear();

      (service as any).handleStatusMessage('orangepi', { payload: Buffer.from('offline') });

      expect(eventBus.emit).toHaveBeenCalledWith('core:machine:status:list', {
        statuses: [{ machineId: 'orangepi', online: false }]
      });
    });

    it('ne re-notifie pas sur un rejeu identique du statut retenu', () => {
      (service as any).handleStatusMessage('orangepi', { payload: Buffer.from('online') });
      (eventBus.emit as ReturnType<typeof vi.fn>).mockClear();

      (service as any).handleStatusMessage('orangepi', { payload: Buffer.from('online') });

      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('ignore un payload vide (topic retenu nettoyé, pas un vrai statut)', () => {
      (service as any).handleStatusMessage('orangepi', { payload: Buffer.from('') });
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('handleRemovedMessage (suppression confirmée reçue)', () => {
    it('retire uniquement les cibles de la machine supprimée, laisse les autres intactes', () => {
      coreTargets = [
        target('ha2', '192.168.1.51'),
        target('orangepi::orangepi', '192.168.1.130', 'gossip'),
        target('stfort::autre', '192.168.1.99', 'gossip')
      ];

      (service as any).handleRemovedMessage('orangepi', { payload: Buffer.from('{"machineId":"orangepi"}') });

      expect(configService.setTargets).toHaveBeenCalledWith([
        target('ha2', '192.168.1.51'),
        target('stfort::autre', '192.168.1.99', 'gossip')
      ]);
    });

    it('efface le statut de présence connu pour la machine supprimée', () => {
      (service as any).liveness.set('orangepi', true);
      coreTargets = [target('orangepi::orangepi', '192.168.1.130', 'gossip')];

      (service as any).handleRemovedMessage('orangepi', { payload: Buffer.from('{"machineId":"orangepi"}') });

      expect((service as any).liveness.has('orangepi')).toBe(false);
    });

    it('ignore un payload vide (auto-nettoyage au démarrage, pas un vrai tombstone)', () => {
      coreTargets = [target('orangepi::orangepi', '192.168.1.130', 'gossip')];

      (service as any).handleRemovedMessage('orangepi', { payload: Buffer.from('') });

      expect(configService.setTargets).not.toHaveBeenCalled();
    });
  });

  describe('purgeMachine (suppression explicite, décision humaine)', () => {
    it('publie le tombstone et nettoie les 3 topics retenus de la machine disparue', () => {
      service.purgeMachine('orangepi');

      expect(mockTransport.publish).toHaveBeenCalledWith(
        'dimotic/core/orangepi/removed',
        expect.stringContaining('"machineId":"orangepi"'),
        1,
        true
      );
      expect(mockTransport.publish).toHaveBeenCalledWith('dimotic/core/orangepi/known-targets', '', 1, true);
      expect(mockTransport.publish).toHaveBeenCalledWith('dimotic/core/orangepi/known-scripts', '', 1, true);
      expect(mockTransport.publish).toHaveBeenCalledWith('dimotic/core/orangepi/status', '', 1, true);
    });

    it('efface le statut de présence local pour la machine purgée', () => {
      (service as any).liveness.set('orangepi', false);
      service.purgeMachine('orangepi');
      expect((service as any).liveness.has('orangepi')).toBe(false);
    });
  });
});
