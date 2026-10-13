/**
 * AssembleurService — assemble les appareils ESP en paquets et publie la demande à l'usine (fonctionnelles-esphome_specs §4, §4bis).
 *
 * Sur demande (bouton « Assembler » de la page, plus tard « Générer » de HA) : vérifie l'appareil (fiches, compatibilité, broches), fabrique
 * le paquet zip, le dépose dans `data/esps-assemble/machine_partage/paquets/<appareil>/r<révision>.zip` (servi en lecture seule par la route
 * du cœur), garde les N dernières révisions et publie le message conservé `dimotic/esphome/<site>/jobs/<appareil>`. Il dit quoi faire et où le
 * trouver ; il ne transporte pas les fichiers. Il écoute aussi l'état publié par l'usine et le poseur pour l'afficher.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MqttTransport, type IEventBus, type Logger, type IAppConfigProvider } from '../../../core/dist/exports';
import { assembleurConfigSchema, type AssembleurConfig } from './config-schema';
import { ASSEMBLEUR_CLIENT_EVENTS, ASSEMBLEUR_SOCKET_EVENTS } from './socket-events';
import { Bibliotheque } from './assembleur/fiches';
import { assemblerPaquet } from './assembleur/paquet';
import { genererFichiersPlans, PlanIntrouvable, type SourcePlans } from './plans/generer-fichiers';
import { SourcePlansHa, type ClientHa } from './plans/source-ha';

/** Transport MQTT minimal (MqttTransport du cœur en production, faux en test). */
export interface TransportMqtt {
  connect(): void;
  disconnect(): void;
  publish(topic: string, payload: string | Buffer, qos?: 0 | 1, retain?: boolean): void;
  subscribe(topic: string, qos?: 0 | 1): void;
  onMessage(cb: (m: { topic: string; payload: Buffer | string }) => void): void;
  onConnect(cb: () => void): void;
  getConnected(): boolean;
}
export type FabriqueTransport = (cfg: AssembleurConfig, clientId: string) => TransportMqtt;

export const fabriqueMqtt = (logger?: Logger): FabriqueTransport => (cfg, clientId) =>
  new MqttTransport(
    { host: cfg.mqtt.hote, port: cfg.mqtt.port, clientId, username: cfg.mqtt.utilisateur, password: cfg.mqtt.motDePasse, keepalive: 60, reconnectDelay: 10, clean: true, protocolVersion: 4 },
    logger
  ) as unknown as TransportMqtt;

export interface LigneAppareil {
  nom: string;
  nomAffichage: string;
  materiel: string;
  etat: 'pret' | 'refuse';
  erreurs: string[];
  avertissements: string[];
  derniereRevision: number | null;
  /** Dernier état publié par l'usine / le poseur (message `status`). */
  statut: { etat: string; detail: string; revision: number; at: string } | null;
  /** Demande en attente chez l'usine (message `jobs` conservé). */
  demandeEnAttente: { revision: number; action: string } | null;
}

export interface IAssembleurService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type ResultatDemande = { ok: true; revision: number; action: string; sha256: string; avertissements: string[] } | { ok: false; erreurs: string[] };

/** Fichiers `generes/…` factices : vérification de la fiche sans générer les pages de plans (qui demandent HA). */
class GeneresFactices extends Map<string, Buffer> {
  override get(cle: string): Buffer | undefined { return cle.startsWith('generes/') ? Buffer.from('{}\n') : super.get(cle); }
  override has(cle: string): boolean { return cle.startsWith('generes/') || super.has(cle); }
}

export class AssembleurService implements IAssembleurService {
  private config: AssembleurConfig;
  private transport: TransportMqtt | null = null;
  private readonly statuts = new Map<string, LigneAppareil['statut']>();
  private readonly demandes = new Map<string, { revision: number; action: string }>();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly configProvider: IAppConfigProvider<AssembleurConfig>,
    private readonly fabrique: FabriqueTransport = fabriqueMqtt(logger),
    /** Racine de l'application (contient `appareils/` et `bibliotheque/`). */
    private readonly racineApp: string = path.resolve(__dirname, '..', '..'),
    /** Dossier de données de l'application (`data/esps-assemble`). */
    private readonly dossierDonnees: string = path.join(process.env.PROJECT_ROOT || process.cwd(), 'data', 'esps-assemble'),
    private readonly port: number = Number(process.env.DIMOTIC_WEB_PORT) || 8087,
    private readonly maintenant: () => Date = () => new Date(),
    /** Liaison HA du cœur (export des plans) ; absente = les appareils à pages de plans sont refusés. */
    private readonly clientHa?: ClientHa,
    /** Source de plans de remplacement (tests, anciens plans HAPLAN). */
    private readonly sourcePlans?: SourcePlans
  ) {
    this.config = this.charger();
    this.eventBus.on(ASSEMBLEUR_CLIENT_EVENTS.GET_APPAREILS, () => this.emettreAppareils());
    this.eventBus.on(ASSEMBLEUR_CLIENT_EVENTS.ASSEMBLER, (d: unknown) => void this.demander(d as { appareil: string; action?: string }));
    this.eventBus.on(ASSEMBLEUR_CLIENT_EVENTS.ANNULER, (d: unknown) => this.annuler((d as { appareil: string }).appareil));
    this.eventBus.onGeneric<{ moduleId: string; success: boolean }>('app:module:config:saved', (e) => {
      if (e?.moduleId !== 'esps-assemble' || !e.success) return;
      this.configProvider.reload();
      this.config = this.charger();
      this.logger.info('AssembleurService', `Configuration rechargée — site ${this.config.site}, broker ${this.config.mqtt.hote}:${this.config.mqtt.port}`);
      this.arreterMqtt();
      this.demarrerMqtt();
      this.emettreAppareils();
    });
  }

  static create(eventBus: IEventBus, logger: Logger, configProvider: IAppConfigProvider<AssembleurConfig>, ...reste: ConstructorParameters<typeof AssembleurService> extends [any, any, any, ...infer R] ? R : never): AssembleurService {
    return new AssembleurService(eventBus, logger, configProvider, ...reste);
  }

  private charger(): AssembleurConfig {
    return assembleurConfigSchema.parse(this.configProvider.getAppConfig() as Partial<AssembleurConfig>);
  }

  async start(): Promise<void> {
    this.logger.info('AssembleurService', `Démarrage (site ${this.config.site})`);
    this.demarrerMqtt();
    this.emettreAppareils();
  }

  async stop(): Promise<void> {
    this.arreterMqtt();
  }

  // --- MQTT ----------------------------------------------------------------------------------------------------------

  private sujet = {
    job: (a: string) => `dimotic/esphome/${this.config.site}/jobs/${a}`,
    jobs: () => `dimotic/esphome/${this.config.site}/jobs/+`,
    status: () => `dimotic/esphome/${this.config.site}/status/+`,
    appareils: () => `dimotic/esps-assemble/${this.config.site}/appareils`,
    generer: () => `dimotic/esps-assemble/${this.config.site}/generer`
  };

  private demarrerMqtt(): void {
    const t = this.fabrique(this.config, `esps-assemble-${this.config.site}`);
    this.transport = t;
    t.onMessage((m) => this.recevoir(m.topic, m.payload));
    t.onConnect(() => { this.logger.info('AssembleurService', 'Connecté au broker MQTT du site'); this.publierListe(); this.emettreAppareils(); });
    t.subscribe(this.sujet.status(), 1);
    t.subscribe(this.sujet.jobs(), 1);
    t.subscribe(this.sujet.generer(), 1);
    t.connect();
  }

  private arreterMqtt(): void {
    this.transport?.disconnect();
    this.transport = null;
  }

  private recevoir(topic: string, charge: Buffer | string): void {
    const appareil = topic.split('/').pop() ?? '';
    const texte = charge.toString().trim();
    // Bouton « Générer » de HA (non conservé) : même effet que le bouton de la page.
    if (topic === this.sujet.generer()) {
      if (!texte) return;
      try {
        const d = JSON.parse(texte);
        void this.demander({ appareil: String(d.appareil ?? ''), action: d.action });
      } catch (e) {
        this.logger.warn('AssembleurService', `Demande « Générer » illisible : ${(e as Error).message}`);
      }
      return;
    }
    try {
      if (topic.includes('/status/')) {
        if (!texte) this.statuts.delete(appareil);
        else { const d = JSON.parse(texte); this.statuts.set(appareil, { etat: d.etat, detail: d.detail ?? '', revision: d.revision, at: d.at }); }
      } else if (topic.includes('/jobs/')) {
        if (!texte) this.demandes.delete(appareil);
        else { const d = JSON.parse(texte); this.demandes.set(appareil, { revision: d.revision, action: d.action }); }
      }
    } catch (e) {
      this.logger.warn('AssembleurService', `Message illisible sur ${topic} : ${(e as Error).message}`);
      return;
    }
    this.emettreAppareils();
  }

  /** Liste des appareils publiée pour le bouton « Générer » de HA (message conservé, conception §11.6). */
  private publierListe(): void {
    if (!this.transport) return;
    const biblio = new Bibliotheque(this.racineApp);
    const liste = biblio.appareils().map((n) => { try { const f = biblio.appareil(n); return { nom: n, nomAffichage: f.nomAffichage, pagesDePlans: f.plans.length > 0 }; } catch { return null; } }).filter(Boolean);
    this.transport.publish(this.sujet.appareils(), JSON.stringify({ v: 1, site: this.config.site, at: this.maintenant().toISOString(), appareils: liste }), 1, true);
  }

  // --- Révisions et paquets ---------------------------------------------------------------------------------------------

  private fichierRevisions(): string { return path.join(this.dossierDonnees, 'revisions.json'); }

  private revisions(): Record<string, number> {
    try { return JSON.parse(fs.readFileSync(this.fichierRevisions(), 'utf8')); } catch { return {}; }
  }

  private noterRevision(appareil: string, revision: number): void {
    const r = this.revisions();
    r[appareil] = revision;
    fs.mkdirSync(this.dossierDonnees, { recursive: true });
    const tmp = `${this.fichierRevisions()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r, null, 1));
    fs.renameSync(tmp, this.fichierRevisions());
  }

  adresse(): string {
    if (this.config.adresseJoignable) return this.config.adresseJoignable;
    const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
    return `${ip}:${this.port}`;
  }

  /** Garde les N dernières révisions du dossier de paquets d'un appareil. */
  private nettoyer(appareil: string): void {
    const dossier = path.join(this.dossierDonnees, 'machine_partage', 'paquets', appareil);
    if (!fs.existsSync(dossier)) return;
    const revs = fs.readdirSync(dossier).map((n) => /^r(\d+)\.zip$/.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => b - a);
    for (const r of revs.slice(this.config.revisionsGardees)) fs.rmSync(path.join(dossier, `r${r}.zip`), { force: true });
  }

  /** Assemble l'appareil et publie la demande. `action` : `firmware` (défaut) ou `amorce` (première carte, flash USB). */
  async demander(demande: { appareil: string; action?: string }): Promise<ResultatDemande> {
    const appareil = String(demande?.appareil ?? '');
    const action = demande?.action === 'amorce' ? 'amorce' : 'firmware';
    const fin = (r: ResultatDemande): ResultatDemande => { this.eventBus.emit(ASSEMBLEUR_SOCKET_EVENTS.RESULTAT, { appareil, action, ...r }); this.emettreAppareils(); return r; };
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(appareil)) return fin({ ok: false, erreurs: ['nom d\'appareil invalide'] });
    if (!this.transport || !this.transport.getConnected()) return fin({ ok: false, erreurs: ['pas de connexion au broker MQTT du site : la demande ne peut pas être publiée'] });

    // Pages de plans : générées à l'assemblage depuis les plans de HA (ou de la source de remplacement).
    let generes = new Map<string, Buffer>();
    const resumePlans: { plan: string; page: string; placees: number; hors: number }[] = [];
    try {
      const biblio = new Bibliotheque(this.racineApp);
      const fiche = biblio.appareil(appareil);
      if (fiche.plans.length > 0) {
        const ecran = biblio.materiel(fiche.materiel).ecran;
        if (!ecran) return fin({ ok: false, erreurs: [`l'appareil demande des pages de plans : le matériel ${fiche.materiel} n'a pas d'écran`] });
        const source = this.sourcePlans ?? (this.clientHa ? new SourcePlansHa(this.clientHa) : null);
        if (!source) return fin({ ok: false, erreurs: ['les plans viennent de Home Assistant et la liaison HA du cœur est indisponible'] });
        if (source instanceof SourcePlansHa) await source.preparer(fiche.plans);
        const g = await genererFichiersPlans(fiche.plans, source, { largeur: ecran.largeur, hauteur: ecran.hauteur });
        generes = g.fichiers;
        resumePlans.push(...g.resume);
      }
    } catch (e) {
      const message = e instanceof PlanIntrouvable ? e.message : `génération des pages de plans impossible : ${(e as Error).message}`;
      this.logger.warn('AssembleurService', `${appareil} : ${message}`);
      return fin({ ok: false, erreurs: [message] });
    }

    const revision = (this.revisions()[appareil] ?? 0) + 1;
    const r = assemblerPaquet(this.racineApp, appareil, revision, this.maintenant, generes);
    if (!r.ok) { this.logger.warn('AssembleurService', `Assemblage de ${appareil} refusé : ${r.erreurs.join(' ; ')}`); return fin({ ok: false, erreurs: r.erreurs }); }

    const dossier = path.join(this.dossierDonnees, 'machine_partage', 'paquets', appareil);
    fs.mkdirSync(dossier, { recursive: true });
    const fichier = path.join(dossier, `r${revision}.zip`);
    fs.writeFileSync(`${fichier}.tmp`, r.zip);
    fs.renameSync(`${fichier}.tmp`, fichier);
    this.noterRevision(appareil, revision);
    this.nettoyer(appareil);

    const adresse = this.adresse();
    this.transport.publish(this.sujet.job(appareil), JSON.stringify({
      v: 1, site: this.config.site, appareil, revision, at: this.maintenant().toISOString(), action,
      origine: adresse, paquet: `http://${adresse}/api/apps/esps-assemble/partage/paquets/${appareil}/r${revision}.zip`, sha256: r.sha256
    }), 1, true);
    const detail = resumePlans.length ? ` ; plans : ${resumePlans.map((p) => `${p.plan} (${p.placees} objets${p.hors ? `, ${p.hors} hors cadre` : ''})`).join(', ')}` : '';
    this.logger.info('AssembleurService', `Paquet de ${appareil} (révision ${revision}, ${action}) publié : ${r.zip.length} octets${detail}`);
    return fin({ ok: true, revision, action, sha256: r.sha256, avertissements: r.avertissements });
  }

  /** Annulation : message vide conservé sur le sujet de la demande. */
  annuler(appareil: string): boolean {
    if (!this.transport || !/^[a-z0-9][a-z0-9_-]*$/.test(String(appareil))) return false;
    this.transport.publish(this.sujet.job(appareil), '', 1, true);
    this.logger.info('AssembleurService', `Demande de ${appareil} annulée`);
    return true;
  }

  // --- État pour l'interface --------------------------------------------------------------------------------------------

  lignes(): LigneAppareil[] {
    const biblio = new Bibliotheque(this.racineApp);
    const revisions = this.revisions();
    return biblio.appareils().map((nom) => {
      let nomAffichage = nom, materiel = '?';
      try { const f = biblio.appareil(nom); nomAffichage = f.nomAffichage; materiel = f.materiel; } catch { /* la vérification ci-dessous le dira */ }
      // Les pages de plans sont générées à l'assemblage : pour la simple vérification, des fichiers factices les remplacent.
      const v = assemblerPaquet(this.racineApp, nom, 0, this.maintenant, new GeneresFactices());
      return {
        nom, nomAffichage, materiel,
        etat: v.ok ? 'pret' as const : 'refuse' as const,
        erreurs: v.ok ? [] : v.erreurs,
        avertissements: v.avertissements,
        derniereRevision: revisions[nom] ?? null,
        statut: this.statuts.get(nom) ?? null,
        demandeEnAttente: this.demandes.get(nom) ?? null
      };
    });
  }

  private emettreAppareils(): void {
    try {
      this.eventBus.emit(ASSEMBLEUR_SOCKET_EVENTS.APPAREILS, { site: this.config.site, connecte: !!this.transport?.getConnected(), appareils: this.lignes() });
    } catch (e) {
      this.eventBus.emit(ASSEMBLEUR_SOCKET_EVENTS.ERROR, { message: `Lecture de la bibliothèque impossible : ${(e as Error).message}` });
    }
  }
}
