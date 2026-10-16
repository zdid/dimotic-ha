// Zigbee2mqttPilote.test.ts — gestion des appareils Zigbee par l'agent IA (conception-gestion-pilotes_specs v1.5 §9).
import { describe, it, expect, beforeEach } from 'vitest';
import { Zigbee2mqttPilote, estQualifie, type Zigbee2mqttPiloteHote } from '../Zigbee2mqttPilote';
import { Zigbee2mqttService } from '../Zigbee2mqttService';
import type { Z2mDevice, Z2mReponse } from '../types';

const coord: Z2mDevice = { ieee_address: '0x00', friendly_name: 'Coordinator', type: 'Coordinator' };
const frigo: Z2mDevice = { ieee_address: '0x70b3d52b60043075', friendly_name: 'frigo---cuisine--cuisine', type: 'EndDevice', interview_completed: true, definition: { model: 'TS0201', vendor: 'Tuya' } };
const neuf: Z2mDevice = { ieee_address: '0xaaaa', friendly_name: '0xaaaa', type: 'EndDevice', interview_completed: true, definition: { model: 'TS0201', vendor: 'Tuya' } };
const enInterview: Z2mDevice = { ieee_address: '0xbbbb', friendly_name: '0xbbbb', type: 'EndDevice', interviewing: true };

describe('Zigbee2mqttPilote', () => {
  let devices: Z2mDevice[];
  let envois: Array<{ suffixe: string; payload: Record<string, unknown> }>;
  let enLigne: boolean;
  let reponses: Z2mReponse[];
  let pilote: Zigbee2mqttPilote;
  let attentes: string[][];

  beforeEach(() => {
    devices = [coord, { ...frigo }, { ...neuf }, { ...enInterview }];
    envois = [];
    attentes = [];
    enLigne = true;
    reponses = [];
    const hote: Zigbee2mqttPiloteHote = {
      devices: () => devices,
      enLigne: () => enLigne,
      envoyer: async (suffixe, payload) => { envois.push({ suffixe, payload }); return reponses.shift() ?? { ok: true }; },
      appairageDefautSec: () => 120,
      attendreRetraitHa: async (noms) => { attentes.push(noms); return { absent: true, attenteMs: 1, restantes: [] }; },
      appairageMaxSec: () => 254
    };
    pilote = new Zigbee2mqttPilote(hote);
  });

  it('estQualifie : exige « quoi---lieu »', () => {
    expect(estQualifie('frigo---cuisine--cuisine')).toBe(true);
    expect(estQualifie('0x70b3d52b60043075')).toBe(false);
    expect(estQualifie('lampe salon')).toBe(false);
    expect(estQualifie('---salon')).toBe(false);
  });

  it('lister : sans le coordinateur ; decouverts : interview en cours ou nom non qualifié', async () => {
    const l = (await pilote.lire('lister')) as { appareils: Array<{ id: string; qualifie: boolean }> };
    expect(l.appareils.map((a) => a.id)).toEqual(['0x70b3d52b60043075', '0xaaaa', '0xbbbb']);
    const d = (await pilote.lire('decouverts')) as { decouverts: Array<{ id: string; interview: string }> };
    expect(d.decouverts.map((a) => a.id)).toEqual(['0xaaaa', '0xbbbb']);
    expect(d.decouverts[1].interview).toBe('en cours');
  });

  it('refuse tout quand zigbee2mqtt est hors ligne', async () => {
    enLigne = false;
    await expect(pilote.lire('lister')).rejects.toThrow(/hors ligne/);
    await expect(pilote.preparer('supprimer', { id: '0xaaaa' })).rejects.toThrow(/hors ligne/);
  });

  it('adopter : qualification complète, nom libre, pas pendant l\'interview ; aperçu sans rien envoyer', async () => {
    await expect(pilote.preparer('adopter', { id: '0xaaaa', quoi: 'Température' })).rejects.toThrow(/lieu/);
    await expect(pilote.preparer('adopter', { id: '0xaaaa', quoi: 'frigo', lieu: 'cuisine', lieuPrecis: 'cuisine' })).rejects.toThrow(/déjà pris/);
    await expect(pilote.preparer('adopter', { id: '0xbbbb', quoi: 'x', lieu: 'y' })).rejects.toThrow(/interview/);
    await expect(pilote.preparer('adopter', { id: '0x70b3d52b60043075', quoi: 'x', lieu: 'y' })).rejects.toThrow(/déjà qualifié/);
    const { apercu } = await pilote.preparer('adopter', { id: '0xaaaa', quoi: 'Température', lieu: 'chambre', lieuPrecis: 'lit' });
    expect(JSON.stringify(apercu)).toContain('Température---lit--chambre');
    expect(envois).toHaveLength(0);
  });

  it('adopter : renomme avec homeassistant_rename', async () => {
    await pilote.appliquer('adopter', { id: '0xaaaa', quoi: 'Température', lieu: 'chambre' });
    expect(envois).toEqual([{ suffixe: 'device/rename', payload: { from: '0xaaaa', to: 'Température---chambre', homeassistant_rename: true } }]);
  });

  it('modifier : repart du nom actuel pour ce qui ne change pas', async () => {
    await pilote.appliquer('modifier', { id: 'frigo---cuisine--cuisine', lieu: 'garage' });
    expect(envois[0].payload).toMatchObject({ from: 'frigo---cuisine--cuisine', to: 'frigo---garage' });
    await pilote.appliquer('modifier', { id: 'frigo---cuisine--cuisine', lieuPere: 'Rez-de-Chaussée', lieuGrandPere: 'Maison' });
    expect(envois[1].payload).toMatchObject({ to: 'frigo---cuisine--cuisine--Rez-de-Chaussée--Maison' });
    await expect(pilote.preparer('modifier', { id: '0x70b3d52b60043075', quoi: 'frigo' })).rejects.toThrow(/ne change pas/);
  });

  it('adopter : lieu père (étage) et grand-père (bâtiment), positions respectées', async () => {
    await pilote.appliquer('adopter', { id: '0xaaaa', quoi: 'Température', lieu: 'Chambre', lieuPrecis: 'Lit', lieuPere: 'Étage', lieuGrandPere: 'Maison' });
    expect(envois[0].payload).toMatchObject({ to: 'Température---Lit--Chambre--Étage--Maison' });
    await expect(pilote.preparer('adopter', { id: '0xaaaa', quoi: 'T', lieu: 'C', lieuGrandPere: 'Maison' })).rejects.toThrow(/lieuPere/);
  });

  it('supprimer : normal ou forcé', async () => {
    await pilote.appliquer('supprimer', { id: '0x70b3d52b60043075', force: true });
    expect(envois[0]).toEqual({ suffixe: 'device/remove', payload: { id: '0x70b3d52b60043075', force: true } });
  });

  it('remplacer : supprime l\'ancien PUIS renomme le neuf avec le nom de l\'ancien', async () => {
    const { apercu } = await pilote.preparer('remplacer', { ancien: '0x70b3d52b60043075', nouveau: '0xaaaa' });
    expect(JSON.stringify(apercu)).toContain('entity_id');
    await pilote.appliquer('remplacer', { ancien: 'frigo---cuisine--cuisine', nouveau: '0xaaaa' });
    expect(envois.map((e) => e.suffixe)).toEqual(['device/remove', 'device/rename']);
    expect(envois[1].payload).toMatchObject({ from: '0xaaaa', to: 'frigo---cuisine--cuisine' });
    expect(attentes).toEqual([['frigo---cuisine--cuisine']]); // HA a confirmé la suppression avant le renommage
  });

  it('remplacer : le neuf doit exister, être sorti d\'interview et ne pas être déjà qualifié', async () => {
    await expect(pilote.preparer('remplacer', { ancien: '0x70b3d52b60043075', nouveau: '0xzzzz' })).rejects.toThrow(/appairer d'abord/);
    await expect(pilote.preparer('remplacer', { ancien: '0x70b3d52b60043075', nouveau: '0xbbbb' })).rejects.toThrow(/interview/);
    await expect(pilote.preparer('remplacer', { ancien: '0xaaaa', nouveau: '0x70b3d52b60043075' })).rejects.toThrow(/déjà qualifié/);
  });

  it('remplacer : si la suppression échoue, le renommage n\'est pas tenté', async () => {
    reponses = [{ ok: false, error: 'device did not respond' }];
    await expect(pilote.appliquer('remplacer', { ancien: '0x70b3d52b60043075', nouveau: '0xaaaa' })).rejects.toThrow(/Échec.*did not respond/);
    expect(envois).toHaveLength(1);
  });

  it('appairer : durée par défaut, plafonnée', async () => {
    await pilote.appliquer('appairer', {});
    await pilote.appliquer('appairer', { duree: 9999 });
    expect(envois.map((e) => e.payload)).toEqual([{ time: 120 }, { time: 254 }]);
    await expect(pilote.preparer('appairer', { duree: 'x' })).rejects.toThrow(/secondes/);
  });

  it('ordres inexistants ici refusés', async () => {
    for (const o of ['effacer', 'ignorer', 'redemarrer']) await expect(pilote.preparer(o, {})).rejects.toThrow(/non géré/);
  });
});

describe('Zigbee2mqttService (messages MQTT)', () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
  function creer() {
    const emis: Array<{ evt: string; data: Record<string, unknown> }> = [];
    const bus = { emitGeneric: (evt: string, data: Record<string, unknown>) => emis.push({ evt, data }), onGeneric() {}, offGeneric() {}, emit() {}, on() {} } as never;
    const svc = new Zigbee2mqttService(bus, logger, { getAppConfig: () => ({}) } as never);
    process.env.DIMOTIC_MACHINE_ID = process.env.DIMOTIC_MACHINE_ID ?? 'm';
    return { svc, emis };
  }
  const bi = () => (process.env.DIMOTIC_MACHINE_ID ? `z2m_bridge_${process.env.DIMOTIC_MACHINE_ID}` : 'z2m_bridge');

  it('envoyer : publie la requête avec une transaction et rend la réponse correspondante', async () => {
    const { svc, emis } = creer();
    const p = svc.envoyer('device/remove', { id: 'x', force: false });
    const pub = emis.find((e) => e.evt === 'integration:zigbee2mqtt:passthrough:publish')!;
    expect(pub.data.topic).toBe('zigbee2mqtt/bridge/request/device/remove');
    expect(pub.data.retain).toBe(false);
    const transaction = (pub.data.payload as { transaction: string }).transaction;
    svc.surMessage({ bridgeInstance: String(pub.data.bridgeInstance), topic: 'zigbee2mqtt/bridge/response/device/remove', payload: JSON.stringify({ status: 'ok', data: {}, transaction }) });
    expect(await p).toMatchObject({ ok: true });
  });

  it('une réponse en erreur ou d\'une autre transaction ne résout pas à tort', async () => {
    const { svc, emis } = creer();
    const p = svc.envoyer('permit_join', { time: 10 });
    const pub = emis.find((e) => e.evt === 'integration:zigbee2mqtt:passthrough:publish')!;
    const bridge = String(pub.data.bridgeInstance);
    svc.surMessage({ bridgeInstance: bridge, topic: 'zigbee2mqtt/bridge/response/permit_join', payload: JSON.stringify({ status: 'ok', transaction: 'autre' }) });
    const transaction = (pub.data.payload as { transaction: string }).transaction;
    svc.surMessage({ bridgeInstance: bridge, topic: 'zigbee2mqtt/bridge/response/permit_join', payload: JSON.stringify({ status: 'error', error: 'refusé', transaction }) });
    expect(await p).toEqual({ ok: false, data: undefined, error: 'refusé' });
    void bi;
  });

  it('suit l\'état (texte 1.x ou JSON 2.x) et la liste des appareils ; ignore un autre pont', () => {
    const { svc, emis } = creer();
    svc.envoyer('permit_join', { time: 1 }).catch(() => undefined);
    const bridge = String(emis.find((e) => e.evt === 'integration:zigbee2mqtt:passthrough:publish')!.data.bridgeInstance);
    svc.surMessage({ bridgeInstance: 'autre', topic: 'zigbee2mqtt/bridge/devices', payload: JSON.stringify([{ ieee_address: '0x1', friendly_name: 'a', type: 'EndDevice' }]) });
    expect((svc as unknown as { devices: unknown[] }).devices).toHaveLength(0);
    svc.surMessage({ bridgeInstance: bridge, topic: 'zigbee2mqtt/bridge/devices', payload: JSON.stringify([{ ieee_address: '0x1', friendly_name: 'a', type: 'EndDevice' }]) });
    expect((svc as unknown as { devices: unknown[] }).devices).toHaveLength(1);
    svc.surMessage({ bridgeInstance: bridge, topic: 'zigbee2mqtt/bridge/state', payload: 'online' });
    expect((svc as unknown as { etat: string }).etat).toBe('online');
    svc.surMessage({ bridgeInstance: bridge, topic: 'zigbee2mqtt/bridge/state', payload: '{"state":"offline"}' });
    expect((svc as unknown as { etat: string }).etat).toBe('offline');
  });
});
