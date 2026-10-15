/**
 * Fichiers GÉNÉRÉS à l'assemblage pour les plans d'un appareil (fonctionnelles-esps-assemble §8) : pour chaque plan de la fiche, l'image de fond
 * ramenée à l'écran (`floorplan_<page>_<L>x<H>.png`) et l'élément ESPHome de la page (`generes/page-plan-<page>.yaml`).
 * Les plans viennent d'une `SourcePlans` : l'intégration Plans de HA (export) ou des fichiers locaux au format HAPLAN (essais, anciens plans).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { elementPlan, genererPage, slug, type PositionPlan, type TexteLibre } from './generation';
import { ajusterImage, dimensionsPng } from './image';
import type { Ancrage, Dimensions } from './coordonnees';

export interface PlanSource {
  id: string;
  /** Image de fond (PNG). */
  image: Buffer;
  positions: PositionPlan[];
  textes: TexteLibre[];
  /** `bas-gauche` pour l'intégration Plans (v0.1.6+), `centre` pour les anciens plans HAPLAN. */
  ancrage: Ancrage;
}

export interface SourcePlans {
  lire(id: string): Promise<PlanSource>;
}

export class PlanIntrouvable extends Error {}

/** Anciens plans HAPLAN (`data/haplan/config-haplan-floorplans-v1.0.yaml` + `images/`) : positions au CENTRE. Sert aux essais et à la reprise. */
export class SourcePlansHaplan implements SourcePlans {
  constructor(private readonly dossier: string) {}
  async lire(id: string): Promise<PlanSource> {
    const cfg = yaml.load(fs.readFileSync(path.join(this.dossier, 'config-haplan-floorplans-v1.0.yaml'), 'utf8')) as { floorplans?: Record<string, any> } & Record<string, any>;
    const plans = cfg.floorplans ?? cfg;
    const p = plans[id];
    if (!p) throw new PlanIntrouvable(`plan « ${id} » introuvable dans ${this.dossier}`);
    return {
      id,
      image: fs.readFileSync(path.join(this.dossier, 'images', p.filename)),
      positions: (p.positions ?? []).map((q: any) => ({ entity_id: q.entity_id, x: q.x ?? null, y: q.y ?? null })),
      textes: p.texts ?? [],
      ancrage: 'centre'
    };
  }
}

/** Chemin, dans le paquet, de l'élément généré d'un plan. */
export function cheminPagePlan(idPlan: string): string {
  return `generes/page-plan-${slug(idPlan) || 'plan'}.yaml`;
}

export interface FichiersPlans {
  fichiers: Map<string, Buffer>;
  /** Un résumé par plan : page, objets placés, hors cadre. */
  resume: { plan: string; page: string; placees: number; hors: number }[];
}

export async function genererFichiersPlans(ids: string[], source: SourcePlans, ecran: Dimensions, tailleTexte?: number): Promise<FichiersPlans> {
  const fichiers = new Map<string, Buffer>();
  const resume: FichiersPlans['resume'] = [];
  const pages = new Set<string>();
  for (const id of ids) {
    const p = await source.lire(id);
    const page = genererPage({ id, image: dimensionsPng(p.image), positions: p.positions, textes: p.textes }, ecran, p.ancrage, tailleTexte);
    if (pages.has(page.page)) throw new Error(`deux plans donnent la même page « ${page.page} » (identifiants trop proches)`);
    pages.add(page.page);
    const entete = `# Élément GÉNÉRÉ à l'assemblage — page du plan « ${id} » (${ecran.largeur}x${ecran.hauteur}). Ne pas modifier : regénéré à chaque assemblage.`;
    fichiers.set(cheminPagePlan(id), Buffer.from(elementPlan(page, ecran, entete)));
    fichiers.set(page.imageFilename, ajusterImage(p.image, ecran).png);
    resume.push({ plan: id, page: page.page, placees: page.placees, hors: page.hors });
  }
  return { fichiers, resume };
}
