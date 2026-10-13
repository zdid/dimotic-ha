/**
 * Premier flash par USB (fonctionnelles-esphome_specs §3.9, §5.4) : la carte est branchée sur la machine de l'usine.
 * Étapes : reconnaissance (lecture seule) → refus si la carte n'est pas celle de la fiche → `esphome upload` (flash USB du
 * firmware déjà compilé) → adresse MAC associée à l'appareil dans le catalogue.
 */

import type { DockerClient } from './DockerApi';
import { reconnaitre, juger, type Releve, type Verdict } from './Reconnaissance';
import type { Catalogue } from './Catalogue';

export interface DepsPremierFlash {
  docker: DockerClient;
  catalogue: Catalogue;
  conteneur: string;
  cheminDansConteneur: string;
  peripherique: string;
  surSortie?: (morceau: string) => void;
}

export type ResultatFlash =
  | { ok: true; releve: Releve; fin: string }
  | { ok: false; raison: string; releve?: Releve; verdict?: Verdict };

export async function flasherParUsb(d: DepsPremierFlash, appareil: string, options: { forcer?: boolean } = {}): Promise<ResultatFlash> {
  const cat = d.catalogue.lire();
  const entree = cat.appareils.find((a) => a.appareil === appareil);
  if (!entree) return { ok: false, raison: `appareil ${appareil} inconnu : aucun paquet reçu pour lui` };
  const modele = cat.modeles.find((m) => m.id === entree.modele);
  if (!modele) return { ok: false, raison: `modèle ${entree.modele} inconnu du catalogue` };

  let releve: Releve;
  try {
    releve = await reconnaitre(d.docker, d.conteneur, d.peripherique);
  } catch (e) {
    return { ok: false, raison: (e as Error).message };
  }
  const verdict = juger(releve, cat.modeles, d.catalogue.appareilsAvecMac(), modele);
  if (verdict.type === 'non_conforme' && !options.forcer) {
    return { ok: false, raison: `carte non conforme à ${modele.id} — ${verdict.detail}`, releve, verdict };
  }
  if (verdict.type === 'appareil_connu' && verdict.appareil !== appareil && !options.forcer) {
    return { ok: false, raison: `cette carte est déjà l'appareil « ${verdict.appareil} » (MAC ${releve.mac}) : refus de l'écraser avec « ${appareil} »`, releve, verdict };
  }

  try {
    const r = await d.docker.exec(d.conteneur, ['esphome', 'upload', `${d.cheminDansConteneur}/${appareil}.yaml`, '--device', d.peripherique], { surSortie: d.surSortie, delaiMs: 10 * 60_000 });
    if (r.codeSortie !== 0) return { ok: false, raison: `flash USB raté (code ${r.codeSortie}) : …${r.sortie.slice(-1500)}`, releve, verdict };
    d.catalogue.noterMac(appareil, releve.mac);
    return { ok: true, releve, fin: r.sortie.slice(-500) };
  } catch (e) {
    return { ok: false, raison: `ESPHome injoignable : ${(e as Error).message}`, releve, verdict };
  }
}
