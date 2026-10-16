/**
 * RfxcomPilote — gestion des devices, récepteurs et scènes RFXCOM par l'agent IA
 * (conception-gestion-pilotes_specs v1.3, étape 3).
 *
 * Implémente le `PiloteGestionnaire` du canal « pilotes » du cœur au-dessus de `DeviceManager`, `ReceiverManager` et
 * `SceneManager` : lister, decouverts, adopter, creer, modifier, remplacer, effacer, ignorer, supprimer, redemarrer.
 *
 * Règles (conception §5, §6, §7.2, §8) :
 * - un découvert n'a PAS d'entité HA ; on ne l'adopte qu'avec une qualification complète (lieu obligatoire ; le QUOI
 *   est prérempli depuis le type : « Bouton », « Température »…) ;
 * - un récepteur a un émetteur principal pris parmi les devices ADOPTÉS ; ses émetteurs associés aussi ;
 * - `remplacer` (un device) = suppression de l'ancien (retrait HA), puis ajout du neuf au MÊME nommage, et le neuf
 *   remplace l'ancien PARTOUT (émetteur principal et émetteurs associés des récepteurs) ; l'appairage physique du module
 *   avec le nouvel émetteur se fait hors dimotic-ha ;
 * - `supprimer` refuse une ressource encore utilisée (device cité par un récepteur, récepteur cité par une scène) ;
 * - `effacer` / `ignorer` ne touchent que la mémoire / la liste d'exclusion, jamais HA ;
 * - sauvegarde horodatée du fichier avant toute écriture.
 */

import { composerNom, decomposerNom, type PiloteGestionnaire } from '../../../core/dist/exports';
import { receiverConfigSchema } from './devices-config-schema';
import { getDefaultComponent } from './classification';
import { DeviceManager } from './devices/DeviceManager';
import { extractTaxonomy, buildDisplayName } from './taxonomy';
import type { ReceiverConfig, ReceiverSceneConfig, RfxComDeviceInfo, RfxComDiscoveredDevice } from './types';

/** Ce que l'hôte (RfxComService) met à disposition du pilote. */
export interface RfxcomPiloteHote {
  devices(): RfxComDeviceInfo[];
  decouverts(): RfxComDiscoveredDevice[];
  ignores(): string[];
  /** Récepteurs commandables (switch, light, cover), états mémorisés retirés. */
  recepteurs(): ReceiverConfig[];
  scenes(): ReceiverSceneConfig[];
  /** Copie horodatée du fichier de configuration ; renvoie son chemin (undefined si le fichier n'existe pas). */
  sauvegarder(): string | undefined;
  persister(): void;
  rafraichir(): void;
  /** Retrait complet : entité HA (si transmise) puis registre. */
  /** Attend que HA ait supprimé les entités de ces noms (suppression AVANT création : sinon HA suffixe `_2`). */
  attendreRetraitHa(noms: string[]): Promise<{ absent: boolean; attenteMs: number; restantes: string[] }>;
  retirerDevice(id: string): void;
  retirerRecepteur(id: string): void;
  retirerScene(id: string): void;
  /** Ajout ou remplacement tel quel dans le registre (sans toucher à HA). */
  definirDevice(device: RfxComDeviceInfo): void;
  definirRecepteur(config: ReceiverConfig): void;
  definirScene(config: ReceiverSceneConfig): void;
  /** Publie la découverte HA (appelé seulement si transmitToHa). */
  publierDevice(id: string): void;
  publierRecepteur(id: string): void;
  publierScene(id: string): void;
  ignorer(id: string): void;
  oublier(ids: string[]): void;
  /** Relit le fichier de configuration et republie ; renvoie [devices, récepteurs, scènes]. */
  relire(): [number, number, number];
  /** Horodatage servant d'identifiant à un récepteur ou une scène créés. */
  horodatage(): number;
}

type Operation =
  | { op: 'retirer-device'; id: string }
  | { op: 'retirer-recepteur'; id: string }
  | { op: 'retirer-scene'; id: string }
  | { op: 'definir-device'; device: RfxComDeviceInfo }
  | { op: 'definir-recepteur'; config: ReceiverConfig }
  | { op: 'definir-scene'; config: ReceiverSceneConfig }
  | { op: 'ignorer'; id: string }
  | { op: 'oublier'; ids: string[] }
  | { op: 'relire' };

interface Plan {
  apercu: Record<string, unknown>;
  operations: Operation[];
}

type Genre = 'device' | 'recepteur' | 'scene';

const ACTIONS = ['toggle', 'on', 'off', 'set_level', 'open', 'close', 'stop'];

export class RfxcomPilote implements PiloteGestionnaire {
  constructor(private readonly hote: RfxcomPiloteHote) {}

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  async lire(ordre: 'lister' | 'decouverts', parametres: Record<string, unknown> = {}): Promise<unknown> {
    const h = this.hote;
    if (ordre === 'decouverts') {
      return {
        decouverts: h.decouverts().map((d) => ({
          id: d.uniqueId,
          type: d.type,
          sousType: d.subType,
          sensorId: d.sensorId,
          unitCode: d.unitCode ?? null,
          quoiParDefaut: d.defaultQuoi,
          vuLe: d.detectedAt
        })),
        ignores: h.ignores()
      };
    }
    const ressource = typeof parametres.ressource === 'string' ? parametres.ressource : undefined;
    const tout = !ressource;
    return {
      ...(tout || ressource === 'devices' ? {
        devices: h.devices().map((d) => ({
          id: d.uniqueId,
          type: d.type,
          sousType: d.subType,
          nom: d.name,
          transmitToHa: d.transmitToHa,
          derniereValeur: d.lastValue ?? null,
          vuLe: d.lastSeen ?? null
        }))
      } : {}),
      ...(tout || ressource === 'recepteurs' ? {
        recepteurs: h.recepteurs().map((r) => this.decrireRecepteur(r))
      } : {}),
      ...(tout || ressource === 'scenes' ? {
        scenes: h.scenes().map((s) => ({
          id: s.receiverId,
          nom: s.name,
          transmitToHa: s.transmitToHa,
          sceneType: s.sceneType,
          delaiEntreCommandesMs: s.delayBetweenCommands ?? 500,
          actions: s.actions
        }))
      } : {}),
      ignores: h.ignores()
    };
  }

  private decrireRecepteur(r: ReceiverConfig): Record<string, unknown> {
    if (r.type === 'scene') return { id: r.receiverId, type: 'scene', nom: r.name };
    return {
      id: r.receiverId,
      type: r.type,
      nom: r.name,
      transmitToHa: r.transmitToHa,
      emetteurPrincipal: r.primaryEmitter,
      emetteurs: r.emitters,
      ...(r.type === 'light' ? { variable: r.isDimmable, niveauParDefaut: r.defaultLevel ?? null } : {}),
      ...(r.type === 'cover' ? { coverType: r.coverType, ouvertureSec: r.openTimeSec, fermetureSec: r.closeTimeSec } : {})
    };
  }

  // ---------------------------------------------------------------------------
  // Ordres modifiants
  // ---------------------------------------------------------------------------

  async preparer(ordre: string, parametres: Record<string, unknown>): Promise<{ apercu: unknown; etat: unknown }> {
    const plan = this.planifier(ordre, parametres);
    const h = this.hote;
    const etat = {
      devices: h.devices().map((d) => [d.uniqueId, d.name, d.transmitToHa]),
      recepteurs: h.recepteurs().map((r) => JSON.stringify(r)),
      scenes: h.scenes().map((s) => JSON.stringify(s)),
      decouverts: h.decouverts().map((d) => d.uniqueId).sort(),
      ignores: h.ignores()
    };
    return { apercu: plan.apercu, etat };
  }

  async appliquer(ordre: string, parametres: Record<string, unknown>): Promise<{ resultat?: unknown; sauvegarde?: string }> {
    const plan = this.planifier(ordre, parametres);
    const h = this.hote;
    const modifieFichier = plan.operations.some((o) => o.op !== 'oublier' && o.op !== 'relire');
    const sauvegarde = modifieFichier ? h.sauvegarder() : undefined;

    // 1. Retraits d'abord (libèrent l'entity_id côté HA avant tout ajout — remplacement, modification).
    const nomsRetires: string[] = [];
    for (const o of plan.operations) {
      if (o.op === 'retirer-device') {
        const d = h.devices().find((x) => x.uniqueId === o.id);
        if (d?.transmitToHa) nomsRetires.push(d.name);
        h.retirerDevice(o.id);
      }
      if (o.op === 'retirer-recepteur') {
        const r = h.recepteurs().find((x) => x.receiverId === o.id);
        if (r?.transmitToHa) nomsRetires.push(r.name);
        h.retirerRecepteur(o.id);
      }
      if (o.op === 'retirer-scene') {
        const sc = h.scenes().find((x) => x.receiverId === o.id);
        if (sc?.transmitToHa) nomsRetires.push(sc.name);
        h.retirerScene(o.id);
      }
    }
    // 1bis. Une création suit : on ATTEND que HA ait réellement supprimé l'ancienne entité (sinon le nom serait pris et HA suffixerait `_2`).
    let attenteHa: { absent: boolean; attenteMs: number; restantes: string[] } | undefined;
    const creeDansHa = plan.operations.some(
      (o) => (o.op === 'definir-device' && o.device.transmitToHa) || ((o.op === 'definir-recepteur' || o.op === 'definir-scene') && o.config.transmitToHa)
    );
    if (nomsRetires.length && creeDansHa) attenteHa = await h.attendreRetraitHa(nomsRetires);
    // 2. Définitions (devices avant récepteurs, récepteurs avant scènes).
    const aPublier: Array<{ genre: Genre; id: string }> = [];
    for (const o of plan.operations) {
      if (o.op === 'definir-device') {
        h.definirDevice(o.device);
        if (o.device.transmitToHa) aPublier.push({ genre: 'device', id: o.device.uniqueId });
      }
    }
    for (const o of plan.operations) {
      if (o.op === 'definir-recepteur') {
        h.definirRecepteur(o.config);
        if (o.config.transmitToHa) aPublier.push({ genre: 'recepteur', id: o.config.receiverId });
      }
    }
    for (const o of plan.operations) {
      if (o.op === 'definir-scene') {
        h.definirScene(o.config);
        if (o.config.transmitToHa) aPublier.push({ genre: 'scene', id: o.config.receiverId });
      }
    }
    for (const o of plan.operations) {
      if (o.op === 'ignorer') h.ignorer(o.id);
      if (o.op === 'oublier') h.oublier(o.ids);
    }

    let relus: [number, number, number] | undefined;
    if (plan.operations.some((o) => o.op === 'relire')) relus = h.relire();
    if (modifieFichier) h.persister();
    for (const p of aPublier) {
      if (p.genre === 'device') h.publierDevice(p.id);
      else if (p.genre === 'recepteur') h.publierRecepteur(p.id);
      else h.publierScene(p.id);
    }
    h.rafraichir();

    const creations = plan.operations
      .filter((o): o is Extract<Operation, { op: 'definir-recepteur' | 'definir-scene' }> => o.op === 'definir-recepteur' || o.op === 'definir-scene')
      .map((o) => o.config.receiverId);
    return {
      resultat: {
        ...(creations.length ? { identifiants: creations } : {}),
        ...(attenteHa ? { attenteSuppressionHa: attenteHa.absent ? `faite en ${attenteHa.attenteMs} ms` : `NON confirmée après ${attenteHa.attenteMs} ms (restent : ${attenteHa.restantes.join(', ') || 'inconnu'}) : vérifier dans HA` } : {}),
        devices: h.devices().length,
        recepteurs: h.recepteurs().length,
        scenes: h.scenes().length,
        decouverts: h.decouverts().length,
        ...(relus ? { relus: { devices: relus[0], recepteurs: relus[1], scenes: relus[2] } } : {})
      },
      sauvegarde
    };
  }

  // ---------------------------------------------------------------------------
  // Planification (aucun effet de bord : sert à l'aperçu ET à l'application)
  // ---------------------------------------------------------------------------

  private planifier(ordre: string, p: Record<string, unknown>): Plan {
    switch (ordre) {
      case 'adopter': return this.planAdopter(p);
      case 'creer': return this.planCreer(p);
      case 'modifier': return this.planModifier(p);
      case 'supprimer': return this.planSupprimer(p);
      case 'remplacer': return this.planRemplacer(p);
      case 'effacer': return this.planEffacer(p);
      case 'ignorer': return this.planIgnorer(p);
      case 'redemarrer':
        return { apercu: { action: 'relit le fichier de configuration (devices, récepteurs, scènes) et republie les découvertes ; le transceiver n\'est pas touché' }, operations: [{ op: 'relire' }] };
      default:
        throw new Error(`Ordre « ${ordre} » non géré par le pilote RFXCOM`);
    }
  }

  private genreDe(id: string): Genre | undefined {
    const h = this.hote;
    if (h.devices().some((d) => d.uniqueId === id)) return 'device';
    if (h.recepteurs().some((r) => r.receiverId === id)) return 'recepteur';
    if (h.scenes().some((s) => s.receiverId === id)) return 'scene';
    return undefined;
  }

  private device(id: string): RfxComDeviceInfo | undefined {
    return this.hote.devices().find((d) => d.uniqueId === id);
  }

  private recepteur(id: string): Exclude<ReceiverConfig, ReceiverSceneConfig> | undefined {
    const r = this.hote.recepteurs().find((x) => x.receiverId === id);
    return r && r.type !== 'scene' ? r : undefined;
  }

  /**
   * Nom complet `quoi---lieuPrécis--lieu--lieuPère--lieuGrandPère` (nommage_specs §3.3, fonction commune du cœur) ; refuse une
   * qualification incomplète. `quoiParDefaut` : QUOI proposé par le type (« Bouton »…) ; `actuel` : nom dont `p` ne change
   * que certaines parties (modifier).
   */
  private composerNom(p: Record<string, unknown>, quoiParDefaut?: string, actuel?: string): string {
    const defauts = actuel ? decomposerNom(actuel) : quoiParDefaut ? { quoi: quoiParDefaut, lieu: '' } : undefined;
    const nom = composerNom(p, defauts);
    const t = extractTaxonomy(nom);
    if (!t.rawQuoi || !t.nomLieu) throw new Error(`Nom « ${nom} » invalide`);
    return nom;
  }

  private qualifie(p: Record<string, unknown>): boolean {
    return ['quoi', 'lieu', 'lieuPrecis', 'lieuPere', 'lieuGrandPere'].some((k) => p[k] !== undefined);
  }

  /** Reprend les parties du nom actuel que `p` ne change pas. */
  private recomposerNom(actuel: string, p: Record<string, unknown>): string {
    return this.composerNom(p, undefined, actuel);
  }

  private decrireHa(nom: string, transmit: boolean, avant?: 'supprimee' | 'recreee'): string {
    if (!transmit) return 'aucune entité dans HA (transmitToHa faux)';
    const affiche = buildDisplayName(extractTaxonomy(nom));
    const verbe = avant === 'supprimee' ? 'supprimée de' : avant === 'recreee' ? 'supprimée puis recréée dans' : 'créée dans';
    return `entité « ${affiche} » ${verbe} HA`;
  }

  // --- adopter ---------------------------------------------------------------

  private planAdopter(p: Record<string, unknown>): Plan {
    const id = String(p.id ?? '');
    const d = this.hote.decouverts().find((x) => x.uniqueId === id);
    if (!d) throw new Error(`« ${id} » n'est pas dans les découverts (ordre decouverts pour la liste)`);
    if (this.device(id)) throw new Error(`« ${id} » est déjà adopté`);
    const nom = this.composerNom(p, d.defaultQuoi);
    const transmit = p.transmitToHa === true;
    const device: RfxComDeviceInfo = {
      uniqueId: d.uniqueId,
      sensorId: d.sensorId,
      type: d.type,
      subType: d.subType,
      protocole: d.uniqueId.split('_')[0],
      name: nom,
      defaultQuoi: d.defaultQuoi,
      transmitToHa: transmit,
      unitCode: d.unitCode
    };
    return {
      apercu: { adopte: { id, type: d.type, sousType: d.subType, nom, transmitToHa: transmit }, entiteHa: this.decrireHa(nom, transmit) },
      operations: [{ op: 'definir-device', device }]
    };
  }

  // --- creer -----------------------------------------------------------------

  private planCreer(p: Record<string, unknown>): Plan {
    const ressource = String(p.ressource ?? '');
    if (ressource === 'recepteur') return this.planCreerRecepteur(p);
    if (ressource === 'scene') return this.planCreerScene(p);
    if (ressource === 'device') return this.planCreerDevice(p);
    throw new Error('« ressource » doit être « recepteur », « scene » ou « device » (device : volet Somfy RFY créé à la main)');
  }

  private planCreerDevice(p: Record<string, unknown>): Plan {
    const sensorId = String(p.sensorId ?? '').trim();
    const unitCode = Number(p.unitCode);
    const subType = String(p.subType ?? 'RFY').trim();
    if (!sensorId) throw new Error('« sensorId » est obligatoire (adresse du volet Somfy)');
    if (!Number.isInteger(unitCode)) throw new Error('« unitCode » (entier) est obligatoire');
    const nom = this.composerNom(p, 'Volet');
    const device = DeviceManager.buildManualDevice({ sensorId, type: 'Rfy', subType, protocole: 'rfy', unitCode, name: nom });
    device.transmitToHa = p.transmitToHa === true;
    if (this.device(device.uniqueId)) throw new Error(`« ${device.uniqueId} » existe déjà`);
    return {
      apercu: { cree: { id: device.uniqueId, type: 'Rfy', nom, transmitToHa: device.transmitToHa }, entiteHa: this.decrireHa(nom, device.transmitToHa), rappel: 'l\'appairage physique du volet avec dimotic-ha se fait hors dimotic-ha' },
      operations: [{ op: 'definir-device', device }]
    };
  }

  private emetteursDe(p: Record<string, unknown>): Array<{ emitterId: string; action: string; value?: number; followReceivedSignal?: boolean }> {
    const liste = p.emetteurs ?? p.emitters ?? [];
    if (!Array.isArray(liste)) throw new Error('« emetteurs » doit être une liste');
    return liste.map((e) => {
      const o = e as Record<string, unknown>;
      const emitterId = String(o.emitterId ?? o.id ?? '');
      const action = String(o.action ?? '');
      if (!this.device(emitterId)) throw new Error(`Émetteur « ${emitterId} » inconnu : il doit d'abord être adopté (ordre adopter)`);
      if (!ACTIONS.includes(action)) throw new Error(`Action « ${action} » invalide pour l'émetteur ${emitterId} (${ACTIONS.join(', ')})`);
      return {
        emitterId,
        action,
        ...(o.value !== undefined ? { value: Number(o.value) } : {}),
        ...(o.followReceivedSignal !== undefined ? { followReceivedSignal: o.followReceivedSignal === true } : {})
      };
    });
  }

  private validerRecepteur(config: unknown): ReceiverConfig {
    const r = receiverConfigSchema.safeParse(config);
    if (!r.success) throw new Error(`Configuration invalide : ${r.error.errors.map((e) => `${e.path.join('.')} ${e.message}`).join('; ')}`);
    return r.data as ReceiverConfig;
  }

  private planCreerRecepteur(p: Record<string, unknown>): Plan {
    const type = String(p.type ?? '');
    if (!['switch', 'light', 'cover'].includes(type)) throw new Error('« type » doit être « switch », « light » ou « cover »');
    const nom = this.composerNom(p);
    const primaryEmitter = String(p.emetteurPrincipal ?? p.primaryEmitter ?? '');
    if (!primaryEmitter) throw new Error('« emetteurPrincipal » est obligatoire (un device déjà adopté)');
    if (!this.device(primaryEmitter)) throw new Error(`Émetteur principal « ${primaryEmitter} » inconnu : il doit d'abord être adopté (ordre adopter)`);
    const transmit = p.transmitToHa === true;
    const base = {
      type,
      receiverId: `recepteur_${this.hote.horodatage()}`,
      name: nom,
      primaryEmitter,
      emitters: this.emetteursDe(p),
      transmitToHa: transmit,
      ...(typeof p.icon === 'string' ? { icon: p.icon } : {})
    };
    let brut: Record<string, unknown> = base;
    if (type === 'light') {
      brut = { ...base, isDimmable: p.variable === true || p.isDimmable === true, ...(p.niveauParDefaut !== undefined || p.defaultLevel !== undefined ? { defaultLevel: Number(p.niveauParDefaut ?? p.defaultLevel) } : {}) };
    } else if (type === 'cover') {
      if (!p.coverType) throw new Error('« coverType » est obligatoire pour un volet (Curtain1, Blind1, RFY…)');
      brut = { ...base, coverType: p.coverType, openTimeSec: Number(p.ouvertureSec ?? p.openTimeSec), closeTimeSec: Number(p.fermetureSec ?? p.closeTimeSec) };
    }
    const config = this.validerRecepteur(brut);
    return {
      apercu: {
        cree: { ...this.decrireRecepteur(config), id: 'attribué à la création' },
        entiteHa: this.decrireHa(nom, transmit),
        rappel: 'sans appairage physique du module avec l\'émetteur principal, HA affichera l\'état mais le module ne bougera pas'
      },
      operations: [{ op: 'definir-recepteur', config }]
    };
  }

  private actionsDeScene(p: Record<string, unknown>): Array<{ target: string; command: string; value?: number; delayMs?: number }> {
    const liste = p.actions;
    if (!Array.isArray(liste) || liste.length === 0) throw new Error('« actions » est obligatoire (au moins une action {target, command})');
    return liste.map((a) => {
      const o = a as Record<string, unknown>;
      const target = String(o.target ?? o.cible ?? '');
      const command = String(o.command ?? o.commande ?? '');
      if (!this.recepteur(target)) throw new Error(`Cible « ${target} » inconnue : une scène agit sur des récepteurs existants`);
      if (!command) throw new Error(`Commande absente pour la cible ${target}`);
      return {
        target,
        command,
        ...(o.value !== undefined ? { value: Number(o.value) } : {}),
        ...(o.delayMs !== undefined ? { delayMs: Number(o.delayMs) } : {})
      };
    });
  }

  private planCreerScene(p: Record<string, unknown>): Plan {
    const nom = this.composerNom(p);
    const transmit = p.transmitToHa === true;
    const brut = {
      type: 'scene',
      receiverId: `scene_${this.hote.horodatage()}`,
      name: nom,
      transmitToHa: transmit,
      sceneType: p.sceneType === 'parallel' ? 'parallel' : 'sequential',
      delayBetweenCommands: p.delaiEntreCommandesMs !== undefined ? Number(p.delaiEntreCommandesMs) : 500,
      actions: this.actionsDeScene(p),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
      ...(typeof p.icon === 'string' ? { icon: p.icon } : {})
    };
    const config = this.validerRecepteur(brut) as ReceiverSceneConfig;
    return {
      apercu: { cree: { id: 'attribué à la création', type: 'scene', nom, sceneType: config.sceneType, actions: config.actions }, entiteHa: this.decrireHa(nom, transmit) },
      operations: [{ op: 'definir-scene', config }]
    };
  }

  // --- modifier --------------------------------------------------------------

  private planModifier(p: Record<string, unknown>): Plan {
    const id = String(p.id ?? '');
    const genre = this.genreDe(id);
    if (!genre) throw new Error(`Ressource « ${id} » inconnue`);
    if (genre === 'device') return this.planModifierDevice(id, p);
    if (genre === 'recepteur') return this.planModifierRecepteur(id, p);
    return this.planModifierScene(id, p);
  }

  private planModifierDevice(id: string, p: Record<string, unknown>): Plan {
    const d = this.device(id) as RfxComDeviceInfo;
    const nom = this.qualifie(p) ? this.recomposerNom(d.name, p) : d.name;
    const transmit = typeof p.transmitToHa === 'boolean' ? p.transmitToHa : d.transmitToHa;
    const ops: Operation[] = [];
    // « Une modification = une suppression puis un ajout » pour ce qui change le nom ou la présence dans HA.
    const refaire = d.transmitToHa && (nom !== d.name || !transmit);
    if (refaire) ops.push({ op: 'retirer-device', id });
    ops.push({ op: 'definir-device', device: { ...d, name: nom, transmitToHa: transmit } });
    return {
      apercu: { avant: { nom: d.name, transmitToHa: d.transmitToHa }, apres: { nom, transmitToHa: transmit }, entiteHa: refaire ? this.decrireHa(nom, transmit, 'recreee') : this.decrireHa(nom, transmit) },
      operations: ops
    };
  }

  private planModifierRecepteur(id: string, p: Record<string, unknown>): Plan {
    const r = this.recepteur(id) as Exclude<ReceiverConfig, ReceiverSceneConfig>;
    const nom = this.qualifie(p) ? this.recomposerNom(r.name, p) : r.name;
    const transmit = typeof p.transmitToHa === 'boolean' ? p.transmitToHa : r.transmitToHa;
    const type = typeof p.type === 'string' ? p.type : r.type;
    if (!['switch', 'light', 'cover'].includes(type)) throw new Error('« type » doit être « switch », « light » ou « cover »');
    const primaryEmitter = String(p.emetteurPrincipal ?? p.primaryEmitter ?? r.primaryEmitter);
    if (!this.device(primaryEmitter)) throw new Error(`Émetteur principal « ${primaryEmitter} » inconnu : il doit d'abord être adopté`);
    const emitters = p.emetteurs !== undefined || p.emitters !== undefined ? this.emetteursDe(p) : r.emitters;

    const { lastOn: _on, lastLevel: _level, lastPosition: _position, ...sansEtats } = r as typeof r & { lastOn?: boolean; lastLevel?: number; lastPosition?: number };
    const typeChange = type !== r.type;
    // Changer le TYPE = suppression puis recréation, sans les derniers états de l'ancien type (comme l'écran web).
    const brut: Record<string, unknown> = {
      ...(typeChange ? sansEtats : r),
      type,
      name: nom,
      primaryEmitter,
      emitters,
      transmitToHa: transmit
    };
    if (type === 'light') {
      if (p.variable !== undefined || p.isDimmable !== undefined) brut.isDimmable = p.variable === true || p.isDimmable === true;
      if (p.niveauParDefaut !== undefined || p.defaultLevel !== undefined) brut.defaultLevel = Number(p.niveauParDefaut ?? p.defaultLevel);
      brut.isDimmable = brut.isDimmable ?? false;
    }
    if (type === 'cover') {
      if (p.coverType !== undefined) brut.coverType = p.coverType;
      if (p.ouvertureSec !== undefined || p.openTimeSec !== undefined) brut.openTimeSec = Number(p.ouvertureSec ?? p.openTimeSec);
      if (p.fermetureSec !== undefined || p.closeTimeSec !== undefined) brut.closeTimeSec = Number(p.fermetureSec ?? p.closeTimeSec);
    }
    if (typeof p.icon === 'string') brut.icon = p.icon;
    const config = this.validerRecepteur(brut);

    const ops: Operation[] = [];
    const refaire = r.transmitToHa && (nom !== r.name || !transmit || typeChange);
    if (refaire || typeChange) ops.push({ op: 'retirer-recepteur', id });
    ops.push({ op: 'definir-recepteur', config });
    return {
      apercu: {
        avant: this.decrireRecepteur(r),
        apres: this.decrireRecepteur(config),
        entiteHa: refaire ? this.decrireHa(nom, transmit, 'recreee') : this.decrireHa(nom, transmit)
      },
      operations: ops
    };
  }

  private planModifierScene(id: string, p: Record<string, unknown>): Plan {
    const s = this.hote.scenes().find((x) => x.receiverId === id) as ReceiverSceneConfig;
    const nom = this.qualifie(p) ? this.recomposerNom(s.name, p) : s.name;
    const transmit = typeof p.transmitToHa === 'boolean' ? p.transmitToHa : s.transmitToHa;
    const brut: Record<string, unknown> = {
      ...s,
      name: nom,
      transmitToHa: transmit,
      ...(p.sceneType === 'parallel' || p.sceneType === 'sequential' ? { sceneType: p.sceneType } : {}),
      ...(p.delaiEntreCommandesMs !== undefined ? { delayBetweenCommands: Number(p.delaiEntreCommandesMs) } : {}),
      ...(p.actions !== undefined ? { actions: this.actionsDeScene(p) } : {}),
      ...(typeof p.description === 'string' ? { description: p.description } : {})
    };
    const config = this.validerRecepteur(brut) as ReceiverSceneConfig;
    const ops: Operation[] = [];
    const refaire = s.transmitToHa && (nom !== s.name || !transmit);
    if (refaire) ops.push({ op: 'retirer-scene', id });
    ops.push({ op: 'definir-scene', config });
    return {
      apercu: { avant: { nom: s.name, transmitToHa: s.transmitToHa, actions: s.actions }, apres: { nom, transmitToHa: transmit, actions: config.actions }, entiteHa: refaire ? this.decrireHa(nom, transmit, 'recreee') : this.decrireHa(nom, transmit) },
      operations: ops
    };
  }

  // --- supprimer -------------------------------------------------------------

  private planSupprimer(p: Record<string, unknown>): Plan {
    const id = String(p.id ?? '');
    const genre = this.genreDe(id);
    if (!genre) throw new Error(`Ressource « ${id} » inconnue`);
    const h = this.hote;
    if (genre === 'device') {
      const d = this.device(id) as RfxComDeviceInfo;
      const utilisePar = h.recepteurs()
        .filter((r) => r.type !== 'scene' && (r.primaryEmitter === id || r.emitters.some((e) => e.emitterId === id)))
        .map((r) => `${r.receiverId} (${r.name})`);
      if (utilisePar.length) throw new Error(`« ${id} » est utilisé par : ${utilisePar.join(', ')} — le remplacer (ordre remplacer) ou modifier ces récepteurs d'abord`);
      return {
        apercu: { retire: { id, nom: d.name }, entiteHa: d.transmitToHa ? this.decrireHa(d.name, true, 'supprimee') + ' (messages vides retenus)' : 'aucune entité dans HA' },
        operations: [{ op: 'retirer-device', id }]
      };
    }
    if (genre === 'recepteur') {
      const r = this.recepteur(id) as Exclude<ReceiverConfig, ReceiverSceneConfig>;
      const utilisePar = h.scenes().filter((s) => s.actions.some((a) => a.target === id)).map((s) => `${s.receiverId} (${s.name})`);
      if (utilisePar.length) throw new Error(`« ${id} » est utilisé par les scènes : ${utilisePar.join(', ')} — les modifier d'abord`);
      return {
        apercu: { retire: { id, nom: r.name }, entiteHa: r.transmitToHa ? this.decrireHa(r.name, true, 'supprimee') + ' (messages vides retenus)' : 'aucune entité dans HA' },
        operations: [{ op: 'retirer-recepteur', id }]
      };
    }
    const s = h.scenes().find((x) => x.receiverId === id) as ReceiverSceneConfig;
    return {
      apercu: { retire: { id, nom: s.name }, entiteHa: s.transmitToHa ? this.decrireHa(s.name, true, 'supprimee') : 'aucune entité dans HA' },
      operations: [{ op: 'retirer-scene', id }]
    };
  }

  // --- remplacer (device) ----------------------------------------------------

  private planRemplacer(p: Record<string, unknown>): Plan {
    const ancienId = String(p.ancien ?? '');
    const nouveauId = String(p.nouveau ?? '');
    if (!ancienId || !nouveauId) throw new Error('« ancien » et « nouveau » (identifiants de devices) sont obligatoires');
    if (ancienId === nouveauId) throw new Error("L'ancien et le nouveau device sont identiques");
    const ancien = this.device(ancienId);
    if (!ancien) throw new Error(`Device à remplacer « ${ancienId} » inconnu (seuls les devices adoptés se remplacent)`);
    if (this.device(nouveauId)) throw new Error(`« ${nouveauId} » est déjà adopté`);
    const nouveau = this.hote.decouverts().find((d) => d.uniqueId === nouveauId);
    if (!nouveau) throw new Error(`Le device neuf « ${nouveauId} » n'est pas (encore) dans les découverts — l'actionner ou attendre sa prochaine émission`);
    const compAncien = getDefaultComponent(ancien.type, ancien.subType).component;
    const compNouveau = getDefaultComponent(nouveau.type, nouveau.subType).component;
    if (compAncien !== compNouveau) throw new Error(`Types incompatibles : l'ancien est un ${ancien.type}/${ancien.subType}, le neuf un ${nouveau.type}/${nouveau.subType}`);

    const neuf: RfxComDeviceInfo = {
      uniqueId: nouveau.uniqueId,
      sensorId: nouveau.sensorId,
      type: nouveau.type,
      subType: nouveau.subType,
      protocole: nouveau.uniqueId.split('_')[0],
      name: ancien.name,
      defaultQuoi: nouveau.defaultQuoi,
      transmitToHa: ancien.transmitToHa,
      unitCode: nouveau.unitCode
    };

    const operations: Operation[] = [];
    // Suppression d'abord (libère l'entity_id côté HA), ajout ensuite au même nommage.
    operations.push({ op: 'retirer-device', id: ancienId });
    operations.push({ op: 'definir-device', device: neuf });

    // Références : le neuf remplace l'ancien partout.
    const touches: string[] = [];
    for (const r of this.hote.recepteurs()) {
      if (r.type === 'scene') continue;
      const cite = r.primaryEmitter === ancienId || r.emitters.some((e) => e.emitterId === ancienId);
      if (!cite) continue;
      touches.push(`${r.receiverId} (${r.name})`);
      const emitters = r.emitters
        .map((e) => (e.emitterId === ancienId ? { ...e, emitterId: nouveauId } : e))
        .filter((e, i, tab) => tab.findIndex((x) => x.emitterId === e.emitterId) === i);
      operations.push({
        op: 'definir-recepteur',
        config: { ...r, primaryEmitter: r.primaryEmitter === ancienId ? nouveauId : r.primaryEmitter, emitters } as ReceiverConfig
      });
    }

    const memeProtocole = ancien.protocole === neuf.protocole;
    return {
      apercu: {
        etapes: [
          `1. supprimer ${ancienId}`,
          `2. ajouter ${nouveauId} avec le même nommage`,
          ...(touches.length ? [`3. remplacer l'émetteur dans : ${touches.join(', ')}`] : [])
        ],
        nommage: ancien.name,
        recepteursCorriges: touches,
        entiteHa: ancien.transmitToHa ? 'entité supprimée puis recréée avec le même nom, donc le même entity_id' : 'aucune entité dans HA',
        avertissements: [
          'l\'appairage PHYSIQUE du module (récepteur) avec le nouvel émetteur se fait hors dimotic-ha — le faire avant de compter sur ce bouton',
          ...(memeProtocole ? [] : [`le protocole change (${ancien.protocole} → ${neuf.protocole}) : vérifier que la commande des récepteurs reste possible`])
        ]
      },
      operations
    };
  }

  // --- effacer / ignorer -----------------------------------------------------

  private planEffacer(p: Record<string, unknown>): Plan {
    const visibles = this.hote.decouverts().map((d) => d.uniqueId);
    if (p.tout === true) {
      return { apercu: { efface: visibles, note: 'mémoire du pilote seulement ; ils réapparaissent s\'ils émettent à nouveau ; HA non touché' }, operations: [{ op: 'oublier', ids: visibles }] };
    }
    const id = String(p.id ?? '');
    if (!visibles.includes(id)) throw new Error(`« ${id} » n'est pas dans les découverts`);
    return { apercu: { efface: [id], note: 'mémoire du pilote seulement ; HA non touché' }, operations: [{ op: 'oublier', ids: [id] }] };
  }

  private planIgnorer(p: Record<string, unknown>): Plan {
    const id = String(p.id ?? '');
    if (!this.hote.decouverts().some((d) => d.uniqueId === id) && !this.hote.ignores().includes(id)) throw new Error(`« ${id} » n'est pas dans les découverts`);
    return { apercu: { ignore: id, note: 'ne sera plus jamais proposé ; HA non touché' }, operations: [{ op: 'ignorer', id }] };
  }
}
