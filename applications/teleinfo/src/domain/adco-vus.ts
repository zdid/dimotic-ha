/**
 * ADCO vus par l'agent — alimenté par les trames que l'agent publie déjà (`<discoveryPrefix>/sensor/teleinfo_<adco>/state`).
 * Sert au bloc « ADCO rencontrés par l'agent » de l'écran : un ADCO déclaré jamais vu ou silencieux, ou un ADCO inconnu, y est visible.
 */

export interface AdcoVu {
  adco: number;
  /** Compteur déclaré dans la configuration de l'application. */
  declare: boolean;
  /** Libellé quoi/lieu s'il est déclaré. */
  nom: string | null;
  /** ISO de la dernière trame reçue ; null = jamais vu depuis le démarrage de l'application. */
  derniereTrame: string | null;
  papp: number | null;
  iinst: number | null;
}

export interface CompteurDeclare { adco: number; quoi: string; lieu: string; lieuPrecis?: string }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Topic d'état d'un compteur : `<prefix>/sensor/teleinfo_<adco>/state` → ADCO, sinon null. */
export function adcoDuTopic(topic: string, discoveryPrefix: string): number | null {
  const m = new RegExp(`^${discoveryPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sensor/teleinfo_(\\d+)/state$`).exec(topic);
  return m ? Number(m[1]) : null;
}

export class AdcoVus {
  private readonly vus = new Map<number, { derniereTrame: string; papp: number | null; iinst: number | null }>();

  enregistrer(adco: number, payload: unknown, maintenant: Date = new Date()): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    this.vus.set(adco, { derniereTrame: maintenant.toISOString(), papp: num(p.PAPP), iinst: num(p.IINST) });
  }

  /** Déclarés d'abord (dans l'ordre de la configuration), puis les ADCO inconnus vus par l'agent. */
  liste(declares: CompteurDeclare[]): AdcoVu[] {
    const libelle = (c: CompteurDeclare): string => [c.quoi, c.lieuPrecis, c.lieu].filter(Boolean).join(' / ');
    const sortie: AdcoVu[] = declares.map((c) => {
      const v = this.vus.get(c.adco);
      return { adco: c.adco, declare: true, nom: libelle(c), derniereTrame: v?.derniereTrame ?? null, papp: v?.papp ?? null, iinst: v?.iinst ?? null };
    });
    for (const [adco, v] of this.vus) {
      if (declares.some((c) => c.adco === adco)) continue;
      sortie.push({ adco, declare: false, nom: null, derniereTrame: v.derniereTrame, papp: v.papp, iinst: v.iinst });
    }
    return sortie;
  }
}
