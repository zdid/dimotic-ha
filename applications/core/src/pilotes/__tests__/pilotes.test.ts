// pilotes.test.ts — canal « gestion des pilotes » (conception-gestion-pilotes_specs v1.1) :
// PilotesGateway (cœur) + PilotePont (application) reliés par un EventBus local et un faux transport MQTT.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../../application/EventBus';
import type { MqttMessage } from '../../infrastructure/transport/MqttTransport';
import { PilotePont, type PiloteGestionnaire } from '../PilotePont';
import { PilotesGateway, type PilotesTransport } from '../PilotesGateway';
import { jetonApercu, signerRequete, sujetsPilotes, type PiloteReponse, type PiloteRequete } from '../types';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const SITE = 'noisy';
const MACHINE = 'noisy2_123456';
const SUJETS = sujetsPilotes(SITE);

class FauxTransport implements PilotesTransport {
  publies: Array<{ topic: string; payload: string; qos?: number; retain?: boolean }> = [];
  abonnements: string[] = [];
  private surMessage: (m: MqttMessage) => void = () => {};
  private surConnexion: () => void = () => {};
  connect(): void { this.surConnexion(); }
  disconnect(): void {}
  publish(topic: string, payload: string | Buffer, qos?: 0 | 1, retain?: boolean): void {
    this.publies.push({ topic, payload: payload.toString(), qos, retain });
  }
  subscribe(topic: string): void { this.abonnements.push(topic); }
  onMessage(cb: (m: MqttMessage) => void): void { this.surMessage = cb; }
  onConnect(cb: () => void): void { this.surConnexion = cb; }
  recevoir(topic: string, payload: unknown, retain = false): void {
    this.surMessage({ topic, payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), qos: 1, retain });
  }
  dernier(topic: string): Record<string, unknown> | undefined {
    const p = [...this.publies].reverse().find((x) => x.topic === topic);
    return p ? (JSON.parse(p.payload) as Record<string, unknown>) : undefined;
  }
}

/** Gestionnaire factice : une liste de capteurs ; `supprimer` en retire un. */
function creerGestionnaire(): PiloteGestionnaire & { capteurs: string[] } {
  const g = {
    capteurs: ['a', 'b'],
    async lire(ordre: string) { return ordre === 'lister' ? { capteurs: [...g.capteurs] } : { decouverts: ['nouveau'] }; },
    async preparer(ordre: string, p: Record<string, unknown>) {
      return { apercu: { retire: p.nom }, etat: g.capteurs };
    },
    async appliquer(_ordre: string, p: Record<string, unknown>) {
      g.capteurs = g.capteurs.filter((c) => c !== p.nom);
      return { resultat: { reste: g.capteurs.length }, sauvegarde: '/x/f.bak' };
    }
  };
  return g;
}

async function laisser(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

describe('canal pilotes', () => {
  let bus: EventBus;
  let transport: FauxTransport;
  let gateway: PilotesGateway;
  let pont: PilotePont;
  let gestionnaire: ReturnType<typeof creerGestionnaire>;
  const SECRET = 'secret-de-test';
  let maintenant = Date.parse('2026-10-15T20:00:00Z');

  function demarrer(secret: string | undefined, delaiReponseMs = 60_000): void {
    bus = new EventBus();
    transport = new FauxTransport();
    gestionnaire = creerGestionnaire();
    // l'événement REQUETE traverse « l'IPC » : ici le même bus, la présence/réponse aussi
    gateway = new PilotesGateway(transport, bus, logger, { site: SITE, machineId: MACHINE, secret, delaiReponseMs, delaiHeritageMs: 50, maintenant: () => maintenant });
    gateway.start();
    pont = new PilotePont(bus, logger, {
      appId: 'testcycle', pont: 'test_bridge_x', type: 'test', capacites: ['lister', 'decouverts', 'supprimer'], gestionnaire
    });
    pont.start();
  }

  function requete(partiel: Partial<PiloteRequete> & { ordre: string }, secret = SECRET): PiloteRequete {
    const r: PiloteRequete = { id: 'r1', pont: 'test_bridge_x', date: new Date(maintenant).toISOString(), ...partiel };
    if (secret) r.signature = signerRequete(secret, r);
    return r;
  }

  function envoyer(r: PiloteRequete): void {
    transport.recevoir(SUJETS.requete(r.pont, r.id), r);
  }

  function reponse(id = 'r1'): PiloteReponse | undefined {
    return transport.dernier(SUJETS.reponse('test_bridge_x', id)) as PiloteReponse | undefined;
  }

  afterEach(() => { vi.useRealTimers(); });

  describe('présence', () => {
    beforeEach(() => demarrer(SECRET));

    it('publie la présence retenue du pont avec machine, application et date', () => {
      const p = transport.publies.find((x) => x.topic === SUJETS.presence('test_bridge_x'));
      expect(p?.retain).toBe(true);
      expect(JSON.parse(p!.payload)).toMatchObject({ pont: 'test_bridge_x', type: 'test', etat: 'en_ligne', machine: MACHINE, appId: 'testcycle' });
    });

    it('publie la présence de la machine (retenue) à la connexion et s\'abonne aux requêtes et aux présences', () => {
      expect(transport.dernier(SUJETS.machine(MACHINE))).toMatchObject({ etat: 'en_ligne' });
      expect(transport.abonnements).toEqual(expect.arrayContaining([SUJETS.abonnementRequetes, SUJETS.abonnementPresences]));
    });

    it('passe le pont hors ligne quand le process de l\'application s\'arrête', () => {
      gateway.surArretApplication('testcycle');
      expect(transport.dernier(SUJETS.presence('test_bridge_x'))).toMatchObject({ etat: 'hors_ligne' });
    });

    it('un pont qui s\'annonce de nouveau repasse en ligne', () => {
      gateway.surArretApplication('testcycle');
      bus.emitGeneric('pilotes:presence:demande', {});
      expect(transport.dernier(SUJETS.presence('test_bridge_x'))).toMatchObject({ etat: 'en_ligne' });
    });

    it('corrige une présence retenue périmée de cette machine que personne ne ré-annonce', async () => {
      const ancien = { pont: 'fantome_bridge', machine: MACHINE, appId: 'x', type: 'arexx', capacites: [], etat: 'en_ligne', date: 'avant' };
      transport.recevoir(SUJETS.presence('fantome_bridge'), ancien, true);
      await new Promise((r) => setTimeout(r, 80));
      expect(transport.dernier(SUJETS.presence('fantome_bridge'))).toMatchObject({ etat: 'hors_ligne' });
    });

    it('ne touche pas la présence retenue d\'une AUTRE machine', async () => {
      const autre = { pont: 'autre_bridge', machine: 'noisy_999', appId: 'x', type: 'arexx', capacites: [], etat: 'en_ligne', date: 'avant' };
      transport.recevoir(SUJETS.presence('autre_bridge'), autre, true);
      await new Promise((r) => setTimeout(r, 80));
      expect(transport.publies.some((x) => x.topic === SUJETS.presence('autre_bridge'))).toBe(false);
    });
  });

  describe('requêtes de lecture', () => {
    beforeEach(() => demarrer(SECRET));

    it('lister : transmis à l\'application, réponse publiée non retenue', async () => {
      envoyer(requete({ ordre: 'lister' }));
      await laisser();
      expect(reponse()).toMatchObject({ ok: true, resultat: { capteurs: ['a', 'b'] } });
      expect(transport.publies.find((x) => x.topic === SUJETS.reponse('test_bridge_x', 'r1'))?.retain).toBe(false);
    });

    it('ordre non déclaré par le pont → erreur ordre_non_declare', async () => {
      envoyer(requete({ ordre: 'adopter' }));
      await laisser();
      expect(reponse()?.erreur?.code).toBe('ordre_non_declare');
    });

    it('ordre inconnu → erreur du cœur', async () => {
      envoyer(requete({ ordre: 'format_disque' }));
      await laisser();
      expect(reponse()?.erreur?.code).toBe('ordre_inconnu');
    });

    it('pont inconnu : aucune réponse (c\'est le pont d\'une autre machine)', async () => {
      transport.recevoir(SUJETS.requete('autre_bridge', 'r9'), requete({ id: 'r9', pont: 'autre_bridge', ordre: 'lister' }));
      await laisser();
      expect(transport.publies.some((x) => x.topic === SUJETS.reponse('autre_bridge', 'r9'))).toBe(false);
    });

    it('pont hors ligne → erreur pont_hors_ligne', async () => {
      gateway.surArretApplication('testcycle');
      envoyer(requete({ ordre: 'lister' }));
      await laisser();
      expect(reponse()?.erreur?.code).toBe('pont_hors_ligne');
    });

    it('une requête retenue est ignorée', async () => {
      transport.recevoir(SUJETS.requete('test_bridge_x', 'r1'), requete({ ordre: 'lister' }), true);
      await laisser();
      expect(reponse()).toBeUndefined();
    });
  });

  describe('sécurité', () => {
    it('avec secret : signature absente ou fausse → refus signature_invalide', async () => {
      demarrer(SECRET);
      envoyer(requete({ ordre: 'lister' }, ''));
      await laisser();
      expect(reponse()?.erreur?.code).toBe('signature_invalide');
      envoyer(requete({ id: 'r2', ordre: 'lister' }, 'mauvais-secret'));
      await laisser();
      expect(reponse('r2')?.erreur?.code).toBe('signature_invalide');
    });

    it('avec secret : une requête modifiée après signature est refusée', async () => {
      demarrer(SECRET);
      const r = requete({ ordre: 'lister', parametres: { a: 1 } });
      r.parametres = { a: 2 };
      envoyer(r);
      await laisser();
      expect(reponse()?.erreur?.code).toBe('signature_invalide');
    });

    it('sans secret : lister permis, ordre modifiant refusé signature_requise', async () => {
      demarrer(undefined);
      envoyer(requete({ ordre: 'lister' }, ''));
      await laisser();
      expect(reponse()?.ok).toBe(true);
      envoyer(requete({ id: 'r2', ordre: 'supprimer', apercu: true }, ''));
      await laisser();
      expect(reponse('r2')?.erreur?.code).toBe('signature_requise');
    });

    it('requête trop ancienne → requete_expiree', async () => {
      demarrer(SECRET);
      envoyer(requete({ ordre: 'lister', date: new Date(maintenant - 10 * 60_000).toISOString() }));
      await laisser();
      expect(reponse()?.erreur?.code).toBe('requete_expiree');
    });
  });

  describe('ordres modifiants : aperçu puis jeton', () => {
    beforeEach(() => demarrer(SECRET));

    it('aperçu : renvoie apercu + jeton et ne modifie rien', async () => {
      envoyer(requete({ ordre: 'supprimer', parametres: { nom: 'a' }, apercu: true }));
      await laisser();
      const r = reponse()!;
      expect(r.ok).toBe(true);
      expect(r.apercu).toEqual({ retire: 'a' });
      expect(r.jeton).toBe(jetonApercu('test_bridge_x', 'supprimer', { nom: 'a' }, ['a', 'b']));
      expect(gestionnaire.capteurs).toEqual(['a', 'b']);
    });

    it('sans jeton → jeton_requis, rien de modifié', async () => {
      envoyer(requete({ ordre: 'supprimer', parametres: { nom: 'a' } }));
      await laisser();
      expect(reponse()?.erreur?.code).toBe('jeton_requis');
      expect(gestionnaire.capteurs).toEqual(['a', 'b']);
    });

    it('avec le bon jeton → appliqué, sauvegarde indiquée', async () => {
      envoyer(requete({ ordre: 'supprimer', parametres: { nom: 'a' }, apercu: true }));
      await laisser();
      const jeton = reponse()!.jeton!;
      envoyer(requete({ id: 'r2', ordre: 'supprimer', parametres: { nom: 'a' }, jeton }));
      await laisser();
      expect(reponse('r2')).toMatchObject({ ok: true, resultat: { reste: 1 }, sauvegarde: '/x/f.bak' });
      expect(gestionnaire.capteurs).toEqual(['b']);
    });

    it('état changé entre l\'aperçu et l\'application → etat_change, rien de modifié', async () => {
      envoyer(requete({ ordre: 'supprimer', parametres: { nom: 'a' }, apercu: true }));
      await laisser();
      const jeton = reponse()!.jeton!;
      gestionnaire.capteurs = ['a', 'b', 'c']; // quelqu'un a modifié entre-temps
      envoyer(requete({ id: 'r2', ordre: 'supprimer', parametres: { nom: 'a' }, jeton }));
      await laisser();
      expect(reponse('r2')?.erreur?.code).toBe('etat_change');
      expect(gestionnaire.capteurs).toEqual(['a', 'b', 'c']);
    });

    it('une erreur du gestionnaire est renvoyée en erreur_pilote', async () => {
      gestionnaire.preparer = async () => { throw new Error('fichier illisible'); };
      envoyer(requete({ ordre: 'supprimer', parametres: { nom: 'a' }, apercu: true }));
      await laisser();
      expect(reponse()?.erreur).toMatchObject({ code: 'erreur_pilote', message: 'fichier illisible' });
    });
  });

  describe('délai de réponse', () => {
    it('application muette → delai_depasse', async () => {
      demarrer(SECRET, 30);
      gestionnaire.lire = () => new Promise(() => {}); // ne répond jamais
      envoyer(requete({ ordre: 'lister' }));
      await new Promise((r) => setTimeout(r, 60));
      expect(reponse()?.erreur?.code).toBe('delai_depasse');
    });
  });

  describe('côté agent (ia → cœur → MQTT)', () => {
    /** Fait ce que fait le broker : renvoie au cœur ce qu'il a publié sur un sujet. */
    function boucle(topic: string): void {
      const p = [...transport.publies].reverse().find((x) => x.topic === topic);
      if (p) transport.recevoir(topic, p.payload);
    }

    it('signe la requête avec le secret du cœur, la publie non retenue, et renvoie la réponse du pont', async () => {
      demarrer(SECRET);
      const recues: Array<{ ref: string; reponse: PiloteReponse }> = [];
      bus.onGeneric('pilotes:agent:reponse', (d) => recues.push(d as never));
      bus.emitGeneric('pilotes:agent:requete', { ref: 'abc', pont: 'test_bridge_x', ordre: 'lister', parametres: {} });
      const pub = transport.publies.find((x) => x.topic.includes('/test_bridge_x/requete/'))!;
      expect(pub.retain).toBe(false);
      const envoyee = JSON.parse(pub.payload) as PiloteRequete;
      expect(envoyee.signature).toBe(signerRequete(SECRET, envoyee));
      transport.recevoir(pub.topic, pub.payload); // le broker la rend au cœur, qui la traite
      await laisser();
      boucle(SUJETS.reponse('test_bridge_x', envoyee.id));
      expect(recues).toHaveLength(1);
      expect(recues[0].ref).toBe('abc');
      expect(recues[0].reponse.ok).toBe(true);
    });

    it('un ordre inconnu est refusé sans rien publier', () => {
      demarrer(SECRET);
      const recues: Array<{ reponse: PiloteReponse }> = [];
      bus.onGeneric('pilotes:agent:reponse', (d) => recues.push(d as never));
      const avant = transport.publies.length;
      bus.emitGeneric('pilotes:agent:requete', { ref: 'x', pont: 'test_bridge_x', ordre: 'danser' });
      expect(transport.publies.length).toBe(avant);
      expect(recues[0].reponse.erreur?.code).toBe('requete_invalide');
    });

    it('liste les ponts du site, dont ceux d\'une autre machine, avec leur joignabilité', () => {
      demarrer(SECRET);
      const autre = { pont: 'arexx_bridge_noisy', machine: 'noisy_999', appId: 'arexx', type: 'arexx', capacites: ['lister'], etat: 'en_ligne', date: 'x' };
      transport.recevoir(SUJETS.presence('arexx_bridge_noisy'), autre, true);
      transport.recevoir(SUJETS.machine('noisy_999'), { machine: 'noisy_999', etat: 'hors_ligne' }, true);
      let ponts: Array<{ pont: string; joignable: boolean }> = [];
      bus.onGeneric('pilotes:agent:ponts', (d) => { ponts = (d as { ponts: typeof ponts }).ponts; });
      bus.emitGeneric('pilotes:agent:ponts:get', { ref: 'p' });
      expect(ponts.find((p) => p.pont === 'test_bridge_x')?.joignable).toBe(true);
      expect(ponts.find((p) => p.pont === 'arexx_bridge_noisy')?.joignable).toBe(false);
    });
  });
});
