// HaEtiquetteClient.test.ts — étiquettes HA pour les automatisations (outils MCP lire_etiquettes_ha / etiqueter_ha).
import { describe, it, expect } from 'vitest';
import { HaEtiquetteClient } from '../HaEtiquetteClient';

function faux() {
  const envoyes: Array<Record<string, unknown>> = [];
  const labels = [{ label_id: 'lumieres', name: 'Lumières' }, { label_id: 'ballon', name: 'Ballon' }];
  const entites = [
    { entity_id: 'automation.a', labels: ['ballon'] },
    { entity_id: 'automation.b', labels: [] as string[] },
    { entity_id: 'script.c' }
  ];
  const ha = {
    callWs: async (m: Record<string, unknown>) => {
      envoyes.push(m);
      if (m.type === 'config/label_registry/list') return labels;
      if (m.type === 'config/entity_registry/list') return entites;
      if (m.type === 'config/label_registry/create') return { label_id: 'salle_de_bain', name: m.name };
      return {};
    }
  } as never;
  return { client: new HaEtiquetteClient(ha), envoyes };
}

describe('HaEtiquetteClient', () => {
  it('lire : étiquettes avec leurs entités et liste des entités sans étiquette', async () => {
    const r = (await faux().client.lire()) as { etiquettes: Array<{ id: string; automatisationsEtScripts: string[] }>; sansEtiquette: string[] };
    expect(r.etiquettes.find((e) => e.id === 'ballon')?.automatisationsEtScripts).toEqual(['automation.a']);
    expect(r.sansEtiquette).toEqual(['automation.b', 'script.c']);
  });

  it('aperçu sans confirme : rien d\'écrit', async () => {
    const f = faux();
    const r = (await f.client.etiqueter(['automation.b'], ['Lumières'], 'ajouter', false, false)) as { apercu: boolean; modifications: Array<{ apres: string[] }> };
    expect(r.apercu).toBe(true);
    expect(r.modifications[0].apres).toEqual(['lumieres']);
    expect(f.envoyes.some((m) => String(m.type).includes('update') || String(m.type).includes('create'))).toBe(false);
  });

  it('ajouter garde les étiquettes déjà posées ; retirer les enlève', async () => {
    const f = faux();
    await f.client.etiqueter(['automation.a'], ['lumieres'], 'ajouter', false, true);
    expect(f.envoyes.find((m) => m.type === 'config/entity_registry/update')?.labels).toEqual(['ballon', 'lumieres']);
    const g = faux();
    await g.client.etiqueter(['automation.a'], ['ballon'], 'retirer', false, true);
    expect(g.envoyes.find((m) => m.type === 'config/entity_registry/update')?.labels).toEqual([]);
  });

  it('étiquette inconnue refusée sans creer ; avec creer, elle est créée et l\'id renvoyé par HA est utilisé', async () => {
    const f = faux();
    await expect(f.client.etiqueter(['automation.b'], ['Salle de bain'], 'ajouter', false, true)).rejects.toThrow(/inconnue/);
    await f.client.etiqueter(['automation.b'], ['Salle de bain'], 'ajouter', true, true);
    expect(f.envoyes.find((m) => m.type === 'config/label_registry/create')?.name).toBe('Salle de bain');
    expect(f.envoyes.find((m) => m.type === 'config/entity_registry/update')?.labels).toEqual(['salle_de_bain']);
  });

  it('entité absente du registre : refus', async () => {
    await expect(faux().client.etiqueter(['automation.zzz'], ['ballon'], 'ajouter', false, true)).rejects.toThrow(/registre/);
  });
});
