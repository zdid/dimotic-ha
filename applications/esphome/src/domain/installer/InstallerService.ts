/**
 * Poseur — traitement d'UN message de pose (fonctionnelles-esphome_specs §6.1) :
 * récupération du firmware (somme de contrôle et taille) → envoi à l'ESP par OTA → déclaration dans HA si l'appareil est neuf
 * → vérification (la version du firmware dans HA change) → suppression du message de pose.
 *
 * Dépendances injectées (téléchargement, OTA, HA, publication, attente) : logique testée sans réseau ni ESP.
 */

import type { Pose, Etat, Status } from '../messages';
import { sha256 } from '../factory/manifest';
import { OtaError, type OptionsOta, type ResultatOta } from './OtaClient';
import { HaDeclarer, ErreurHa, type CibleAppareil } from './HaDeclarer';
import type { ResultatTraitement } from '../factory/FactoryService';

export interface PublicationPoseur {
  statut(site: string, appareil: string, etat: Etat, extra?: Partial<Pick<Status, 'detail' | 'versionFirmware'>>): void;
  supprimerPose(site: string, appareil: string): void;
}

export interface DepsPoseur {
  telecharger(url: string): Promise<Buffer>;
  ota(options: OptionsOta): Promise<ResultatOta>;
  ha: HaDeclarer;
  publication: PublicationPoseur;
  motDePasseOta: string;
  /** Attente (injectable) ; la vérification interroge HA toutes les `intervalleVerifMs` pendant `delaiVerifMs` au plus. */
  attendre(ms: number): Promise<void>;
  intervalleVerifMs: number;
  delaiVerifMs: number;
}

export class InstallerService {
  constructor(private readonly d: DepsPoseur) {}

  async traiter(pose: Pose): Promise<ResultatTraitement> {
    const { publication: pub } = this.d;
    const echec = (detail: string, supprimer = true): ResultatTraitement => {
      pub.statut(pose.site, pose.appareil, 'echec', { detail });
      if (supprimer) pub.supprimerPose(pose.site, pose.appareil);
      return supprimer ? 'echec' : 'a_reessayer';
    };
    const cible: CibleAppareil = { appareil: pose.appareil, nomAffichage: pose.nomAffichage, adresse: pose.esp };

    // 1. Firmware
    pub.statut(pose.site, pose.appareil, 'recuperation', { detail: pose.firmware });
    let firmware: Buffer;
    try {
      firmware = await this.d.telecharger(pose.firmware);
    } catch (e) {
      return echec(`firmware inaccessible : ${(e as Error).message}`, false);
    }
    if (firmware.length !== pose.tailleOctets) return echec(`taille reçue ${firmware.length} octets au lieu de ${pose.tailleOctets} (téléchargement incomplet ?)`, false);
    if (sha256(firmware) !== pose.sha256) return echec('somme de contrôle du firmware fausse (téléchargement corrompu ?)', false);

    // 2. État de l'appareil dans HA AVANT l'envoi (version actuelle du firmware)
    let avant;
    try {
      avant = await this.d.ha.etat(cible);
    } catch (e) {
      return echec(`Home Assistant injoignable : ${(e as Error).message}`, false);
    }

    // 3. Envoi à l'ESP
    pub.statut(pose.site, pose.appareil, 'envoi', { detail: `${pose.esp}:${pose.portOta}` });
    try {
      await this.d.ota({ hote: pose.esp, port: pose.portOta, motDePasse: this.d.motDePasseOta, firmware });
    } catch (e) {
      if (e instanceof OtaError && /connexion|fermée|délai|injoignable|impossible/i.test(e.message)) return echec(`ESP injoignable : ${e.message}`, false);
      return echec(`envoi refusé par l'ESP : ${(e as Error).message}`);
    }

    // 4. Déclaration dans HA (appareil neuf seulement)
    pub.statut(pose.site, pose.appareil, 'verification');
    if (!avant.entree) {
      try {
        await this.d.ha.declarer({ adresse: pose.esp, portApi: pose.portApi, cle: pose.cle, autoriserAppelsService: pose.options.autoriserAppelsService });
      } catch (e) {
        return echec(`firmware envoyé, mais déclaration dans HA impossible : ${(e as Error).message}`, !(e instanceof ErreurHa) ? false : true);
      }
    }

    // 5. Vérification : la version du firmware dans HA change (date de compilation)
    const versionAvant = avant.appareil?.sw_version ?? null;
    const debut = Date.now();
    let derniere: string | null = null;
    for (let n = 0; ; n++) {
      await this.d.attendre(this.d.intervalleVerifMs);
      try {
        const apres = await this.d.ha.etat(cible);
        derniere = apres.appareil?.sw_version ?? null;
        if (apres.entree && derniere && (versionAvant === null || derniere !== versionAvant)) {
          pub.statut(pose.site, pose.appareil, 'termine', { detail: '', versionFirmware: derniere });
          pub.supprimerPose(pose.site, pose.appareil);
          return 'termine';
        }
      } catch { /* HA momentanément indisponible : on réessaie */ }
      if ((n + 1) * this.d.intervalleVerifMs >= this.d.delaiVerifMs || Date.now() - debut > this.d.delaiVerifMs * 10) break;
    }
    return echec(
      derniere && derniere === versionAvant
        ? `le firmware n'a pas changé dans HA (version ${derniere}) : l'envoi a abouti mais l'ESP n'a pas redémarré sur le nouveau firmware`
        : "l'appareil n'est pas revenu dans HA après l'envoi"
    );
  }
}
