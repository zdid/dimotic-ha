import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiverCover } from '../ReceiverCover';
import type { ReceiverCoverConfig } from '../../types';

function makeConfig(over: Partial<ReceiverCoverConfig> = {}): ReceiverCoverConfig {
  return {
    receiverId: 'recepteur_1',
    type: 'cover',
    name: 'Volet---Salon',
    primaryEmitter: 'lighting2_ac_0x013bc452_12',
    emitters: [],
    transmitToHa: true,
    coverType: 'Blind1',
    openTimeSec: 20,
    closeTimeSec: 20,
    lastPosition: 0,
    ...over
  } as ReceiverCoverConfig;
}

describe('ReceiverCover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  describe('état publié', () => {
    it('affiche « opening » pendant l\'ouverture, « closing » pendant la fermeture (pas la position d\'avant le départ)', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0 }), 'lighting2');
      expect(cover.getState().state).toBe('down');
      cover.translateHaCommand('open');
      expect(cover.getState().state).toBe('opening');
      vi.advanceTimersByTime(30_000); // au-delà de la durée : butée atteinte
      expect(cover.getState().state).toBe('up');
      cover.translateHaCommand('close');
      expect(cover.getState().state).toBe('closing');
    });

    it('à l\'arrêt entre les butées : « up » (ouvert) avec le pourcentage, jamais un état que HA ne connaît pas', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0 }), 'lighting2');
      cover.translateHaCommand('open');
      vi.advanceTimersByTime(10_000);
      cover.translateHaCommand('stop');
      const state = cover.getState();
      expect(state.state).toBe('up');
      expect(state.attributes?.position).toBe(50);
    });
  });

  describe('positionnement en pourcentage (Lighting2)', () => {
    it('démarre le mouvement, mémorise une cible intermédiaire et donne le délai d\'arrêt', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0 }), 'lighting2');
      const result = cover.translateHaCommand('set_position', 50);
      expect(result).toEqual({ action: 'on' });
      expect(cover.hasStopTarget()).toBe(true);
      expect(cover.msUntilArrival()).toBeCloseTo(10_000, -2);
    });

    it('arrête le volet à la cible en renvoyant la commande qui a démarré le mouvement', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0 }), 'lighting2');
      cover.translateHaCommand('set_position', 50);
      vi.advanceTimersByTime(10_000);
      expect(cover.translateHaCommand('stop')).toEqual({ action: 'on' });
      expect(cover.getState().attributes?.position).toBe(50);
      expect(cover.hasStopTarget()).toBe(false);
    });

    it('vers la butée : pas de cible d\'arrêt (le volet s\'arrête tout seul)', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0 }), 'lighting2');
      cover.translateHaCommand('set_position', 100);
      expect(cover.hasStopTarget()).toBe(false);
      expect(cover.msUntilArrival()).toBeCloseTo(20_000, -2);
    });

    it('même sens déjà en cours : ne renvoie rien (une commande répétée l\'arrêterait) mais change la cible', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0 }), 'lighting2');
      cover.translateHaCommand('set_position', 50);
      expect(cover.translateHaCommand('set_position', 80)).toBeNull();
      expect(cover.hasStopTarget()).toBe(true);
      expect(cover.msUntilArrival()).toBeCloseTo(16_000, -2);
    });

    it('« open » pendant un positionnement vise la butée', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0 }), 'lighting2');
      cover.translateHaCommand('set_position', 50);
      expect(cover.translateHaCommand('open')).toBeNull(); // déjà en train de monter
      expect(cover.hasStopTarget()).toBe(false);
    });

    it('inversion de sens en cours de route : nouvelle cible, aucun arrêt intermédiaire', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 100 }), 'lighting2');
      cover.translateHaCommand('set_position', 50); // descend
      vi.advanceTimersByTime(2_000); // ~ 90 %
      expect(cover.translateHaCommand('set_position', 95)).toEqual({ action: 'on' });
      expect(cover.hasStopTarget()).toBe(true);
    });

    it('aucun mouvement : msUntilArrival est null', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 40 }), 'lighting2');
      expect(cover.msUntilArrival()).toBeNull();
    });
  });

  describe('volet en protocole natif', () => {
    it('set_position envoie open/close et stop envoie stop', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0, coverType: 'RFY' }), 'rfy');
      expect(cover.translateHaCommand('set_position', 30)).toEqual({ action: 'open' });
      vi.advanceTimersByTime(6_000);
      expect(cover.translateHaCommand('stop')).toEqual({ action: 'stop' });
    });
  });

  describe('Lighting2 : répéter la commande en cours arrête le moteur', () => {
    it('un ordre « on » reçu d\'un émetteur pendant une montée est un arrêt, sans retransmission', () => {
      const cover = new ReceiverCover(makeConfig({ lastPosition: 0 }), 'lighting2');
      cover.translateHaCommand('open');
      vi.advanceTimersByTime(5_000);
      expect(cover.applyEmitterCommand('on')).toBeNull();
      expect(cover.getState().state).toBe('up');
    });
  });
});
