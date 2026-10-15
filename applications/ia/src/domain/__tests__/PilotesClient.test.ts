// PilotesClient.test.ts — outils MCP de gestion des pilotes (aperçu obligatoire avant d'appliquer).
import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../../../core/dist/exports';
import { PilotesClient } from '../PilotesClient';

describe('PilotesClient', () => {
  let bus: InstanceType<typeof EventBus>;
  let client: PilotesClient;
  let requetes: Array<Record<string, unknown>>;
  let maintenant: number;
  let etat: string;

  beforeEach(() => {
    bus = new EventBus();
    maintenant = 1_000_000;
    etat = 'v1';
    client = new PilotesClient(bus, () => maintenant);
    requetes = [];
    // Faux cœur : répond à chaque requête ; l'aperçu renvoie un jeton qui dépend de l'état courant.
    bus.onGeneric<Record<string, unknown>>('pilotes:agent:requete', (r) => {
      requetes.push(r);
      const base = { id: 'x', pont: r.pont as string };
      if (r.apercu) bus.emitGeneric('pilotes:agent:reponse', { ref: r.ref, reponse: { ...base, ok: true, apercu: { retire: 'a' }, jeton: `jeton-${etat}` } });
      else if (r.ordre === 'supprimer' && r.jeton !== `jeton-${etat}`) bus.emitGeneric('pilotes:agent:reponse', { ref: r.ref, reponse: { ...base, ok: false, erreur: { code: 'etat_change', message: "l'état a changé" } } });
      else bus.emitGeneric('pilotes:agent:reponse', { ref: r.ref, reponse: { ...base, ok: true, resultat: { fait: true }, sauvegarde: '/x.bak' } });
    });
    bus.onGeneric<{ ref: string }>('pilotes:agent:ponts:get', (r) =>
      bus.emitGeneric('pilotes:agent:ponts', { ref: r.ref, ponts: [{ pont: 'arexx_bridge_n', type: 'arexx', machine: 'n', joignable: true, etat: 'en_ligne', capacites: ['lister'] }] }));
  });

  it('pilotes_ponts : liste les ponts', async () => {
    const r = (await client.ponts()) as { total: number; ponts: Array<{ pont: string }> };
    expect(r.total).toBe(1);
    expect(r.ponts[0].pont).toBe('arexx_bridge_n');
  });

  it('lecture : refuse un ordre modifiant', async () => {
    expect(await client.lire('p', 'supprimer', {})).toMatchObject({ error: expect.stringContaining('lecture') });
    expect(requetes).toHaveLength(0);
  });

  it('refuse d\'appliquer sans aperçu préalable', async () => {
    const r = await client.modifier('p', 'supprimer', { id: 'a' }, true);
    expect(r).toMatchObject({ error: expect.stringContaining('aperçu') });
    expect(requetes).toHaveLength(0);
  });

  it('aperçu puis application : le jeton du pont est repris, une seule fois', async () => {
    const apercu = (await client.modifier('p', 'supprimer', { id: 'a' }, false)) as { applique: boolean; apercu: unknown };
    expect(apercu.applique).toBe(false);
    const fait = (await client.modifier('p', 'supprimer', { id: 'a' }, true)) as { ok: boolean; applique: boolean; sauvegarde: string };
    expect(fait).toMatchObject({ ok: true, applique: true, sauvegarde: '/x.bak' });
    expect(requetes[1].jeton).toBe('jeton-v1');
    // Rejouer sans nouvel aperçu : refusé.
    expect(await client.modifier('p', 'supprimer', { id: 'a' }, true)).toMatchObject({ error: expect.stringContaining('aperçu') });
  });

  it('des paramètres différents de l\'aperçu ne sont pas appliqués', async () => {
    await client.modifier('p', 'supprimer', { id: 'a' }, false);
    expect(await client.modifier('p', 'supprimer', { id: 'b' }, true)).toMatchObject({ error: expect.stringContaining('aperçu') });
  });

  it('l\'ordre des clés n\'a pas d\'importance', async () => {
    await client.modifier('p', 'adopter', { id: 'a', lieu: 'x' }, false);
    expect(await client.modifier('p', 'adopter', { lieu: 'x', id: 'a' }, true)).toMatchObject({ ok: true });
  });

  it('un aperçu expiré (10 min) est refusé', async () => {
    await client.modifier('p', 'supprimer', { id: 'a' }, false);
    maintenant += 11 * 60_000;
    expect(await client.modifier('p', 'supprimer', { id: 'a' }, true)).toMatchObject({ error: expect.stringContaining('aperçu') });
  });

  it('l\'erreur du pont (état changé) est renvoyée telle quelle', async () => {
    await client.modifier('p', 'supprimer', { id: 'a' }, false);
    etat = 'v2';
    expect(await client.modifier('p', 'supprimer', { id: 'a' }, true)).toMatchObject({ ok: false, erreur: { code: 'etat_change' } });
  });

  it('ordre inconnu refusé', async () => {
    expect(await client.modifier('p', 'danser', {}, false)).toMatchObject({ error: expect.stringContaining('modifiant') });
  });
});
