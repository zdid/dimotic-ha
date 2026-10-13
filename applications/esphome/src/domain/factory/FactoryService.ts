/**
 * Usine — traitement d'UNE demande de l'assembleur (fonctionnelles-esphome_specs §5.1) :
 * récupération du paquet (somme de contrôle) → lecture et vérification du manifeste → dépôt des sources dans le dossier
 * d'ESPHome → SUPPRESSION de la demande (seulement maintenant) → clé API si l'appareil est neuf → compilation (API Docker)
 * → relevé et contrôle des tailles (§5.5) → publication du firmware et du message de pose.
 *
 * Toutes les dépendances sont injectées (téléchargement, Docker, secrets, publication) : la logique est testée sans réseau.
 * La file d'attente (une compilation à la fois) est tenue par l'appelant.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Job, Pose, Status, Mesures, Etat } from '../messages';
import { lireZip, ZipInvalide } from './zip';
import { sha256, verifierPaquet, type Manifeste } from './manifest';
import { releverMesures, controlerTailles } from './compile-output';
import type { DockerClient } from './DockerApi';
import type { SecretsStore } from './SecretsStore';

export interface PublicationUsine {
  statut(site: string, appareil: string, etat: Etat, extra?: Partial<Pick<Status, 'detail' | 'mesures' | 'versionFirmware'>>): void;
  pose(site: string, appareil: string, pose: Omit<Pose, 'v' | 'at'>): void;
  supprimerDemande(site: string, appareil: string): void;
}

export interface DepsUsine {
  telecharger(url: string): Promise<Buffer>;
  docker: DockerClient;
  secrets: SecretsStore;
  publication: PublicationUsine;
  /** Dossier de configuration d'ESPHome vu par l'application, et le même vu du conteneur. */
  dossierConfig: string;
  cheminDansConteneur: string;
  conteneur: string;
  /** Racine du dossier partagé (`data/esphome/machine_partage`) et URL publique correspondante (sans « / » final). */
  partage: { dossier: string; url: string };
  revisionsGardees: number;
  surJournal?: (morceau: string) => void;
}

/** `termine` : firmware publié ; `echec` : demande supprimée (refaire « Assembler ») ; `a_reessayer` : demande conservée. */
export type ResultatTraitement = 'termine' | 'echec' | 'a_reessayer';

const FIN_JOURNAL = 3000;

export class FactoryService {
  constructor(private readonly d: DepsUsine) {}

  async traiter(job: Job): Promise<ResultatTraitement> {
    const { publication: pub } = this.d;
    const echec = (detail: string, supprimer = true): ResultatTraitement => {
      pub.statut(job.site, job.appareil, 'echec', { detail });
      if (supprimer) pub.supprimerDemande(job.site, job.appareil);
      return supprimer ? 'echec' : 'a_reessayer';
    };

    // 1. Paquet
    pub.statut(job.site, job.appareil, 'recuperation', { detail: job.paquet });
    let paquet: Buffer;
    try {
      paquet = await this.d.telecharger(job.paquet);
    } catch (e) {
      return echec(`paquet inaccessible : ${(e as Error).message}`, false);
    }
    if (sha256(paquet) !== job.sha256) return echec('somme de contrôle du paquet fausse (téléchargement corrompu ?)', false);

    let manifeste: Manifeste;
    let fichiers;
    try {
      const v = verifierPaquet(lireZip(paquet));
      if (!v.ok) return echec(v.raison);
      manifeste = v.manifeste;
      fichiers = v.fichiers;
    } catch (e) {
      if (e instanceof ZipInvalide) return echec(`paquet illisible : ${e.message}`);
      throw e;
    }
    if (manifeste.appareil !== job.appareil || manifeste.revision !== job.revision) {
      return echec(`le manifeste (${manifeste.appareil} révision ${manifeste.revision}) ne correspond pas à la demande (${job.appareil} révision ${job.revision})`);
    }

    // 2. Dépôt des sources, puis seulement alors suppression de la demande
    try {
      for (const f of fichiers) this.ecrireAtomique(path.join(this.d.dossierConfig, f.chemin), f.contenu);
      this.ecrireAtomique(path.join(this.d.partage.dossier, 'paquets', job.appareil, `r${job.revision}.zip`), paquet);
    } catch (e) {
      return echec(`dépôt des sources impossible : ${(e as Error).message}`, false);
    }
    pub.supprimerDemande(job.site, job.appareil);

    // 3. Clé API (appareil neuf seulement)
    let cleNeuve: string | null;
    try {
      cleNeuve = this.d.secrets.creerSiAbsente(job.appareil);
    } catch (e) {
      return echec(`secrets.yaml inaccessible : ${(e as Error).message}`);
    }

    // 4. Compilation
    pub.statut(job.site, job.appareil, 'compilation');
    let sortie: string;
    try {
      const etat = await this.d.docker.etat(this.d.conteneur);
      if (!etat.existe) return echec(`conteneur ${this.d.conteneur} introuvable`);
      if (!etat.enMarche) await this.d.docker.demarrer(this.d.conteneur);
      const r = await this.d.docker.exec(this.d.conteneur, ['esphome', 'compile', `${this.d.cheminDansConteneur}/${job.appareil}.yaml`], { surSortie: this.d.surJournal });
      sortie = r.sortie;
      if (r.codeSortie !== 0) return echec(`compilation ratée (code ${r.codeSortie}) : …${r.sortie.slice(-FIN_JOURNAL)}`);
    } catch (e) {
      return echec(`ESPHome injoignable : ${(e as Error).message}`);
    }

    // 5. Firmware et tailles
    const dossierBuild = path.join(this.d.dossierConfig, '.esphome', 'build', job.appareil, '.pioenvs', job.appareil);
    const nomFirmware = [job.action === 'amorce' ? 'firmware.factory.bin' : 'firmware.ota.bin', 'firmware.bin'].find((n) => fs.existsSync(path.join(dossierBuild, n)));
    if (!nomFirmware) return echec(`compilation terminée mais aucun firmware trouvé dans ${dossierBuild}`);
    const firmware = fs.readFileSync(path.join(dossierBuild, nomFirmware));

    const mesures: Mesures | null = releverMesures(sortie, firmware.length);
    const avertissements: string[] = [];
    if (!mesures) avertissements.push('occupation RAM / flash non relevée dans la sortie de compilation');
    else {
      const v = controlerTailles(mesures, manifeste.modele.memoire);
      if (!v.ok) return echec(v.raison);
      avertissements.push(...v.avertissements);
    }

    // 6. Publication
    const dossierRev = path.join(this.d.partage.dossier, 'firmwares', job.appareil, String(job.revision));
    const fichierPublie = job.action === 'amorce' ? 'amorce.bin' : 'firmware.bin';
    this.ecrireAtomique(path.join(dossierRev, fichierPublie), firmware);
    this.nettoyer(path.join(this.d.partage.dossier, 'firmwares', job.appareil));

    const detail = avertissements.join(' ; ');
    if (job.action === 'amorce') {
      pub.statut(job.site, job.appareil, 'pret_a_poser', { detail: `amorce prête (flash par USB ou flasheur web)${detail ? ' — ' + detail : ''}`, mesures: mesures ?? undefined });
      return 'termine';
    }
    pub.pose(job.site, job.appareil, {
      site: job.site,
      appareil: job.appareil,
      revision: job.revision,
      firmware: `${this.d.partage.url}/firmwares/${job.appareil}/${job.revision}/firmware.bin`,
      sha256: sha256(firmware),
      tailleOctets: firmware.length,
      esp: manifeste.esp.adresse,
      nomAffichage: manifeste.nomAffichage,
      ...(cleNeuve ? { cle: cleNeuve } : {}),
      options: manifeste.options
    });
    pub.statut(job.site, job.appareil, 'pret_a_poser', { detail, mesures: mesures ?? undefined });
    return 'termine';
  }

  private ecrireAtomique(fichier: string, contenu: Buffer): void {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = `${fichier}.tmp`;
    fs.writeFileSync(tmp, contenu);
    fs.renameSync(tmp, fichier);
  }

  /** Garde les N dernières révisions d'un appareil (dossiers numériques) ; supprime les plus anciennes. */
  private nettoyer(dossierAppareil: string): void {
    if (!fs.existsSync(dossierAppareil)) return;
    const revisions = fs.readdirSync(dossierAppareil).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a);
    for (const r of revisions.slice(this.d.revisionsGardees)) fs.rmSync(path.join(dossierAppareil, String(r)), { recursive: true, force: true });
  }
}
