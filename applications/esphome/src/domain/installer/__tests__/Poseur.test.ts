import { describe, it, expect, beforeEach } from 'vitest';
import { HaDeclarer, ErreurHa, trouverEntree, type ClientHa, type EntreeEsphome, type AppareilHa } from '../HaDeclarer';
import { InstallerService, type DepsPoseur } from '../InstallerService';
import { OtaError, type OptionsOta } from '../OtaClient';
import { sha256 } from '../../factory/manifest';
import type { Pose } from '../../messages';

// --- HA simulé ------------------------------------------------------------------------------------------------
interface EtatHaSimule { entrees: EntreeEsphome[]; appareils: AppareilHa[]; flux: { requetes: { methode: string; chemin: string; corps: unknown }[]; etapes: any[] } }
function fauxHa(s: EtatHaSimule): ClientHa {
  return {
    async callWs(m) {
      if (m.type === 'config_entries/get') return s.entrees;
      if (m.type === 'config/device_registry/list') return s.appareils;
      throw new Error('commande inattendue ' + m.type);
    },
    async callRest(methode, chemin, corps) {
      s.flux.requetes.push({ methode, chemin, corps });
      const suivante = s.flux.etapes.shift();
      if (!suivante) throw new Error('plus d\'étape simulée');
      return { status: suivante.status ?? 200, body: suivante.body ?? suivante };
    }
  };
}
const entree = (o: Partial<EntreeEsphome> = {}): EntreeEsphome => ({ entry_id: 'E1', title: 'Satellite 4', state: 'loaded', data: { host: '192.168.1.44', device_name: 'hasat4' }, ...o });

describe('HaDeclarer', () => {
  it('retrouve l\'entrée par nom réseau, puis adresse, puis titre', () => {
    const cible = { appareil: 'hasat4', nomAffichage: 'Satellite 4', adresse: '192.168.1.44' };
    expect(trouverEntree([entree({ entry_id: 'A', data: { device_name: 'autre' } }), entree()], cible)?.entry_id).toBe('E1');
    expect(trouverEntree([entree({ data: { host: '192.168.1.44' } })], { ...cible, appareil: 'nouveau' })?.entry_id).toBe('E1');
    expect(trouverEntree([entree({ data: {} })], { ...cible, appareil: 'x', adresse: 'y' })?.entry_id).toBe('E1'); // par titre
    expect(trouverEntree([], cible)).toBeNull();
  });

  it('état : entrée et version du firmware de l\'appareil', async () => {
    const s: EtatHaSimule = { entrees: [entree()], appareils: [{ id: 'D1', name: 'hasat4', sw_version: '2025.11.2 (Oct 6 2026, 20:12:36)', config_entries: ['E1'] }], flux: { requetes: [], etapes: [] } };
    const e = await new HaDeclarer(fauxHa(s)).etat({ appareil: 'hasat4', nomAffichage: 'Satellite 4', adresse: 'x' });
    expect(e.appareil?.sw_version).toContain('Oct 6 2026');
  });

  it('déclare un appareil neuf chiffré : adresse, clé, puis « autoriser les appels de service »', async () => {
    const s: EtatHaSimule = { entrees: [], appareils: [], flux: { requetes: [], etapes: [
      { type: 'form', flow_id: 'F1', step_id: 'user', data_schema: [{ name: 'host' }, { name: 'port' }] },
      { type: 'form', flow_id: 'F1', step_id: 'encryption_key', data_schema: [{ name: 'noise_psk' }] },
      { type: 'create_entry', result: { entry_id: 'E9' } },
      { type: 'form', flow_id: 'O1', step_id: 'init', data_schema: [{ name: 'allow_service_calls' }] },
      { type: 'create_entry' }
    ] } };
    const id = await new HaDeclarer(fauxHa(s)).declarer({ adresse: '192.168.1.44', portApi: 6053, cle: 'LA-CLE', autoriserAppelsService: true });
    expect(id).toBe('E9');
    expect(s.flux.requetes.map((r) => [r.chemin, r.corps])).toEqual([
      ['/config/config_entries/flow', { handler: 'esphome', show_advanced_options: false }],
      ['/config/config_entries/flow/F1', { host: '192.168.1.44', port: 6053 }],
      ['/config/config_entries/flow/F1', { noise_psk: 'LA-CLE' }],
      ['/config/config_entries/options/flow', { handler: 'E9' }],
      ['/config/config_entries/options/flow/O1', { allow_service_calls: true }]
    ]);
  });

  it('appareil chiffré mais clé absente du message : erreur explicite (pas de clé inventée)', async () => {
    const s: EtatHaSimule = { entrees: [], appareils: [], flux: { requetes: [], etapes: [
      { type: 'form', flow_id: 'F1', step_id: 'user', data_schema: [{ name: 'host' }, { name: 'port' }] },
      { type: 'form', flow_id: 'F1', step_id: 'encryption_key', data_schema: [{ name: 'noise_psk' }] }
    ] } };
    await expect(new HaDeclarer(fauxHa(s)).declarer({ adresse: 'x', portApi: 6053, autoriserAppelsService: false })).rejects.toThrow(/api_<appareil>/);
  });

  it('HA refuse (appareil injoignable) : l\'erreur remonte avec la raison', async () => {
    const s: EtatHaSimule = { entrees: [], appareils: [], flux: { requetes: [], etapes: [
      { type: 'form', flow_id: 'F1', step_id: 'user', data_schema: [{ name: 'host' }, { name: 'port' }] },
      { type: 'form', flow_id: 'F1', step_id: 'user', data_schema: [{ name: 'host' }, { name: 'port' }], errors: { base: 'connection_error' } }
    ] } };
    await expect(new HaDeclarer(fauxHa(s)).declarer({ adresse: 'x', portApi: 6053, autoriserAppelsService: false })).rejects.toThrow(/connection_error/);
  });
});

// --- Poseur ---------------------------------------------------------------------------------------------------
const firmware = Buffer.alloc(5000, 3);
const pose = (o: Partial<Pose> = {}): Pose => ({ v: 1, site: 'noisy', appareil: 'hasat4', revision: 3, at: '2026-10-13T18:00:00+02:00', firmware: 'http://usine/f.bin', sha256: sha256(firmware), tailleOctets: firmware.length, esp: '192.168.1.44', portApi: 6053, portOta: 3232, nomAffichage: 'Satellite 4', options: { autoriserAppelsService: false }, ...o });

let evts: string[], statuts: any[], sim: EtatHaSimule, otaAppels: OptionsOta[], ota: (o: OptionsOta) => Promise<any>, dl: () => Promise<Buffer>, deps: DepsPoseur;
const appareil = (v: string): AppareilHa => ({ id: 'D1', name: 'hasat4', sw_version: v, config_entries: ['E1'] });

beforeEach(() => {
  evts = []; statuts = []; otaAppels = [];
  sim = { entrees: [entree()], appareils: [appareil('2025.11.2 (Oct 6 2026, 20:12:36)')], flux: { requetes: [], etapes: [] } };
  dl = async () => firmware;
  ota = async (o) => { otaAppels.push(o); sim.appareils = [appareil('2025.11.2 (Oct 13 2026, 21:00:00)')]; return { versionProtocole: 2, compresse: true, octetsEnvoyes: 1000 }; };
  deps = {
    telecharger: () => dl(), ota: (o) => ota(o), ha: new HaDeclarer(fauxHa(sim)),
    publication: { statut: (_s, _a, etat, extra) => { evts.push('statut:' + etat); statuts.push({ etat, ...extra }); }, supprimerPose: () => evts.push('supprime') },
    motDePasseOta: 'mdp-site', attendre: async () => undefined, intervalleVerifMs: 10_000, delaiVerifMs: 60_000
  };
});

describe('InstallerService', () => {
  it('appareil connu de HA : envoi, version changée, pose supprimée, état terminé avec la version', async () => {
    expect(await new InstallerService(deps).traiter(pose())).toBe('termine');
    expect(otaAppels).toHaveLength(1);
    expect(otaAppels[0]).toMatchObject({ hote: '192.168.1.44', port: 3232, motDePasse: 'mdp-site' });
    expect(otaAppels[0].firmware.equals(firmware)).toBe(true);
    expect(evts).toEqual(['statut:recuperation', 'statut:envoi', 'statut:verification', 'statut:termine', 'supprime']);
    expect(statuts.at(-1).versionFirmware).toContain('Oct 13 2026');
  });

  it('appareil neuf : déclaré dans HA avec la clé du message, puis vérifié', async () => {
    sim.entrees = [];
    sim.appareils = [];
    sim.flux.etapes = [
      { type: 'form', flow_id: 'F', step_id: 'user', data_schema: [{ name: 'host' }, { name: 'port' }] },
      { type: 'form', flow_id: 'F', step_id: 'encryption_key', data_schema: [{ name: 'noise_psk' }] },
      { type: 'create_entry', result: { entry_id: 'E1' } }
    ];
    ota = async (o) => { otaAppels.push(o); sim.entrees = [entree()]; sim.appareils = [appareil('2025.11.2 (Oct 13 2026, 21:00:00)')]; return { versionProtocole: 2, compresse: false, octetsEnvoyes: 5000 }; };
    expect(await new InstallerService(deps).traiter(pose({ cle: 'CLE-NEUVE' }))).toBe('termine');
    expect(sim.flux.requetes[2].corps).toEqual({ noise_psk: 'CLE-NEUVE' });
  });

  it('ESP injoignable : le message de pose RESTE (nouvelle tentative), aucun envoi réussi', async () => {
    ota = async () => { throw new OtaError('connexion à 192.168.1.44:3232 impossible : timeout'); };
    expect(await new InstallerService(deps).traiter(pose())).toBe('a_reessayer');
    expect(evts).not.toContain('supprime');
    expect(statuts.at(-1).detail).toContain('ESP injoignable');
  });

  it('ESP qui refuse (mot de passe, partition) : échec définitif, message supprimé', async () => {
    ota = async () => { throw new OtaError('authentification : authentification refusée : le mot de passe OTA est-il correct ?'); };
    expect(await new InstallerService(deps).traiter(pose())).toBe('echec');
    expect(evts).toContain('supprime');
    expect(statuts.at(-1).detail).toContain('mot de passe OTA');
  });

  it('firmware corrompu ou incomplet : à réessayer, rien envoyé à l\'ESP', async () => {
    dl = async () => Buffer.alloc(5000, 9);
    expect(await new InstallerService(deps).traiter(pose())).toBe('a_reessayer');
    dl = async () => Buffer.alloc(100);
    expect(await new InstallerService(deps).traiter(pose())).toBe('a_reessayer');
    expect(otaAppels).toEqual([]);
  });

  it('envoi réussi mais version inchangée dans HA : échec explicite', async () => {
    ota = async (o) => { otaAppels.push(o); return { versionProtocole: 2, compresse: false, octetsEnvoyes: 1 }; }; // l'ESP n'a pas redémarré sur le nouveau firmware
    expect(await new InstallerService(deps).traiter(pose())).toBe('echec');
    expect(statuts.at(-1).detail).toContain("le firmware n'a pas changé dans HA");
  });

  it('appareil neuf, clé absente du message : échec clair APRÈS l\'envoi (firmware déjà posé)', async () => {
    sim.entrees = []; sim.appareils = [];
    sim.flux.etapes = [
      { type: 'form', flow_id: 'F', step_id: 'user', data_schema: [{ name: 'host' }, { name: 'port' }] },
      { type: 'form', flow_id: 'F', step_id: 'encryption_key', data_schema: [{ name: 'noise_psk' }] }
    ];
    expect(await new InstallerService(deps).traiter(pose())).toBe('echec');
    expect(statuts.at(-1).detail).toContain('déclaration dans HA impossible');
    expect(statuts.at(-1).detail).toContain('api_<appareil>');
  });

  it('HA injoignable avant l\'envoi : à réessayer, aucun envoi', async () => {
    deps.ha = { etat: async () => { throw new Error('socket HA fermé'); } } as unknown as HaDeclarer;
    expect(await new InstallerService(deps).traiter(pose())).toBe('a_reessayer');
    expect(otaAppels).toEqual([]);
  });
});
