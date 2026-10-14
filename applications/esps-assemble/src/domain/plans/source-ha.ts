/**
 * Plans de l'intégration Plans de HA (https://github.com/zdid/dimotic-ha-plans, v0.1.8+) : commande WebSocket
 * `dimotic_plans/floorplans/export` par la liaison HA du cœur (aucun jeton ici). Positions au coin INFÉRIEUR GAUCHE de l'objet.
 * Un seul appel par assemblage, quel que soit le nombre de plans demandés (`preparer`).
 */

import type { PlanSource, SourcePlans } from './generer-fichiers';
import { PlanIntrouvable } from './generer-fichiers';

export interface ClientHa {
  callWs(message: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

interface Export {
  floorplans: Record<string, { filename: string; positions: { entity_id: string; x: number | null; y: number | null; quoi?: string | null }[]; texts: any[] }>;
  images: Record<string, string>;
}

/** Message lisible d'une erreur de la liaison HA (`{code, message}` ou Error). */
function texteErreur(e: unknown): string {
  if (e instanceof Error) return typeof e.message === 'string' ? e.message : JSON.stringify(e.message);
  if (e && typeof e === 'object') { const o = e as { code?: unknown; message?: unknown }; return [o.code, o.message].filter(Boolean).join(' : ') || JSON.stringify(e); }
  return String(e);
}

export class SourcePlansHa implements SourcePlans {
  private cache: Export | null = null;

  constructor(private readonly ha: ClientHa) {}

  /** Récupère les plans demandés en une fois (et en échec clair si l'intégration Plans n'est pas à jour ou absente). */
  async preparer(ids: string[]): Promise<void> {
    let r: unknown;
    try {
      r = await this.ha.callWs({ type: 'dimotic_plans/floorplans/export', plan_ids: ids }, 60_000);
    } catch (e) {
      throw new PlanIntrouvable(`export des plans impossible (intégration Plans ≥ 0.1.8 installée et configurée ? plans « ${ids.join(', ')} » existants ?) : ${texteErreur(e)}`);
    }
    this.cache = r as Export;
  }

  async lire(id: string): Promise<PlanSource> {
    if (!this.cache) await this.preparer([id]);
    const plan = this.cache!.floorplans?.[id];
    if (!plan) throw new PlanIntrouvable(`plan « ${id} » absent de l'export de HA`);
    const b64 = this.cache!.images?.[plan.filename];
    if (!b64) throw new PlanIntrouvable(`image du plan « ${id} » (${plan.filename}) absente de l'export de HA`);
    return { id, image: Buffer.from(b64, 'base64'), positions: plan.positions, textes: plan.texts ?? [], ancrage: 'bas-gauche' };
  }
}
