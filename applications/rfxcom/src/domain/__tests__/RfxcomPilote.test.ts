// RfxcomPilote.test.ts — gestion des devices, récepteurs et scènes RFXCOM par l'agent IA (conception-gestion-pilotes_specs v1.3).
import { describe, it, expect, beforeEach } from 'vitest';
import { RfxcomPilote, type RfxcomPiloteHote } from '../RfxcomPilote';
import { DeviceManager } from '../devices/DeviceManager';
import { ReceiverManager } from '../receivers/ReceiverManager';
import { SceneManager } from '../scenes/SceneManager';
import type { ReceiverConfig, RfxComRawMessage } from '../types';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

function trame(sensorId: string, unitCode: number, command = 'On'): RfxComRawMessage {
  return { type: 'Lighting2', subType: 'AC', sensorId, unitCode, commandDeviceId: `${sensorId}/${unitCode}`, data: { command }, signalLevel: 5, seqNbr: 1, timestamp: new Date('2026-10-15T20:00:00Z') } as never;
}

describe('RfxcomPilote', () => {
  let devices: DeviceManager;
  let recepteurs: ReceiverManager;
  let scenes: SceneManager;
  let ignores: string[];
  let appels: string[];
  let pilote: RfxcomPilote;

  beforeEach(() => {
    devices = new DeviceManager(logger);
    recepteurs = new ReceiverManager(devices, logger);
    scenes = new SceneManager(logger);
    ignores = [];
    appels = [];
    // Un bouton déjà adopté (transmis), un récepteur lumière qui l'utilise, une scène qui cible le récepteur.
    devices.loadConfigured({
      lighting2_ac_0xaaa_1: { uniqueId: 'lighting2_ac_0xaaa_1', sensorId: '0xAAA', type: 'Lighting2', subType: 'AC', protocole: 'lighting2', name: 'Bouton---coin canapé--salon', defaultQuoi: 'Bouton', transmitToHa: true, unitCode: 1 }
    });
    recepteurs.loadReceivers({
      recepteur_1: { type: 'light', receiverId: 'recepteur_1', name: 'Lumière---salon', primaryEmitter: 'lighting2_ac_0xaaa_1', emitters: [{ emitterId: 'lighting2_ac_0xaaa_1', action: 'toggle' }], transmitToHa: true, isDimmable: false } as ReceiverConfig
    });
    scenes.addScene({ type: 'scene', receiverId: 'scene_1', name: 'Scène---soir', transmitToHa: false, sceneType: 'sequential', delayBetweenCommands: 500, actions: [{ target: 'recepteur_1', command: 'off' }] });
    // Deux découverts : un bouton de rechange (unité 2) et un autre bouton.
    devices.handleRawMessage(trame('0xBBB', 2));
    devices.handleRawMessage(trame('0xCCC', 3));

    const hote: RfxcomPiloteHote = {
      devices: () => devices.getConfiguredDevices(),
      decouverts: () => devices.getDiscoveredDevices(),
      ignores: () => [...ignores],
      recepteurs: () => recepteurs.getAllReceivers().map((r) => r.config),
      scenes: () => scenes.getAllScenes(),
      sauvegarder: () => { appels.push('sauvegarder'); return '/data/rfxcom/machine_x.yaml.bak-X'; },
      persister: () => { appels.push('persister'); },
      rafraichir: () => {},
      retirerDevice: (id) => { appels.push(`retirer-device:${id}`); devices.deleteDevice(id); },
      retirerRecepteur: (id) => { appels.push(`retirer-recepteur:${id}`); recepteurs.removeReceiver(id); },
      retirerScene: (id) => { appels.push(`retirer-scene:${id}`); scenes.removeScene(id); },
      definirDevice: (d) => { appels.push(`definir-device:${d.uniqueId}`); devices.setConfigured(d); },
      definirRecepteur: (c) => { appels.push(`definir-recepteur:${c.receiverId}`); recepteurs.removeReceiver(c.receiverId); recepteurs.addReceiver(c); },
      definirScene: (c) => { appels.push(`definir-scene:${c.receiverId}`); scenes.addScene(c); },
      publierDevice: (id) => { appels.push(`publier-device:${id}`); },
      publierRecepteur: (id) => { appels.push(`publier-recepteur:${id}`); },
      publierScene: (id) => { appels.push(`publier-scene:${id}`); },
      ignorer: (id) => { ignores.push(id); devices.ignore(id); },
      oublier: (ids) => { devices.forgetDiscovered(ids); },
      relire: () => { appels.push('relire'); return [1, 1, 1]; },
      horodatage: () => 1000890
    };
    pilote = new RfxcomPilote(hote);
  });

  it('lister : devices, récepteurs, scènes ; filtrable', async () => {
    const tout = (await pilote.lire('lister')) as { devices: unknown[]; recepteurs: unknown[]; scenes: unknown[] };
    expect(tout.devices).toHaveLength(1);
    expect(tout.recepteurs).toHaveLength(1);
    expect(tout.scenes).toHaveLength(1);
    const seuls = (await pilote.lire('lister', { ressource: 'scenes' })) as Record<string, unknown>;
    expect(seuls.scenes).toBeDefined();
    expect(seuls.devices).toBeUndefined();
  });

  it('decouverts : les deux boutons, avec leur QUOI par défaut', async () => {
    const r = (await pilote.lire('decouverts')) as { decouverts: Array<{ id: string; quoiParDefaut: string }> };
    expect(r.decouverts.map((d) => d.id).sort()).toEqual(['lighting2_ac_0xbbb_2', 'lighting2_ac_0xccc_3']);
    expect(r.decouverts[0].quoiParDefaut).toBe('Bouton');
  });

  it('adopter : exige le lieu, prérempli le QUOI, n\'écrit rien à l\'aperçu', async () => {
    await expect(pilote.preparer('adopter', { id: 'lighting2_ac_0xbbb_2' })).rejects.toThrow(/lieu/);
    const { apercu } = await pilote.preparer('adopter', { id: 'lighting2_ac_0xbbb_2', lieu: 'cuisine', transmitToHa: true });
    expect(JSON.stringify(apercu)).toContain('Bouton---cuisine');
    expect(appels).toEqual([]);
    expect(devices.getDevice('lighting2_ac_0xbbb_2')).toBeUndefined();
  });

  it('adopter : sauvegarde, définit, persiste, publie, retire des découverts', async () => {
    const r = await pilote.appliquer('adopter', { id: 'lighting2_ac_0xbbb_2', lieu: 'cuisine', lieuPrecis: 'évier', transmitToHa: true });
    expect(r.sauvegarde).toContain('.bak-');
    expect(devices.getDevice('lighting2_ac_0xbbb_2')?.name).toBe('Bouton---évier--cuisine');
    expect(devices.getDiscoveredDevices().map((d) => d.uniqueId)).toEqual(['lighting2_ac_0xccc_3']);
    expect(appels).toEqual(['sauvegarder', 'definir-device:lighting2_ac_0xbbb_2', 'persister', 'publier-device:lighting2_ac_0xbbb_2']);
  });

  it('creer récepteur : émetteur principal adopté obligatoire, id attribué, validé', async () => {
    await expect(pilote.preparer('creer', { ressource: 'recepteur', type: 'switch', quoi: 'Prise', lieu: 'salon', emetteurPrincipal: 'inconnu' })).rejects.toThrow(/inconnu/);
    await expect(pilote.preparer('creer', { ressource: 'recepteur', type: 'cover', quoi: 'Volet', lieu: 'salon', emetteurPrincipal: 'lighting2_ac_0xaaa_1' })).rejects.toThrow(/coverType/);
    const r = await pilote.appliquer('creer', {
      ressource: 'recepteur', type: 'cover', quoi: 'Volet', lieu: 'salon', emetteurPrincipal: 'lighting2_ac_0xaaa_1',
      coverType: 'Blind1', ouvertureSec: 20, fermetureSec: 18, transmitToHa: true,
      emetteurs: [{ emitterId: 'lighting2_ac_0xaaa_1', action: 'open' }]
    });
    expect((r.resultat as { identifiants: string[] }).identifiants).toEqual(['recepteur_1000890']);
    expect(recepteurs.getReceiver('recepteur_1000890')?.config.name).toBe('Volet---salon');
    expect(appels).toContain('publier-recepteur:recepteur_1000890');
  });

  it('creer scène : cibles = récepteurs existants', async () => {
    await expect(pilote.preparer('creer', { ressource: 'scene', quoi: 'Scène', lieu: 'maison', actions: [{ target: 'nope', command: 'off' }] })).rejects.toThrow(/inconnue/);
    const r = await pilote.appliquer('creer', { ressource: 'scene', quoi: 'Scène', lieu: 'maison', actions: [{ target: 'recepteur_1', command: 'on' }], transmitToHa: true });
    expect((r.resultat as { identifiants: string[] }).identifiants).toEqual(['scene_1000890']);
    expect(scenes.getScene('scene_1000890')?.actions).toHaveLength(1);
  });

  it('modifier un device transmis : retrait HA PUIS ajout, nom recomposé', async () => {
    await pilote.appliquer('modifier', { id: 'lighting2_ac_0xaaa_1', lieu: 'cuisine' });
    expect(devices.getDevice('lighting2_ac_0xaaa_1')?.name).toBe('Bouton---coin canapé--cuisine');
    const i = appels.indexOf('retirer-device:lighting2_ac_0xaaa_1');
    const j = appels.indexOf('definir-device:lighting2_ac_0xaaa_1');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });

  it('modifier un récepteur sans changer le nom : pas de retrait HA', async () => {
    await pilote.appliquer('modifier', { id: 'recepteur_1', variable: true });
    expect(appels.some((a) => a.startsWith('retirer-'))).toBe(false);
    expect((recepteurs.getReceiver('recepteur_1')?.config as { isDimmable: boolean }).isDimmable).toBe(true);
  });

  it('modifier : changer le type = retrait puis recréation', async () => {
    await pilote.appliquer('modifier', { id: 'recepteur_1', type: 'switch' });
    expect(recepteurs.getReceiver('recepteur_1')?.config.type).toBe('switch');
    expect(appels.indexOf('retirer-recepteur:recepteur_1')).toBeLessThan(appels.indexOf('definir-recepteur:recepteur_1'));
  });

  it('remplacer un bouton : suppression PUIS ajout au même nommage, références corrigées partout', async () => {
    const { apercu } = await pilote.preparer('remplacer', { ancien: 'lighting2_ac_0xaaa_1', nouveau: 'lighting2_ac_0xbbb_2' });
    expect(JSON.stringify(apercu)).toContain('appairage');
    await pilote.appliquer('remplacer', { ancien: 'lighting2_ac_0xaaa_1', nouveau: 'lighting2_ac_0xbbb_2' });
    expect(devices.getDevice('lighting2_ac_0xaaa_1')).toBeUndefined();
    expect(devices.getDevice('lighting2_ac_0xbbb_2')?.name).toBe('Bouton---coin canapé--salon');
    const r = recepteurs.getReceiver('recepteur_1')?.config as ReceiverConfig & { primaryEmitter: string; emitters: Array<{ emitterId: string }> };
    expect(r.primaryEmitter).toBe('lighting2_ac_0xbbb_2');
    expect(r.emitters.map((e) => e.emitterId)).toEqual(['lighting2_ac_0xbbb_2']);
    expect(appels.indexOf('retirer-device:lighting2_ac_0xaaa_1')).toBeLessThan(appels.indexOf('definir-device:lighting2_ac_0xbbb_2'));
  });

  it('remplacer : le neuf doit être découvert et de même nature', async () => {
    await expect(pilote.preparer('remplacer', { ancien: 'lighting2_ac_0xaaa_1', nouveau: 'lighting2_ac_0xzzz_9' })).rejects.toThrow(/découverts/);
    await expect(pilote.preparer('remplacer', { ancien: 'inconnu', nouveau: 'lighting2_ac_0xbbb_2' })).rejects.toThrow(/inconnu/);
  });

  it('supprimer : refuse un device utilisé par un récepteur et un récepteur cité par une scène', async () => {
    await expect(pilote.preparer('supprimer', { id: 'lighting2_ac_0xaaa_1' })).rejects.toThrow(/recepteur_1/);
    await expect(pilote.preparer('supprimer', { id: 'recepteur_1' })).rejects.toThrow(/scene_1/);
  });

  it('supprimer : scène puis récepteur puis device, dans l\'ordre voulu', async () => {
    await pilote.appliquer('supprimer', { id: 'scene_1' });
    await pilote.appliquer('supprimer', { id: 'recepteur_1' });
    await pilote.appliquer('supprimer', { id: 'lighting2_ac_0xaaa_1' });
    expect(devices.getConfiguredDevices()).toHaveLength(0);
    expect(appels.filter((a) => a.startsWith('retirer-'))).toEqual(['retirer-scene:scene_1', 'retirer-recepteur:recepteur_1', 'retirer-device:lighting2_ac_0xaaa_1']);
  });

  it('effacer / ignorer ne touchent ni HA ni le fichier de configuration (ignorer persiste la liste)', async () => {
    await pilote.appliquer('effacer', { id: 'lighting2_ac_0xbbb_2' });
    expect(devices.getDiscoveredDevices().map((d) => d.uniqueId)).toEqual(['lighting2_ac_0xccc_3']);
    expect(appels).not.toContain('sauvegarder');
    await pilote.appliquer('ignorer', { id: 'lighting2_ac_0xccc_3' });
    expect(devices.getDiscoveredDevices()).toHaveLength(0);
    // Un ignoré ne revient pas quand il émet de nouveau.
    devices.handleRawMessage(trame('0xCCC', 3));
    expect(devices.getDiscoveredDevices()).toHaveLength(0);
    expect(devices.getIgnored()).toEqual(['lighting2_ac_0xccc_3']);
  });

  it('le jeton d\'aperçu change quand un découvert apparaît (état concerné)', async () => {
    const a = await pilote.preparer('redemarrer', {});
    devices.handleRawMessage(trame('0xDDD', 4));
    const b = await pilote.preparer('redemarrer', {});
    expect(JSON.stringify(a.etat)).not.toBe(JSON.stringify(b.etat));
  });

  it('redemarrer : relit sans sauvegarde', async () => {
    const r = await pilote.appliquer('redemarrer', {});
    expect(appels).toEqual(['relire']);
    expect((r.resultat as { relus: { devices: number } }).relus.devices).toBe(1);
  });

  it('ordre inconnu refusé', async () => {
    await expect(pilote.preparer('danser', {})).rejects.toThrow(/non géré/);
  });
});
