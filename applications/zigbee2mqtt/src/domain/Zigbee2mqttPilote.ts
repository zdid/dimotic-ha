/**
 * Zigbee2mqttPilote — gestion des appareils Zigbee par l'agent IA (conception-gestion-pilotes_specs v1.5 §9, étape 5).
 *
 * Implémente le `PiloteGestionnaire` du canal « pilotes » du cœur au-dessus de l'API MQTT de zigbee2mqtt
 * (`<base>/bridge/request/...`). Correspondance avec le contrat :
 *   lister      appareils du réseau (hors coordinateur), avec leur nom, modèle et état d'interview
 *   decouverts  appareils pas encore qualifiés : en interview, ou dont le nom n'est pas `quoi---lieu` (souvent l'adresse IEEE)
 *   adopter     renomme l'appareil en `quoi---[lieu précis--]lieu` (z2m republie sa découverte, `nommage` la relaie vers HA)
 *   modifier    renomme un appareil déjà qualifié
 *   supprimer   retire l'appareil du réseau (`force` pour un appareil mort qui ne répond plus)
 *   remplacer   suppression de l'ancien PUIS renommage du neuf avec le nom de l'ancien (même nommage → mêmes entity_id)
 *   appairer    ouvre le réseau (permit_join) pour une durée courte, plafonnée
 * Pas d'`effacer`/`ignorer` (z2m garde la liste des appareils) ni de `redemarrer` (redémarrer z2m coupe tout le réseau Zigbee).
 *
 * Aucune sauvegarde côté dimotic-ha : zigbee2mqtt écrit lui-même sa configuration ; l'aperçu le dit. Un renommage change les
 * sujets MQTT de l'appareil et les entity_id dans HA : l'aperçu le précise.
 */

import { composerNom, decomposerNom, type PiloteGestionnaire } from '../../../core/dist/exports';
import type { Z2mDevice, Z2mReponse } from './types';

export interface Zigbee2mqttPiloteHote {
  devices(): Z2mDevice[];
  /** Vrai si zigbee2mqtt est joignable (`bridge/state` en ligne). */
  enLigne(): boolean;
  /** Envoie `<base>/bridge/request/<suffixe>` et attend la réponse. */
  envoyer(suffixe: string, payload: Record<string, unknown>): Promise<Z2mReponse>;
  /** Attend que HA ait supprimé les entités de ces noms (suppression AVANT création : sinon HA suffixe `_2`). */
  attendreRetraitHa(noms: string[]): Promise<{ absent: boolean; attenteMs: number; restantes: string[] }>;
  appairageDefautSec(): number;
  appairageMaxSec(): number;
}

type Operation =
  | { op: 'renommer'; de: string; vers: string }
  | { op: 'retirer'; id: string; force: boolean }
  | { op: 'appairer'; duree: number };

interface Plan {
  apercu: Record<string, unknown>;
  operations: Operation[];
}

const NOTE_Z2M = "zigbee2mqtt écrit lui-même sa configuration (pas de sauvegarde côté dimotic-ha)";

export function estQualifie(nom: string): boolean {
  const [quoi, lieu] = nom.split('---');
  return Boolean(quoi?.trim()) && Boolean(lieu?.trim());
}

export class Zigbee2mqttPilote implements PiloteGestionnaire {
  constructor(private readonly hote: Zigbee2mqttPiloteHote) {}

  private appareils(): Z2mDevice[] {
    return this.hote.devices().filter((d) => d.type !== 'Coordinator');
  }

  private trouver(id: unknown): Z2mDevice | undefined {
    const v = String(id ?? '').trim();
    return this.appareils().find((d) => d.ieee_address === v || d.friendly_name === v);
  }

  private decrire(d: Z2mDevice): Record<string, unknown> {
    return {
      id: d.ieee_address,
      nom: d.friendly_name,
      type: d.type,
      modele: d.definition?.model ?? null,
      fabricant: d.definition?.vendor ?? null,
      description: d.definition?.description ?? null,
      interview: d.interviewing ? 'en cours' : d.interview_completed ? 'terminée' : 'incomplète',
      reconnu: d.supported !== false,
      desactive: d.disabled === true,
      qualifie: estQualifie(d.friendly_name)
    };
  }

  private estDecouvert(d: Z2mDevice): boolean {
    return d.interviewing === true || !estQualifie(d.friendly_name);
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  async lire(ordre: 'lister' | 'decouverts'): Promise<unknown> {
    if (!this.hote.enLigne()) throw new Error('zigbee2mqtt est hors ligne ou ne répond pas');
    if (ordre === 'lister') return { appareils: this.appareils().map((d) => this.decrire(d)) };
    return { decouverts: this.appareils().filter((d) => this.estDecouvert(d)).map((d) => this.decrire(d)) };
  }

  // ---------------------------------------------------------------------------
  // Ordres modifiants
  // ---------------------------------------------------------------------------

  async preparer(ordre: string, parametres: Record<string, unknown>): Promise<{ apercu: unknown; etat: unknown }> {
    const plan = this.planifier(ordre, parametres);
    const etat = {
      appareils: this.appareils().map((d) => [d.ieee_address, d.friendly_name, d.interviewing === true]).sort(),
      enLigne: this.hote.enLigne()
    };
    return { apercu: plan.apercu, etat };
  }

  async appliquer(ordre: string, parametres: Record<string, unknown>): Promise<{ resultat?: unknown; sauvegarde?: string }> {
    const plan = this.planifier(ordre, parametres);
    const faites: string[] = [];
    let nomRetire: string | undefined;
    for (const o of plan.operations) {
      let r: Z2mReponse;
      if (o.op === 'renommer') {
        // Le nom de l'ancien appareil sert au neuf : HA doit d'abord avoir SUPPRIMÉ les entités de l'ancien (sinon `_2`).
        if (nomRetire) {
          const attente = await this.hote.attendreRetraitHa([nomRetire]);
          faites.push(attente.absent ? `suppression confirmée par HA (${attente.attenteMs} ms)` : `suppression NON confirmée par HA après ${attente.attenteMs} ms (restent : ${attente.restantes.join(', ') || 'inconnu'}) : vérifier`);
          nomRetire = undefined;
        }
        // homeassistant_rename : z2m renomme aussi les entités dans son intégration HA (découverte).
        r = await this.hote.envoyer('device/rename', { from: o.de, to: o.vers, homeassistant_rename: true });
        faites.push(`renommé « ${o.de} » en « ${o.vers} »`);
      } else if (o.op === 'retirer') {
        nomRetire = this.appareils().find((d) => d.ieee_address === o.id)?.friendly_name;
        r = await this.hote.envoyer('device/remove', { id: o.id, force: o.force });
        faites.push(`retiré « ${o.id} »${o.force ? ' (forcé)' : ''}`);
      } else {
        r = await this.hote.envoyer('permit_join', { time: o.duree });
        faites.push(`réseau ouvert ${o.duree} s`);
      }
      if (!r.ok) {
        throw new Error(`${faites.length > 1 ? `Déjà fait : ${faites.slice(0, -1).join(' ; ')}. ` : ''}Échec de « ${faites[faites.length - 1]} » : ${r.error ?? 'refusé par zigbee2mqtt'}`);
      }
    }
    return { resultat: { fait: faites } };
  }

  // ---------------------------------------------------------------------------
  // Planification (aucun effet de bord : sert à l'aperçu ET à l'application)
  // ---------------------------------------------------------------------------

  private planifier(ordre: string, p: Record<string, unknown>): Plan {
    if (!this.hote.enLigne()) throw new Error('zigbee2mqtt est hors ligne ou ne répond pas');
    switch (ordre) {
      case 'adopter': return this.planAdopter(p);
      case 'modifier': return this.planModifier(p);
      case 'supprimer': return this.planSupprimer(p);
      case 'remplacer': return this.planRemplacer(p);
      case 'appairer': return this.planAppairer(p);
      default:
        throw new Error(`Ordre « ${ordre} » non géré par le pilote zigbee2mqtt (effacer, ignorer et redemarrer n'existent pas ici)`);
    }
  }

  /**
   * Nom complet `quoi---lieuPrécis--lieu--lieuPère--lieuGrandPère` (nommage_specs §3.3, fonction commune du cœur) ; refuse une
   * qualification incomplète. `repli` : nom actuel dont `p` ne change que certaines parties (modifier).
   */
  private composerNom(p: Record<string, unknown>, repli?: string): string {
    return composerNom(p, repli && estQualifie(repli) ? decomposerNom(repli) : undefined);
  }

  private verifierNomLibre(nom: string, sauf?: Z2mDevice): void {
    const pris = this.hote.devices().find((d) => d.friendly_name === nom && d !== sauf);
    if (pris) throw new Error(`Le nom « ${nom} » est déjà pris par ${pris.ieee_address}`);
  }

  private avertissementRenommage(): string {
    return "les sujets MQTT de l'appareil et ses entity_id dans HA changent avec son nom : les automatisations et tableaux de bord qui citaient l'ancien nom sont à corriger";
  }

  private planAdopter(p: Record<string, unknown>): Plan {
    const d = this.trouver(p.id);
    if (!d) throw new Error(`Appareil « ${String(p.id)} » inconnu (ordre decouverts pour la liste)`);
    if (d.interviewing) throw new Error(`« ${d.friendly_name} » est encore en interview : attendre la fin (quelques secondes à quelques minutes, l'appareil doit rester éveillé)`);
    if (estQualifie(d.friendly_name)) throw new Error(`« ${d.friendly_name} » est déjà qualifié (utiliser modifier pour le renommer)`);
    const nom = this.composerNom(p);
    this.verifierNomLibre(nom, d);
    return {
      apercu: {
        adopte: { id: d.ieee_address, avant: d.friendly_name, apres: nom, modele: d.definition?.model ?? null },
        entiteHa: "créée(s) dans HA par la découverte de zigbee2mqtt (relayée par nommage), nommée(s) d'après le nouveau nom",
        avertissement: this.avertissementRenommage(),
        note: NOTE_Z2M
      },
      operations: [{ op: 'renommer', de: d.friendly_name, vers: nom }]
    };
  }

  private planModifier(p: Record<string, unknown>): Plan {
    const d = this.trouver(p.id);
    if (!d) throw new Error(`Appareil « ${String(p.id)} » inconnu`);
    const nom = this.composerNom(p, d.friendly_name);
    // « cuisine--cuisine » et « cuisine » désignent le même lieu (précis == lieu = pas de précision distincte) : pas un vrai changement
    if (nom === d.friendly_name || (estQualifie(d.friendly_name) && nom === composerNom({}, decomposerNom(d.friendly_name)))) throw new Error('Le nom ne change pas');
    this.verifierNomLibre(nom, d);
    return {
      apercu: { avant: d.friendly_name, apres: nom, id: d.ieee_address, avertissement: this.avertissementRenommage(), note: NOTE_Z2M },
      operations: [{ op: 'renommer', de: d.friendly_name, vers: nom }]
    };
  }

  private planSupprimer(p: Record<string, unknown>): Plan {
    const d = this.trouver(p.id);
    if (!d) throw new Error(`Appareil « ${String(p.id)} » inconnu`);
    const force = p.force === true;
    return {
      apercu: {
        retire: { id: d.ieee_address, nom: d.friendly_name, modele: d.definition?.model ?? null },
        force,
        entiteHa: "toutes les entités de l'appareil disparaissent de HA (zigbee2mqtt retire sa découverte)",
        note: force
          ? "retrait forcé : l'appareil n'est pas prévenu (à utiliser s'il est mort) ; s'il est encore sous tension il se reconnectera"
          : "z2m demande à l'appareil de quitter le réseau ; s'il ne répond pas, refaire avec force: true"
      },
      operations: [{ op: 'retirer', id: d.ieee_address, force }]
    };
  }

  private planRemplacer(p: Record<string, unknown>): Plan {
    const ancien = this.trouver(p.ancien);
    const nouveau = this.trouver(p.nouveau);
    if (!ancien) throw new Error(`Appareil à remplacer « ${String(p.ancien)} » inconnu`);
    if (!nouveau) throw new Error(`Appareil neuf « ${String(p.nouveau)} » inconnu : l'appairer d'abord (ordre appairer, puis mettre l'appareil en mode appairage)`);
    if (ancien === nouveau) throw new Error("L'ancien et le nouveau appareil sont identiques");
    if (nouveau.interviewing) throw new Error(`« ${nouveau.friendly_name} » est encore en interview : attendre la fin`);
    if (estQualifie(nouveau.friendly_name)) throw new Error(`« ${nouveau.friendly_name} » est déjà qualifié : le neuf doit être un appareil tout juste appairé`);
    const force = p.force === true;
    return {
      apercu: {
        etapes: [
          `1. retirer ${ancien.friendly_name} (${ancien.ieee_address})${force ? ' en forçant' : ''}`,
          `2. renommer ${nouveau.ieee_address} en « ${ancien.friendly_name} » (même nommage)`
        ],
        nommage: ancien.friendly_name,
        entiteHa: "entités de l'ancien supprimées puis recréées par le neuf avec le même nom, donc les mêmes entity_id : les automatisations n'ont pas à changer (comme pour l'AREXX)",
        avertissement: "l'historique de l'ancien appareil reste attaché aux entity_id ; modèles différents = entités différentes possibles (vérifier dans HA)",
        note: NOTE_Z2M
      },
      operations: [
        { op: 'retirer', id: ancien.ieee_address, force },
        { op: 'renommer', de: nouveau.friendly_name, vers: ancien.friendly_name }
      ]
    };
  }

  private planAppairer(p: Record<string, unknown>): Plan {
    const max = this.hote.appairageMaxSec();
    const demande = p.duree === undefined ? this.hote.appairageDefautSec() : Number(p.duree);
    if (!Number.isFinite(demande) || demande < 1) throw new Error('« duree » doit être un nombre de secondes');
    const duree = Math.min(Math.round(demande), max);
    return {
      apercu: {
        ouvre: `le réseau Zigbee pendant ${duree} s${duree < demande ? ` (plafonné, ${demande} s demandées)` : ''}`,
        rappel: "mettre l'appareil neuf en mode appairage (action PHYSIQUE : bouton ou séquence propre à l'appareil) ; pendant ce temps tout appareil à portée peut rejoindre le réseau",
        suite: "puis ordre decouverts pour retrouver l'appareil (interview), et adopter ou remplacer"
      },
      operations: [{ op: 'appairer', duree }]
    };
  }
}
