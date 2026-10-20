/**
 * PilotesClient — outils MCP de gestion des pilotes (conception-gestion-pilotes_specs v1.5 §12).
 *
 * `ia` ne parle pas MQTT : il demande au cœur (événements `pilotes:agent:*`) de publier la requête (non signée) et attend la réponse
 * du pont. Règle : tout ordre modifiant passe d'abord par un APERÇU ; le
 * client garde le jeton de l'aperçu (valable 10 min, pour exactement le même pont/ordre/paramètres) et refuse d'appliquer
 * sans aperçu préalable, même si l'agent oublie de le faire.
 */

import type { IEventBus } from '../../../core/dist/exports';

const DELAI_REPONSE_MS = 75_000;
const VALIDITE_APERCU_MS = 10 * 60_000;

const EV = {
  REQUETE: 'pilotes:agent:requete',
  REPONSE: 'pilotes:agent:reponse',
  PONTS_DEMANDE: 'pilotes:agent:ponts:get',
  PONTS: 'pilotes:agent:ponts'
} as const;

export const PILOTES_AGENT_EVENTS = [EV.REPONSE, EV.PONTS];

const ORDRES_LECTURE = ['lister', 'decouverts'];
const ORDRES_MODIFIANTS = ['adopter', 'creer', 'modifier', 'remplacer', 'effacer', 'ignorer', 'supprimer', 'redemarrer', 'appairer'];

interface Reponse {
  id: string;
  pont: string;
  ok: boolean;
  resultat?: unknown;
  erreur?: { code: string; message: string };
  apercu?: unknown;
  jeton?: string;
  sauvegarde?: string;
}

function canonique(valeur: unknown): string {
  if (valeur === null || typeof valeur !== 'object') return JSON.stringify(valeur) ?? 'null';
  if (Array.isArray(valeur)) return `[${valeur.map(canonique).join(',')}]`;
  const o = valeur as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonique(o[k])}`).join(',')}}`;
}

export class PilotesClient {
  private readonly attentes = new Map<string, (donnee: unknown) => void>();
  private readonly apercus = new Map<string, { jeton: string; expire: number }>();
  private compteur = 0;

  constructor(private readonly eventBus: IEventBus, private readonly maintenant: () => number = () => Date.now()) {
    this.eventBus.onGeneric<{ ref: string; reponse: Reponse }>(EV.REPONSE, (d) => this.resoudre(d?.ref, d?.reponse));
    this.eventBus.onGeneric<{ ref: string; ponts: unknown }>(EV.PONTS, (d) => this.resoudre(d?.ref, d?.ponts));
  }

  private resoudre(ref: string | undefined, donnee: unknown): void {
    if (!ref) return;
    const f = this.attentes.get(ref);
    if (f) {
      this.attentes.delete(ref);
      f(donnee);
    }
  }

  private attendre<T>(ref: string, emettre: () => void, delaiMs = DELAI_REPONSE_MS): Promise<T | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.attentes.delete(ref);
        resolve(undefined);
      }, delaiMs);
      timer.unref?.();
      this.attentes.set(ref, (d) => {
        clearTimeout(timer);
        resolve(d as T);
      });
      emettre();
    });
  }

  private nouvelleRef(): string {
    return `ia${this.maintenant().toString(36)}${(this.compteur++).toString(36)}`;
  }

  /** Ponts du site (toutes machines), avec leurs capacités et leur joignabilité. */
  async ponts(): Promise<unknown> {
    const ref = this.nouvelleRef();
    const ponts = await this.attendre<Array<Record<string, unknown>>>(ref, () => this.eventBus.emitGeneric(EV.PONTS_DEMANDE, { ref }), 5_000);
    if (!ponts) return { error: "le cœur n'a pas répondu (canal pilotes désactivé ou broker MQTT absent ?)" };
    return {
      total: ponts.length,
      ponts: ponts.map((p) => ({
        pont: p.pont, type: p.type, machine: p.machine, joignable: p.joignable, etat: p.etat, capacites: p.capacites, version: p.version
      })),
      ...(ponts.length === 0 ? { remarque: 'aucun pont annoncé : applications pilotes arrêtées ou désactivées, ou canal pilotes inactif' } : {})
    };
  }

  private async envoyer(pont: string, ordre: string, parametres: Record<string, unknown>, apercu: boolean, jeton?: string): Promise<Reponse> {
    const ref = this.nouvelleRef();
    const reponse = await this.attendre<Reponse>(ref, () =>
      this.eventBus.emitGeneric(EV.REQUETE, { ref, pont, ordre, parametres, ...(apercu ? { apercu: true } : {}), ...(jeton ? { jeton } : {}) })
    );
    return reponse ?? { id: ref, pont, ok: false, erreur: { code: 'delai_depasse', message: "le cœur n'a pas répondu" } };
  }

  /** `lister` ou `decouverts` : ne modifie rien. */
  async lire(pont: string, ordre: string, parametres: Record<string, unknown>): Promise<unknown> {
    if (!pont) return { error: 'pont obligatoire (voir pilotes_ponts)' };
    if (!ORDRES_LECTURE.includes(ordre)) return { error: `ordre de lecture attendu : ${ORDRES_LECTURE.join(' ou ')}` };
    return this.mettreEnForme(await this.envoyer(pont, ordre, parametres, false));
  }

  /**
   * Ordre modifiant. Sans `confirme` : aperçu seulement (rien n'est modifié). Avec `confirme: true` : applique, mais
   * seulement si CET aperçu exact a été fait avant (le jeton est celui du pont : s'il a changé depuis, il refuse).
   */
  async modifier(pont: string, ordre: string, parametres: Record<string, unknown>, confirme: boolean): Promise<unknown> {
    if (!pont) return { error: 'pont obligatoire (voir pilotes_ponts)' };
    if (!ORDRES_MODIFIANTS.includes(ordre)) return { error: `ordre modifiant attendu : ${ORDRES_MODIFIANTS.join(', ')}` };
    const cle = `${pont}|${ordre}|${canonique(parametres)}`;

    if (!confirme) {
      const r = await this.envoyer(pont, ordre, parametres, true);
      if (r.ok && r.jeton) this.apercus.set(cle, { jeton: r.jeton, expire: this.maintenant() + VALIDITE_APERCU_MS });
      return this.mettreEnForme(r, { applique: false, suite: r.ok ? "montrer cet aperçu à l'utilisateur ; n'appliquer (confirme:true, mêmes paramètres) qu'après son accord explicite" : undefined });
    }

    const memorise = this.apercus.get(cle);
    if (!memorise || memorise.expire < this.maintenant()) {
      this.apercus.delete(cle);
      return { error: "aucun aperçu récent pour ces paramètres exacts : refaire l'aperçu (sans confirme) et le montrer à l'utilisateur avant d'appliquer" };
    }
    this.apercus.delete(cle);
    const r = await this.envoyer(pont, ordre, parametres, false, memorise.jeton);
    return this.mettreEnForme(r, { applique: r.ok, suite: r.ok ? "vérifier ensuite dans HA (obtenir_details) que l'entité reçoit des valeurs" : undefined });
  }

  private mettreEnForme(r: Reponse, extra: Record<string, unknown> = {}): unknown {
    if (!r.ok) return { ok: false, erreur: r.erreur, ...extra };
    return {
      ok: true,
      ...(r.apercu !== undefined ? { apercu: r.apercu } : {}),
      ...(r.resultat !== undefined ? { resultat: r.resultat } : {}),
      ...(r.sauvegarde ? { sauvegarde: r.sauvegarde } : {}),
      ...extra
    };
  }
}
