/**
 * Vérifications d'un appareil AVANT de générer le paquet (fonctionnelles-esphome_specs §4bis, conception §3.2-§3.3) :
 * compatibilité (plateforme, écran, audio, éléments requis), paramètres des éléments, conflits de broches, unicité des noms.
 * Chaque problème est une phrase lisible ; le paquet n'est produit que s'il n'y a aucune erreur (les avertissements ne bloquent pas).
 */

import type { FicheMateriel, FicheElement, FicheAppareil } from './fiches';
import type { SourcesAppareil } from './resolution';

export interface Diagnostic {
  erreurs: string[];
  avertissements: string[];
}

export interface Contexte {
  materiel: FicheMateriel;
  elements: Map<string, FicheElement>;
  /** Fiches des AUTRES appareils (unicité du nom et du nom d'affichage). */
  autres: FicheAppareil[];
}

export function verifier(appareil: FicheAppareil, sources: SourcesAppareil, ctx: Contexte): Diagnostic {
  const erreurs: string[] = [];
  const avertissements: string[] = [];
  const m = ctx.materiel;

  // Cohérence du matériel déclaré
  if (sources.materiel === null) erreurs.push(`l'appareil n'inclut aucun matériel (bibliotheque/materiels/<id>/base.yaml)`);
  else if (sources.materiel !== appareil.materiel) erreurs.push(`la fiche déclare le matériel « ${appareil.materiel} » mais le fichier inclut « ${sources.materiel} »`);

  // Unicité
  for (const a of ctx.autres) {
    if (a.nom === appareil.nom) continue;
    if (a.nomAffichage.trim().toLowerCase() === appareil.nomAffichage.trim().toLowerCase()) erreurs.push(`le nom d'affichage « ${appareil.nomAffichage} » est déjà celui de l'appareil ${a.nom}`);
  }

  // Éléments : exigences, paramètres
  const presents = new Set(sources.elements.map((e) => e.id));
  const brochesElements = new Map<number, string>();
  for (const inc of sources.elements) {
    const f = ctx.elements.get(inc.id);
    if (!f) { erreurs.push(`élément « ${inc.id} » sans fiche (bibliotheque/elements/${inc.id}/fiche.yaml)`); continue; }
    const ex = f.exigences;
    if (ex.plateformes && !ex.plateformes.includes(m.plateforme)) erreurs.push(`l'élément ${inc.id} ne fonctionne pas sur ${m.plateforme} (plateformes : ${ex.plateformes.join(', ')})`);
    if (ex.ecran) {
      if (!m.ecran) erreurs.push(`l'élément ${inc.id} demande un écran ${ex.ecran.largeur}x${ex.ecran.hauteur} : le matériel ${m.id} n'a pas d'écran`);
      else if (m.ecran.largeur !== ex.ecran.largeur || m.ecran.hauteur !== ex.ecran.hauteur) erreurs.push(`l'élément ${inc.id} demande un écran ${ex.ecran.largeur}x${ex.ecran.hauteur} : le matériel ${m.id} a ${m.ecran.largeur}x${m.ecran.hauteur}`);
    }
    if (ex.audio && !m.audio) erreurs.push(`l'élément ${inc.id} demande de l'audio : le matériel ${m.id} n'en a pas`);
    if (ex.materiels && !ex.materiels.includes(m.id)) erreurs.push(`l'élément ${inc.id} n'est prévu que pour : ${ex.materiels.join(', ')}`);
    for (const requis of ex.elements) if (!presents.has(requis)) erreurs.push(`l'élément ${inc.id} exige aussi l'élément ${requis}`);
    for (const p of f.parametres) if (p.requis && p.defaut === undefined && !(p.nom in inc.vars)) erreurs.push(`l'élément ${inc.id} : paramètre « ${p.nom} » manquant`);
    const connus = new Set(f.parametres.map((p) => p.nom));
    for (const v of Object.keys(inc.vars)) if (!connus.has(v)) avertissements.push(`l'élément ${inc.id} : variable « ${v} » inconnue de sa fiche`);
    for (const b of f.broches) {
      if (m.brochesPrises.includes(b)) erreurs.push(`conflit de broche GPIO${b} : l'élément ${inc.id} la demande, elle est déjà prise par le matériel ${m.id}`);
      const autre = brochesElements.get(b);
      if (autre && autre !== inc.id) erreurs.push(`conflit de broche GPIO${b} : demandée par les éléments ${autre} et ${inc.id}`);
      brochesElements.set(b, inc.id);
    }
  }

  // Paramètres d'un élément inclus plusieurs fois : deux instances identiques sont probablement une erreur
  const vus = new Set<string>();
  for (const inc of sources.elements) {
    const cle = `${inc.id}|${JSON.stringify(Object.entries(inc.vars).sort())}`;
    if (vus.has(cle)) avertissements.push(`l'élément ${inc.id} est inclus deux fois avec les mêmes paramètres`);
    vus.add(cle);
  }

  // Pages de plans générées : exigent un écran et l'élément qui définit les polices d'icônes.
  if (appareil.plans.length > 0) {
    if (!m.ecran) erreurs.push(`l'appareil demande des pages de plans : le matériel ${m.id} n'a pas d'écran`);
    if (!presents.has('polices-plans')) erreurs.push(`l'appareil demande des pages de plans : il doit aussi inclure l'élément polices-plans (polices des icônes)`);
  }

  if (sources.annexesManquantes.length > 0) avertissements.push(`fichiers annexes introuvables (non embarqués) : ${sources.annexesManquantes.join(', ')}`);
  return { erreurs, avertissements };
}
