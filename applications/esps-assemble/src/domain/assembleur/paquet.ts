/**
 * Assemblage d'un appareil en PAQUET (zip) pour l'usine de l'application esphome (fonctionnelles-esphome_specs §4bis) :
 * sources résolues et vérifiées + `manifest.json` (appareil, modèle, adresse de l'ESP, options, sommes de contrôle de chaque fichier).
 * Aucun secret : le YAML référence `!secret …`, dont les valeurs restent dans le secrets.yaml de la machine ESPHome.
 */

import * as crypto from 'node:crypto';
import { Bibliotheque, FicheInvalide, type FicheElement, type FicheAppareil } from './fiches';
import { resoudreAppareil, ResolutionImpossible } from './resolution';
import { verifier } from './verification';
import { ecrireZip } from './zip-ecriture';

export interface ManifestePaquet {
  v: 1;
  appareil: string;
  nomAffichage: string;
  revision: number;
  assemble: string;
  modele: { id: string; puce: string; flash: string; cadre: string; memoire: { emplacementOtaOctets: number; ramInterneOctets: number } };
  esp: { adresse: string; port: number; portOta: number };
  options: { autoriserAppelsService: boolean };
  wifi: string[];
  fichiers: Record<string, string>;
}

export type ResultatAssemblage =
  | { ok: true; zip: Buffer; sha256: string; manifeste: ManifestePaquet; avertissements: string[] }
  | { ok: false; erreurs: string[]; avertissements: string[] };

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

export function assemblerPaquet(racine: string, nom: string, revision: number, maintenant: () => Date = () => new Date(), generes: Map<string, Buffer> = new Map()): ResultatAssemblage {
  const biblio = new Bibliotheque(racine);
  try {
    const appareil = biblio.appareil(nom);
    const sources = resoudreAppareil(racine, nom, generes);
    // Les images de fond générées sont des fichiers du paquet au même titre que les sources.
    for (const [chemin, contenu] of generes) if (!sources.fichiers.has(chemin)) sources.fichiers.set(chemin, contenu);
    const materiel = biblio.materiel(appareil.materiel);
    const elements = new Map<string, FicheElement>();
    const erreursFiches: string[] = [];
    for (const id of new Set(sources.elements.map((e) => e.id))) {
      try { elements.set(id, biblio.element(id)); } catch (e) { erreursFiches.push((e as Error).message); }
    }
    const autres: FicheAppareil[] = [];
    for (const n of biblio.appareils()) if (n !== nom) { try { autres.push(biblio.appareil(n)); } catch { /* fiche d'un autre appareil invalide : sans effet ici */ } }

    const diag = verifier(appareil, sources, { materiel, elements, autres });
    const erreurs = [...erreursFiches, ...diag.erreurs];
    if (erreurs.length > 0) return { ok: false, erreurs, avertissements: diag.avertissements };

    const fichiers: Record<string, string> = {};
    for (const [chemin, contenu] of sources.fichiers) fichiers[chemin] = sha(contenu);
    const manifeste: ManifestePaquet = {
      v: 1,
      appareil: nom,
      nomAffichage: appareil.nomAffichage,
      revision,
      assemble: maintenant().toISOString(),
      modele: { id: materiel.id, puce: materiel.puce, flash: materiel.flash, cadre: materiel.cadre, memoire: { emplacementOtaOctets: materiel.memoire.emplacementOtaOctets, ramInterneOctets: materiel.memoire.ramInterneOctets } },
      esp: { adresse: appareil.esp.adresse || `${nom}.local`, port: appareil.esp.port, portOta: appareil.esp.portOta ?? materiel.portOta },
      options: { autoriserAppelsService: appareil.options.autoriserAppelsService },
      wifi: appareil.wifi,
      fichiers
    };
    const zip = ecrireZip([
      { chemin: 'manifest.json', contenu: Buffer.from(JSON.stringify(manifeste, null, 1)) },
      ...[...sources.fichiers].map(([chemin, contenu]) => ({ chemin, contenu }))
    ]);
    return { ok: true, zip, sha256: sha(zip), manifeste, avertissements: diag.avertissements };
  } catch (e) {
    if (e instanceof FicheInvalide || e instanceof ResolutionImpossible) return { ok: false, erreurs: [e.message], avertissements: [] };
    throw e;
  }
}
