/**
 * PilotesGateway — côté CŒUR du canal « gestion des pilotes » (conception-gestion-pilotes_specs v1.1 §3, §4, §11).
 *
 * - publie en MQTT (retenu) la présence des ponts annoncés par les applications, et « hors ligne » quand leur process
 *   s'arrête ; un testament signale que la MACHINE est partie (les ponts de cette machine sont alors injoignables) ;
 * - reçoit les requêtes `dimotic/<site>/pilotes/<pont>/requete/<id>`, les contrôle (forme, durée de validité)
 *   puis les transmet à l'application par l'EventBus local (pont IPC) ;
 * - publie la réponse sur `…/reponse/<id>` (jamais retenue).
 *
 * Aucune requête n'est jamais publiée ni relayée en « retenu ». Les requêtes ne sont PAS signées (retiré le 20/10/2026) : toute
 * machine qui peut publier sur le broker du site peut les émettre ; les ordres modifiants gardent leur aperçu + jeton (§5.2).
 */

import type { IEventBus } from '../application/IEventBus';
import type { Logger } from '../infrastructure/logger/index';
import type { MqttMessage } from '../infrastructure/transport/MqttTransport';
import {
  PILOTES_EVENTS,
  PILOTE_DUREE_VALIDITE_REQUETE_MS,
  PILOTE_ID_REGEX,
  estOrdreConnu,
  segmentSite,
  sujetsPilotes,
  type PiloteAgentPontsEvenement,
  type PiloteAgentRequeteEvenement,
  type PontSite,
  type PilotePresence,
  type PilotePresenceEvenement,
  type PilotePresencePubliee,
  type PiloteReponse,
  type PiloteReponseEvenement,
  type PiloteRequete
} from './types';

/** Ce que la passerelle attend d'un transport MQTT (satisfait par `MqttTransport`). */
export interface PilotesTransport {
  connect(): void;
  disconnect(): void;
  publish(topic: string, payload: string | Buffer, qos?: 0 | 1, retain?: boolean): void;
  subscribe(topic: string, qos?: 0 | 1): void;
  onMessage(callback: (message: MqttMessage) => void): void;
  onConnect(callback: () => void): void;
}

export interface PilotesGatewayOptions {
  site: string;
  machineId: string;
  /** Délai max d'une réponse d'application avant « delai_depasse » (défaut 60 s). */
  delaiReponseMs?: number;
  /** Attente avant de déclarer « hors ligne » les ponts retenus de cette machine non ré-annoncés (défaut 15 s). */
  delaiHeritageMs?: number;
  /** Horloge injectable (tests). */
  maintenant?: () => number;
}

interface PontConnu {
  appId: string;
  presence: PilotePresence;
}

export class PilotesGateway {
  private readonly ponts = new Map<string, PontConnu>();
  private readonly attentes = new Map<string, NodeJS.Timeout>();
  private readonly heritage = new Map<string, PilotePresencePubliee>();
  private heritageTimer: NodeJS.Timeout | null = null;
  private readonly sujets: ReturnType<typeof sujetsPilotes>;
  private readonly delaiReponseMs: number;
  private readonly delaiHeritageMs: number;
  private readonly maintenant: () => number;
  private demarre = false;
  /** Présences de TOUT le site (retenues ou non) et état des machines — pour la liste des ponts de l'agent. */
  private readonly presencesSite = new Map<string, PilotePresencePubliee>();
  private readonly machinesSite = new Map<string, string>();
  /** Requêtes de l'agent en attente d'une réponse (clé `pont/id`). */
  private readonly attentesAgent = new Map<string, { ref: string; timer: NodeJS.Timeout }>();
  private compteurAgent = 0;

  constructor(
    private readonly transport: PilotesTransport,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly options: PilotesGatewayOptions
  ) {
    this.sujets = sujetsPilotes(options.site);
    this.delaiReponseMs = options.delaiReponseMs ?? 60_000;
    this.delaiHeritageMs = options.delaiHeritageMs ?? 15_000;
    this.maintenant = options.maintenant ?? (() => Date.now());
  }

  /** Testament à donner au transport (à la construction de `MqttTransport`). */
  static testamentMachine(site: string, machineId: string): { willTopic: string; willPayload: string } {
    return {
      willTopic: sujetsPilotes(site).machine(machineId),
      willPayload: JSON.stringify({ machine: machineId, etat: 'hors_ligne' })
    };
  }

  start(): void {
    if (this.demarre) return;
    this.demarre = true;

    this.eventBus.onGeneric<PilotePresenceEvenement>(PILOTES_EVENTS.PRESENCE, (data) => this.surPresenceApplication(data));
    this.eventBus.onGeneric<PiloteReponseEvenement>(PILOTES_EVENTS.REPONSE, (data) => this.surReponseApplication(data));

    this.eventBus.onGeneric<PiloteAgentRequeteEvenement>(PILOTES_EVENTS.AGENT_REQUETE, (data) => this.surRequeteAgent(data));
    this.eventBus.onGeneric<{ ref: string }>(PILOTES_EVENTS.AGENT_PONTS_DEMANDE, (data) => this.repondrePonts(data?.ref ?? ''));

    this.transport.onMessage((message) => this.surMessageMqtt(message));
    this.transport.onConnect(() => {
      this.transport.subscribe(this.sujets.abonnementRequetes, 1);
      this.transport.subscribe(this.sujets.abonnementPresences, 1);
      this.transport.subscribe(`${this.sujets.racine}/_machines/+`, 1);
      this.transport.subscribe(`${this.sujets.racine}/+/reponse/+`, 1);
      this.publierMachine('en_ligne');
      // Les applications déjà démarrées s'annoncent à nouveau (broker ou cœur redémarré).
      this.eventBus.emitGeneric(PILOTES_EVENTS.PRESENCE_DEMANDE, {});
      for (const [pont, connu] of this.ponts) this.publierPresence(pont, connu);
    });
    this.transport.connect();
    this.logger.info('PilotesGateway', `Canal pilotes démarré (site « ${segmentSite(this.options.site)} », machine ${this.options.machineId}, requêtes non signées)`);
  }

  stop(): void {
    if (!this.demarre) return;
    this.demarre = false;
    for (const [pont, connu] of this.ponts) {
      if (connu.presence.etat === 'en_ligne') {
        connu.presence = { ...connu.presence, etat: 'hors_ligne' };
        this.publierPresence(pont, connu);
      }
    }
    this.publierMachine('hors_ligne');
    for (const timer of this.attentes.values()) clearTimeout(timer);
    this.attentes.clear();
    for (const a of this.attentesAgent.values()) clearTimeout(a.timer);
    this.attentesAgent.clear();
    if (this.heritageTimer) clearTimeout(this.heritageTimer);
    this.transport.disconnect();
  }

  /** À appeler quand le process d'une application s'arrête (arrêt demandé ou plantage). */
  surArretApplication(appId: string): void {
    for (const [pont, connu] of this.ponts) {
      if (connu.appId !== appId || connu.presence.etat === 'hors_ligne') continue;
      connu.presence = { ...connu.presence, etat: 'hors_ligne' };
      this.publierPresence(pont, connu);
      this.logger.info('PilotesGateway', `Pont ${pont} hors ligne (application ${appId} arrêtée)`);
    }
  }

  /** Ponts connus (état courant) — pour l'interface et les tests. */
  listerPonts(): Array<{ pont: string; appId: string; presence: PilotePresence }> {
    return [...this.ponts].map(([pont, connu]) => ({ pont, appId: connu.appId, presence: connu.presence }));
  }

  // ---------------------------------------------------------------------------
  // Application → MQTT
  // ---------------------------------------------------------------------------

  private surPresenceApplication(data: PilotePresenceEvenement): void {
    const presence = data?.presence;
    if (!data?.appId || !presence?.pont) return;
    const connu: PontConnu = { appId: data.appId, presence };
    this.ponts.set(presence.pont, connu);
    this.heritage.delete(presence.pont);
    this.publierPresence(presence.pont, connu);
  }

  private publierPresence(pont: string, connu: PontConnu): void {
    const publiee: PilotePresencePubliee = {
      ...connu.presence,
      machine: this.options.machineId,
      appId: connu.appId,
      date: new Date(this.maintenant()).toISOString()
    };
    this.transport.publish(this.sujets.presence(pont), JSON.stringify(publiee), 1, true);
  }

  private publierMachine(etat: 'en_ligne' | 'hors_ligne'): void {
    this.transport.publish(
      this.sujets.machine(this.options.machineId),
      JSON.stringify({ machine: this.options.machineId, etat, date: new Date(this.maintenant()).toISOString() }),
      1,
      true
    );
  }

  private surReponseApplication(data: PiloteReponseEvenement): void {
    const reponse = data?.reponse;
    if (!reponse?.id || !reponse.pont) return;
    const cle = `${reponse.pont}/${reponse.id}`;
    const timer = this.attentes.get(cle);
    if (!timer) return; // réponse tardive ou inattendue : déjà traitée
    clearTimeout(timer);
    this.attentes.delete(cle);
    this.publierReponse(reponse);
  }

  private publierReponse(reponse: PiloteReponse): void {
    this.transport.publish(this.sujets.reponse(reponse.pont, reponse.id), JSON.stringify(reponse), 1, false);
  }

  private repondreErreur(requete: Pick<PiloteRequete, 'id' | 'pont'>, code: string, message: string): void {
    this.publierReponse({ id: requete.id, pont: requete.pont, ok: false, erreur: { code, message } });
  }

  // ---------------------------------------------------------------------------
  // MQTT → application
  // ---------------------------------------------------------------------------

  private surMessageMqtt(message: MqttMessage): void {
    const racine = this.sujets.racine + '/';
    if (!message.topic.startsWith(racine)) return;
    const segments = message.topic.slice(racine.length).split('/');

    if (segments.length === 2 && segments[0] === '_machines') {
      this.noterMachine(segments[1] as string, message);
    } else if (segments.length === 2 && segments[1] === 'presence') {
      this.noterPresence(segments[0] as string, message);
      this.surPresenceRetenue(segments[0] as string, message);
    } else if (segments.length === 3 && segments[1] === 'reponse') {
      this.surReponseMqtt(segments[0] as string, segments[2] as string, message);
    } else if (segments.length === 3 && segments[1] === 'requete') {
      if (message.retain) {
        this.logger.warn('PilotesGateway', `Requête retenue ignorée sur ${message.topic} (une requête ne doit jamais être retenue)`);
        return;
      }
      this.surRequete(segments[0] as string, segments[2] as string, message);
    }
  }

  /** Présence retenue d'une exécution précédente de CETTE machine : à corriger si le pont ne revient pas. */
  private surPresenceRetenue(pont: string, message: MqttMessage): void {
    if (!message.retain || this.ponts.has(pont)) return;
    try {
      const publiee = JSON.parse(message.payload.toString()) as PilotePresencePubliee;
      if (publiee.machine !== this.options.machineId || publiee.etat !== 'en_ligne') return;
      this.heritage.set(pont, publiee);
      if (!this.heritageTimer) {
        this.heritageTimer = setTimeout(() => this.purgerHeritage(), this.delaiHeritageMs);
        this.heritageTimer.unref?.();
      }
    } catch {
      /* présence illisible : ignorée */
    }
  }

  private purgerHeritage(): void {
    this.heritageTimer = null;
    for (const [pont, publiee] of this.heritage) {
      if (this.ponts.has(pont)) continue;
      this.transport.publish(
        this.sujets.presence(pont),
        JSON.stringify({ ...publiee, etat: 'hors_ligne', date: new Date(this.maintenant()).toISOString() }),
        1,
        true
      );
      this.logger.info('PilotesGateway', `Présence retenue périmée corrigée : ${pont} → hors ligne`);
    }
    this.heritage.clear();
  }

  private surRequete(pontTopic: string, idTopic: string, message: MqttMessage): void {
    const connu = this.ponts.get(pontTopic);
    if (!connu) return; // pont d'une autre machine du site : pas pour nous, aucune réponse

    let requete: PiloteRequete;
    try {
      requete = JSON.parse(message.payload.toString()) as PiloteRequete;
    } catch {
      this.repondreErreur({ id: idTopic, pont: pontTopic }, 'requete_invalide', 'JSON attendu');
      return;
    }
    // Le sujet fait foi pour le pont et l'identifiant.
    requete = { ...requete, pont: pontTopic, id: idTopic };
    const ref = { id: idTopic, pont: pontTopic };

    if (!PILOTE_ID_REGEX.test(idTopic)) return this.repondreErreur(ref, 'requete_invalide', 'identifiant invalide');
    if (typeof requete.ordre !== 'string' || !estOrdreConnu(requete.ordre)) {
      return this.repondreErreur(ref, 'ordre_inconnu', `Ordre inconnu : ${String(requete.ordre)}`);
    }
    if (requete.date) {
      const age = this.maintenant() - Date.parse(requete.date);
      if (!Number.isFinite(age) || age > PILOTE_DUREE_VALIDITE_REQUETE_MS || age < -PILOTE_DUREE_VALIDITE_REQUETE_MS) {
        return this.repondreErreur(ref, 'requete_expiree', 'Requête trop ancienne ou horloge décalée');
      }
    }

    if (connu.presence.etat !== 'en_ligne') {
      return this.repondreErreur(ref, 'pont_hors_ligne', `Le pont ${pontTopic} est hors ligne`);
    }

    const cle = `${pontTopic}/${idTopic}`;
    if (this.attentes.has(cle)) return this.repondreErreur(ref, 'requete_en_double', 'Identifiant déjà en cours de traitement');
    const timer = setTimeout(() => {
      this.attentes.delete(cle);
      this.repondreErreur(ref, 'delai_depasse', `Pas de réponse de ${pontTopic} dans le délai`);
    }, this.delaiReponseMs);
    timer.unref?.();
    this.attentes.set(cle, timer);

    this.eventBus.emitGeneric(PILOTES_EVENTS.REQUETE, { appId: connu.appId, requete });
  }

  // ---------------------------------------------------------------------------
  // Côté « agent » : une application (ia) demande au cœur d'envoyer une requête au nom de l'agent.
  // ---------------------------------------------------------------------------

  private noterMachine(machine: string, message: MqttMessage): void {
    try {
      const m = JSON.parse(message.payload.toString()) as { etat?: string };
      if (m.etat) this.machinesSite.set(machine, m.etat);
    } catch {
      /* illisible : ignoré */
    }
  }

  private noterPresence(pont: string, message: MqttMessage): void {
    if (message.payload.length === 0) {
      this.presencesSite.delete(pont);
      return;
    }
    try {
      this.presencesSite.set(pont, JSON.parse(message.payload.toString()) as PilotePresencePubliee);
    } catch {
      /* illisible : ignoré */
    }
  }

  /** Ponts du site : ceux des autres machines (présences MQTT) complétés par les nôtres (état courant). */
  pontsDuSite(): PontSite[] {
    const tous = new Map(this.presencesSite);
    for (const [pont, connu] of this.ponts) {
      tous.set(pont, { ...connu.presence, machine: this.options.machineId, appId: connu.appId, date: new Date(this.maintenant()).toISOString() });
    }
    return [...tous.values()]
      .sort((a, b) => a.pont.localeCompare(b.pont))
      .map((p) => ({ ...p, joignable: p.etat === 'en_ligne' && this.machinesSite.get(p.machine) !== 'hors_ligne' }));
  }

  private repondrePonts(ref: string): void {
    const evenement: PiloteAgentPontsEvenement = { ref, ponts: this.pontsDuSite() };
    this.eventBus.emitGeneric(PILOTES_EVENTS.AGENT_PONTS, evenement);
  }

  private surRequeteAgent(data: PiloteAgentRequeteEvenement): void {
    const ref = String(data?.ref ?? '');
    const erreur = (code: string, message: string): void => {
      this.eventBus.emitGeneric(PILOTES_EVENTS.AGENT_REPONSE, {
        ref,
        reponse: { id: ref, pont: String(data?.pont ?? ''), ok: false, erreur: { code, message } }
      });
    };
    if (!ref || !data.pont || typeof data.ordre !== 'string' || !estOrdreConnu(data.ordre)) {
      return erreur('requete_invalide', 'ref, pont et ordre connu obligatoires');
    }
    const id = `ag${Date.now().toString(36)}${(this.compteurAgent++).toString(36)}`;
    const requete: PiloteRequete = {
      id,
      pont: data.pont,
      ordre: data.ordre,
      parametres: data.parametres ?? {},
      ...(data.apercu ? { apercu: true } : {}),
      ...(data.jeton ? { jeton: data.jeton } : {}),
      emetteur: 'agent-ia',
      date: new Date(this.maintenant()).toISOString()
    };

    const cle = `${data.pont}/${id}`;
    const timer = setTimeout(() => {
      this.attentesAgent.delete(cle);
      erreur('delai_depasse', `Pas de réponse de ${data.pont} dans le délai`);
    }, this.delaiReponseMs + 5_000);
    timer.unref?.();
    this.attentesAgent.set(cle, { ref, timer });
    this.transport.publish(this.sujets.requete(data.pont, id), JSON.stringify(requete), 1, false);
  }

  private surReponseMqtt(pont: string, id: string, message: MqttMessage): void {
    const attente = this.attentesAgent.get(`${pont}/${id}`);
    if (!attente) return;
    clearTimeout(attente.timer);
    this.attentesAgent.delete(`${pont}/${id}`);
    try {
      const reponse = JSON.parse(message.payload.toString()) as PiloteReponse;
      this.eventBus.emitGeneric(PILOTES_EVENTS.AGENT_REPONSE, { ref: attente.ref, reponse });
    } catch {
      this.eventBus.emitGeneric(PILOTES_EVENTS.AGENT_REPONSE, { ref: attente.ref, reponse: { id, pont, ok: false, erreur: { code: 'reponse_illisible', message: 'Réponse non JSON' } } });
    }
  }
}
