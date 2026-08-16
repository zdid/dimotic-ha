// EventBus.contract.test.ts
//
// Suite de tests de contrat pour IEventBus — exécutée à la fois contre EventBus (in-process,
// EventEmitter) et MqttEventBus (broker MQTT local, fonctionnelles-supervisor_specs v2.4 §6.3) pour
// garantir l'équivalence de comportement avant de faire tourner une application (espdisplay) sur
// MqttEventBus en production. Aucune suite de ce type n'existait pour IEventBus avant Phase 1 du
// superviseur.
//
// MqttEventBus dépend d'un vrai broker MQTT accessible en local (127.0.0.1:1883, sans
// authentification — confirmé disponible sur cette machine de développement, déjà utilisé pour la
// mesure de latence loopback de cette session). Contrairement à EventBus (synchrone), la livraison
// via MqttEventBus est asynchrone (aller-retour réseau réel, même en loopback) — chaque assertion de
// livraison utilise `waitFor()` plutôt qu'une vérification immédiate.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IEventBus } from '../IEventBus';
import { EventBus } from '../EventBus';
import { MqttEventBus } from '../MqttEventBus';

/** Attend qu'une condition devienne vraie, ou échoue au-delà du timeout — nécessaire pour
 *  MqttEventBus (livraison asynchrone), sans effet notable pour EventBus (déjà vrai immédiatement). */
async function waitFor(condition: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: condition non satisfaite après ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

interface EventBusFactory {
  name: string;
  create: () => Promise<IEventBus>;
  destroy: (bus: IEventBus) => Promise<void>;
}

const factories: EventBusFactory[] = [
  {
    name: 'EventBus (in-process)',
    create: async () => new EventBus(),
    destroy: async () => {
      /* rien à nettoyer — EventEmitter, pas de connexion */
    }
  },
  {
    name: 'MqttEventBus (broker MQTT local)',
    create: async () => {
      const bus = new MqttEventBus({
        appId: `contract-test-${Math.random().toString(36).slice(2)}`,
        machineId: 'contract-test-machine',
        mqttConfig: { host: '127.0.0.1', port: 1883 }
      });
      await waitFor(() => bus.isConnected());
      return bus;
    },
    destroy: async () => {
      /* pas de disconnect() dans IEventBus — connexion fermée avec le process de test */
    }
  }
];

// ⚠️ Les deux bus utilisent des noms d'événements uniques par test (Math.random()) pour éviter
// toute interférence : MqttEventBus n'a pas de removeAllListeners() qui désabonne réellement du
// topic MQTT, et deux exécutions de cette suite en parallèle partageraient le même broker.
function uniqueEvent(base: string): string {
  return `${base}-${Math.random().toString(36).slice(2)}`;
}

for (const factory of factories) {
  describe(`IEventBus contract — ${factory.name}`, () => {
    let bus: IEventBus;

    beforeEach(async () => {
      bus = await factory.create();
    });

    afterEach(async () => {
      await factory.destroy(bus);
    });

    it('emitGeneric/onGeneric : livre le payload au listener', async () => {
      const event = uniqueEvent('generic');
      let received: unknown;
      bus.onGeneric(event, (data) => { received = data; });
      bus.emitGeneric(event, { value: 42 });
      await waitFor(() => received !== undefined);
      expect(received).toEqual({ value: 42 });
    });

    it('emitGeneric/onGeneric : plusieurs listeners reçoivent tous le même événement', async () => {
      const event = uniqueEvent('multi');
      let countA = 0;
      let countB = 0;
      bus.onGeneric(event, () => { countA++; });
      bus.onGeneric(event, () => { countB++; });
      bus.emitGeneric(event, {});
      await waitFor(() => countA === 1 && countB === 1);
      expect(countA).toBe(1);
      expect(countB).toBe(1);
    });

    it("offGeneric : arrête bien de recevoir l'événement", async () => {
      const event = uniqueEvent('off');
      let count = 0;
      const listener = () => { count++; };
      bus.onGeneric(event, listener);
      bus.emitGeneric(event, {});
      await waitFor(() => count === 1);

      bus.offGeneric(event, listener);
      bus.emitGeneric(event, {});
      // Pas de nouvel événement attendu — laisse le temps à une livraison erronée d'arriver.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(count).toBe(1);
    });

    it('onceGeneric : ne se déclenche qu\'une seule fois', async () => {
      const event = uniqueEvent('once');
      let count = 0;
      bus.onceGeneric(event, () => { count++; });
      bus.emitGeneric(event, {});
      await waitFor(() => count === 1);
      bus.emitGeneric(event, {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(count).toBe(1);
    });

    it("un événement générique différent n'est jamais reçu par un listener non concerné", async () => {
      const eventA = uniqueEvent('a');
      const eventB = uniqueEvent('b');
      let receivedA = false;
      bus.onGeneric(eventA, () => { receivedA = true; });
      bus.emitGeneric(eventB, {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(receivedA).toBe(false);
    });

    it('emit/on typés : livre le payload (app:menu:register, utilisé réellement par espdisplay)', async () => {
      let received: unknown;
      bus.on('app:menu:register', (data) => { received = data; });
      bus.emit('app:menu:register', { appId: 'contract-test', menuConfig: {} as never });
      await waitFor(() => received !== undefined);
      expect(received).toMatchObject({ appId: 'contract-test' });
    });

    it('off typé : arrête bien de recevoir', async () => {
      let count = 0;
      const listener = () => { count++; };
      bus.on('app:menu:register', listener);
      bus.emit('app:menu:register', { appId: 'x', menuConfig: {} as never });
      await waitFor(() => count === 1);

      bus.off('app:menu:register', listener);
      bus.emit('app:menu:register', { appId: 'x', menuConfig: {} as never });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(count).toBe(1);
    });
  });
}
