/**
 * ArexxPilote — gestion des capteurs AREXX par l'agent IA (conception-gestion-pilotes_specs v1.2, étape 2).
 *
 * Implémente le `PiloteGestionnaire` du canal « pilotes » du cœur au-dessus du `SensorRegistry` : lister, découverts,
 * adopter, modifier, remplacer, effacer, ignorer, supprimer, redémarrer (relecture du fichier des capteurs).
 *
 * Règles (conception §5, §6, §7.2) :
 * - un découvert n'a PAS d'entité HA ; on ne l'adopte qu'avec une qualification complète (quoi + lieu, lieu précis facultatif) ;
 * - `remplacer` = suppression de l'ancien (retrait HA), PUIS ajout du neuf avec le MÊME nommage (le numéro n'est pas
 *   dans le nom HA : l'entity_id est retrouvé) ; un capteur physique a une température (`arexx_<n>`) ET parfois une
 *   humidité (`arexx_<n>_rh`) : les deux suivent ;
 * - `effacer` / `ignorer` ne touchent que la mémoire / la liste d'exclusion du pilote, jamais HA ;
 * - sauvegarde horodatée du fichier avant toute écriture.
 */

import { composerNom, decomposerNom, type PiloteGestionnaire } from '../../../core/dist/exports';
import { SensorRegistry } from './SensorRegistry';
import type { ArexxSensorInfo } from './types';
import { buildDisplayName, extractTaxonomy } from './taxonomy';

/** Ce que l'hôte (ArexxService) met à disposition du pilote. */
export interface ArexxPiloteHote {
  registry: SensorRegistry;
  /** Copie horodatée du fichier des capteurs ; renvoie son chemin (undefined si le fichier n'existe pas). */
  sauvegarder(): string | undefined;
  /** Écrit le registre dans le fichier. */
  persister(): void;
  publierDecouverte(capteur: ArexxSensorInfo): void;
  /** Retire l'entité de HA : messages vides retenus (découverte, attributs, état). */
  retirerDecouverte(uniqueId: string): void;
  rafraichir(): void;
  /** Attend que HA ait supprimé les entités de ces noms (suppression AVANT création : sinon HA suffixe `_2`). */
  attendreRetraitHa(noms: string[]): Promise<{ absent: boolean; attenteMs: number; restantes: string[] }>;
  /** Relit le fichier des capteurs et republie ; renvoie le nombre de capteurs chargés. */
  relire(): number;
}

type Operation =
  | { op: 'retirer-ha'; id: string }
  | { op: 'supprimer'; id: string }
  | { op: 'definir'; id: string; kind: ArexxSensorInfo['kind']; nom: string; transmitToHa: boolean }
  | { op: 'ignorer'; id: string }
  | { op: 'oublier'; ids: string[] }
  | { op: 'relire' };

interface Plan {
  apercu: Record<string, unknown>;
  operations: Operation[];
}

/** « 8962 », « arexx_8962 » ou « arexx_8962_rh » → numéro brut « 8962 ». */
export function numeroBrut(valeur: unknown): string {
  return String(valeur ?? '').trim().replace(/^arexx_/, '').replace(/_rh$/, '');
}

const idTemperature = (brut: string): string => `arexx_${brut}`;
const idHumidite = (brut: string): string => `arexx_${brut}_rh`;

export class ArexxPilote implements PiloteGestionnaire {
  constructor(private readonly hote: ArexxPiloteHote) {}

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  async lire(ordre: 'lister' | 'decouverts'): Promise<unknown> {
    const reg = this.hote.registry;
    if (ordre === 'lister') {
      return {
        capteurs: reg.getConfiguredSensors().map((c) => ({
          id: c.uniqueId,
          numero: numeroBrut(c.uniqueId),
          type: c.kind,
          nom: c.name,
          transmitToHa: c.transmitToHa,
          derniereValeur: c.lastValue ?? null,
          vuLe: c.lastSeen ?? null
        })),
        ignores: reg.getIgnored()
      };
    }
    return {
      decouverts: reg.getDiscoveredSensors().map((d) => ({
        id: d.uniqueId,
        numero: numeroBrut(d.uniqueId),
        type: d.kind,
        derniereValeur: d.lastValue ?? null,
        signalDbm: d.signalDbm ?? null,
        vuLe: d.detectedAt
      })),
      ignores: reg.getIgnored()
    };
  }

  // ---------------------------------------------------------------------------
  // Ordres modifiants
  // ---------------------------------------------------------------------------

  async preparer(ordre: string, parametres: Record<string, unknown>): Promise<{ apercu: unknown; etat: unknown }> {
    const plan = this.planifier(ordre, parametres);
    const reg = this.hote.registry;
    const etat = {
      capteurs: reg.getConfiguredSensors().map((c) => [c.uniqueId, c.name, c.transmitToHa]),
      decouverts: reg.getDiscoveredSensors().map((d) => d.uniqueId).sort(),
      ignores: reg.getIgnored().sort()
    };
    return { apercu: plan.apercu, etat };
  }

  async appliquer(ordre: string, parametres: Record<string, unknown>): Promise<{ resultat?: unknown; sauvegarde?: string }> {
    const plan = this.planifier(ordre, parametres);
    const modifieFichier = plan.operations.some((o) => o.op !== 'oublier' && o.op !== 'relire');
    const sauvegarde = modifieFichier ? this.hote.sauvegarder() : undefined;
    const reg = this.hote.registry;
    const aPublier: string[] = [];

    // 1. Retraits HA d'abord (libère l'entity_id avant l'ajout éventuel — remplacement).
    const nomsRetires: string[] = [];
    for (const o of plan.operations) {
      if (o.op !== 'retirer-ha') continue;
      const c = reg.getSensor(o.id);
      if (c) nomsRetires.push(c.name);
      this.hote.retirerDecouverte(o.id);
    }
    // 1bis. Une création suit : on ATTEND que HA ait réellement supprimé l'ancienne entité (sinon le nom serait pris et HA suffixerait `_2`).
    let attenteHa: { absent: boolean; attenteMs: number; restantes: string[] } | undefined;
    if (nomsRetires.length && plan.operations.some((o) => o.op === 'definir' && o.transmitToHa)) {
      attenteHa = await this.hote.attendreRetraitHa(nomsRetires);
    }
    // 2. Suppressions, puis définitions.
    for (const o of plan.operations) if (o.op === 'supprimer') reg.deleteSensor(o.id);
    for (const o of plan.operations) {
      if (o.op === 'definir') {
        reg.setSensorName(o.id, o.nom);
        reg.setTransmitToHa(o.id, o.transmitToHa);
        if (o.transmitToHa) aPublier.push(o.id);
      }
    }
    for (const o of plan.operations) {
      if (o.op === 'ignorer') reg.ignore(o.id);
      if (o.op === 'oublier') for (const id of o.ids) reg.forgetDiscovered(id);
    }

    let chargés: number | undefined;
    if (plan.operations.some((o) => o.op === 'relire')) chargés = this.hote.relire();
    if (modifieFichier) this.hote.persister();
    for (const id of aPublier) {
      const capteur = reg.getSensor(id);
      if (capteur) this.hote.publierDecouverte(capteur);
    }
    this.hote.rafraichir();
    return { resultat: { ...(plan.apercu.resultat as Record<string, unknown> | undefined), ...(attenteHa ? { attenteSuppressionHa: attenteHa.absent ? `faite en ${attenteHa.attenteMs} ms` : `NON confirmée après ${attenteHa.attenteMs} ms (restent : ${attenteHa.restantes.join(', ') || 'inconnu'}) : vérifier dans HA`} : {}), capteurs: reg.getConfiguredSensors().length, decouverts: reg.getDiscoveredSensors().length, ...(chargés !== undefined ? { relus: chargés } : {}) }, sauvegarde };
  }

  // ---------------------------------------------------------------------------
  // Planification (aucun effet de bord : sert à l'aperçu ET à l'application)
  // ---------------------------------------------------------------------------

  private planifier(ordre: string, p: Record<string, unknown>): Plan {
    switch (ordre) {
      case 'adopter': return this.planAdopter(p);
      case 'modifier': return this.planModifier(p);
      case 'supprimer': return this.planSupprimer(p);
      case 'remplacer': return this.planRemplacer(p);
      case 'effacer': return this.planEffacer(p);
      case 'ignorer': return this.planIgnorer(p);
      case 'redemarrer':
        return { apercu: { action: 'relit le fichier des capteurs, republie les découvertes (l\'acquisition n\'est pas interrompue)' }, operations: [{ op: 'relire' }] };
      default:
        throw new Error(`Ordre « ${ordre} » non géré par le pilote AREXX`);
    }
  }

  /**
   * Nom complet `quoi---lieuPrécis--lieu--lieuPère--lieuGrandPère` (nommage_specs §3.3, fonction commune du cœur) ; refuse une
   * qualification incomplète. `defauts` : parties reprises du nom actuel quand `p` ne les change pas (modifier).
   */
  private composerNom(p: Record<string, unknown>, defauts?: string): string {
    const nom = composerNom(p, defauts ? decomposerNom(defauts) : undefined);
    const t = extractTaxonomy(nom);
    if (!t.rawQuoi || !t.nomLieu) throw new Error(`Nom « ${nom} » invalide`);
    return nom;
  }

  private decrireHa(nom: string, transmit: boolean, avant?: 'creee' | 'supprimee' | 'recreee'): string {
    const affiche = buildDisplayName(extractTaxonomy(nom));
    if (!transmit) return 'aucune entité dans HA (transmitToHa faux)';
    const verbe = avant === 'supprimee' ? 'supprimée de' : avant === 'recreee' ? 'supprimée puis recréée dans' : 'créée dans';
    return `entité « ${affiche} » ${verbe} HA`;
  }

  private planAdopter(p: Record<string, unknown>): Plan {
    const id = String(p.id ?? '');
    const reg = this.hote.registry;
    const d = reg.getDiscovered(id);
    if (!d) throw new Error(`« ${id} » n'est pas dans les découverts (ordre decouverts pour la liste)`);
    if (reg.getSensor(id)) throw new Error(`« ${id} » est déjà adopté`);
    const nom = this.composerNom(p);
    const transmit = p.transmitToHa === true;
    return {
      apercu: { adopte: { id, type: d.kind, nom, transmitToHa: transmit }, entiteHa: this.decrireHa(nom, transmit) },
      operations: [{ op: 'definir', id, kind: d.kind, nom, transmitToHa: transmit }]
    };
  }

  private planModifier(p: Record<string, unknown>): Plan {
    const id = String(p.id ?? '');
    const reg = this.hote.registry;
    const c = reg.getSensor(id);
    if (!c) throw new Error(`Capteur « ${id} » inconnu`);
    const nom = ['quoi', 'lieu', 'lieuPrecis', 'lieuPere', 'lieuGrandPere'].some((k) => p[k] !== undefined) ? this.composerNom(p, c.name) : c.name;
    const transmit = typeof p.transmitToHa === 'boolean' ? p.transmitToHa : c.transmitToHa;
    const ops: Operation[] = [];
    // « Une modification = une suppression puis un ajout » : si le capteur était dans HA, on le retire avant de le redéclarer.
    if (c.transmitToHa) ops.push({ op: 'retirer-ha', id });
    ops.push({ op: 'definir', id, kind: c.kind, nom, transmitToHa: transmit });
    return {
      apercu: { avant: { nom: c.name, transmitToHa: c.transmitToHa }, apres: { nom, transmitToHa: transmit }, entiteHa: c.transmitToHa ? this.decrireHa(nom, transmit, 'recreee') : this.decrireHa(nom, transmit) },
      operations: ops
    };
  }

  private planSupprimer(p: Record<string, unknown>): Plan {
    const id = String(p.id ?? '');
    const c = this.hote.registry.getSensor(id);
    if (!c) throw new Error(`Capteur « ${id} » inconnu`);
    return {
      apercu: { retire: { id, nom: c.name }, entiteHa: c.transmitToHa ? this.decrireHa(c.name, true, 'supprimee') + ' (messages vides retenus : découverte, attributs, état)' : 'aucune entité dans HA' },
      operations: [...(c.transmitToHa ? [{ op: 'retirer-ha', id } as Operation] : []), { op: 'supprimer', id }]
    };
  }

  private planRemplacer(p: Record<string, unknown>): Plan {
    const reg = this.hote.registry;
    const ancien = numeroBrut(p.ancien);
    const nouveau = numeroBrut(p.nouveau);
    if (!ancien || !nouveau) throw new Error('« ancien » et « nouveau » (numéros des capteurs) sont obligatoires');
    if (ancien === nouveau) throw new Error("L'ancien et le nouveau capteur sont identiques");

    const paires = [idTemperature, idHumidite]
      .map((f) => ({ ancien: f(ancien), nouveau: f(nouveau) }))
      .filter((x) => reg.getSensor(x.ancien));
    if (paires.length === 0) throw new Error(`Aucun capteur configuré avec le numéro ${ancien}`);

    const manquants: string[] = [];
    for (const x of paires) {
      if (reg.getSensor(x.nouveau)) throw new Error(`« ${x.nouveau} » est déjà configuré`);
      if (!reg.getDiscovered(x.nouveau)) manquants.push(x.nouveau);
    }
    if (manquants.length) throw new Error(`Le capteur neuf n'est pas (encore) dans les découverts : ${manquants.join(', ')} — attendre sa prochaine émission`);

    const operations: Operation[] = [];
    // Suppression d'abord (libère l'entity_id côté HA), ajout ensuite au même nommage.
    for (const x of paires) {
      const c = reg.getSensor(x.ancien) as ArexxSensorInfo;
      if (c.transmitToHa) operations.push({ op: 'retirer-ha', id: x.ancien });
      operations.push({ op: 'supprimer', id: x.ancien });
    }
    for (const x of paires) {
      const c = reg.getSensor(x.ancien) as ArexxSensorInfo;
      operations.push({ op: 'definir', id: x.nouveau, kind: c.kind, nom: c.name, transmitToHa: c.transmitToHa });
    }
    return {
      apercu: {
        etapes: [...paires.map((x) => `supprimer ${x.ancien}`), ...paires.map((x) => `ajouter ${x.nouveau} (même nommage)`)],
        capteurs: paires.map((x) => ({ ancien: x.ancien, nouveau: x.nouveau, nom: (reg.getSensor(x.ancien) as ArexxSensorInfo).name })),
        entiteHa: paires.some((x) => (reg.getSensor(x.ancien) as ArexxSensorInfo).transmitToHa)
          ? 'entité(s) supprimée(s) puis recréée(s) avec le même nom, donc le même entity_id (à vérifier dans HA)'
          : 'aucune entité dans HA'
      },
      operations
    };
  }

  private planEffacer(p: Record<string, unknown>): Plan {
    const reg = this.hote.registry;
    if (p.tout === true) {
      const ids = reg.getDiscoveredSensors().map((d) => d.uniqueId);
      return { apercu: { efface: ids, note: 'mémoire du pilote seulement ; ils réapparaissent s\'ils émettent à nouveau ; HA non touché' }, operations: [{ op: 'oublier', ids }] };
    }
    const id = String(p.id ?? '');
    if (!reg.getDiscovered(id)) throw new Error(`« ${id} » n'est pas dans les découverts`);
    return { apercu: { efface: [id], note: 'mémoire du pilote seulement ; HA non touché' }, operations: [{ op: 'oublier', ids: [id] }] };
  }

  private planIgnorer(p: Record<string, unknown>): Plan {
    const id = String(p.id ?? '');
    const reg = this.hote.registry;
    if (!reg.getDiscovered(id) && !reg.getIgnored().includes(id)) throw new Error(`« ${id} » n'est pas dans les découverts`);
    return { apercu: { ignore: id, note: 'ne sera plus jamais proposé ; HA non touché' }, operations: [{ op: 'ignorer', id }] };
  }
}
