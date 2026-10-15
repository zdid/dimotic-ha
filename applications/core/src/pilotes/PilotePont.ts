/**
 * PilotePont — côté APPLICATION du canal « gestion des pilotes » (conception-gestion-pilotes_specs v1.1 §5).
 *
 * Une application pilote (arexx, rfxcom, rpigpio, zigbee2mqtt, testcycle…) crée un `PilotePont` par pont qu'elle
 * porte, lui donne un `PiloteGestionnaire` (ce qu'elle sait lister/modifier) et c'est tout : annonce de présence,
 * filtrage des requêtes, aperçu puis application avec jeton, erreurs et réponses sont gérés ici, identiques pour
 * tous les pilotes.
 */

import type { IEventBus } from '../application/IEventBus';
import type { Logger } from '../infrastructure/logger/index';
import {
  PILOTES_EVENTS,
  estOrdreModifiant,
  jetonApercu,
  type PiloteReponse,
  type PiloteRequete,
  type PiloteRequeteEvenement
} from './types';

export interface PiloteGestionnaire {
  /** `lister` ou `decouverts` : ne modifie rien. */
  lire(ordre: 'lister' | 'decouverts', parametres: Record<string, unknown>): Promise<unknown>;
  /**
   * Prépare un ordre modifiant SANS rien changer : `apercu` = ce qui sera fait (avant/après, entités HA touchées…),
   * `etat` = empreinte de l'état courant concerné (le jeton en est tiré : s'il change, l'ordre réel est refusé).
   */
  preparer(ordre: string, parametres: Record<string, unknown>): Promise<{ apercu: unknown; etat: unknown }>;
  /** Applique réellement (sauvegarde automatique faite par le pilote ; son chemin est renvoyé). */
  appliquer(ordre: string, parametres: Record<string, unknown>): Promise<{ resultat?: unknown; sauvegarde?: string }>;
}

export interface PilotePontOptions {
  appId: string;
  pont: string;
  type: string;
  version?: string;
  capacites: string[];
  gestionnaire: PiloteGestionnaire;
}

export class PilotePont {
  private actif = false;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly options: PilotePontOptions
  ) {}

  start(): void {
    if (this.actif) return;
    this.actif = true;
    this.eventBus.onGeneric<PiloteRequeteEvenement>(PILOTES_EVENTS.REQUETE, (data) => {
      if (!this.actif || !data || data.appId !== this.options.appId || data.requete?.pont !== this.options.pont) return;
      void this.traiter(data.requete);
    });
    this.eventBus.onGeneric(PILOTES_EVENTS.PRESENCE_DEMANDE, () => {
      if (this.actif) this.annoncer('en_ligne');
    });
    this.annoncer('en_ligne');
  }

  stop(): void {
    if (!this.actif) return;
    this.annoncer('hors_ligne');
    this.actif = false;
  }

  private annoncer(etat: 'en_ligne' | 'hors_ligne'): void {
    const { appId, pont, type, version, capacites } = this.options;
    this.eventBus.emitGeneric(PILOTES_EVENTS.PRESENCE, {
      appId,
      presence: { pont, type, version, capacites, etat }
    });
  }

  private repondre(requete: PiloteRequete, partiel: Partial<PiloteReponse>): void {
    const reponse: PiloteReponse = { id: requete.id, pont: requete.pont, ok: false, ...partiel };
    this.eventBus.emitGeneric(PILOTES_EVENTS.REPONSE, { reponse });
  }

  private erreur(requete: PiloteRequete, code: string, message: string): void {
    this.repondre(requete, { ok: false, erreur: { code, message } });
  }

  private async traiter(requete: PiloteRequete): Promise<void> {
    const { gestionnaire, capacites, pont } = this.options;
    const parametres = requete.parametres ?? {};
    try {
      if (!capacites.includes(requete.ordre)) {
        this.erreur(requete, 'ordre_non_declare', `Le pont ${pont} ne déclare pas l'ordre « ${requete.ordre} »`);
        return;
      }
      if (!estOrdreModifiant(requete.ordre)) {
        const resultat = await gestionnaire.lire(requete.ordre as 'lister' | 'decouverts', parametres);
        this.repondre(requete, { ok: true, resultat });
        return;
      }

      const prep = await gestionnaire.preparer(requete.ordre, parametres);
      const jeton = jetonApercu(pont, requete.ordre, parametres, prep.etat);
      if (requete.apercu) {
        this.repondre(requete, { ok: true, apercu: prep.apercu, jeton });
        return;
      }
      if (!requete.jeton) {
        this.erreur(requete, 'jeton_requis', "Demande d'abord l'aperçu (apercu: true) puis rejoue l'ordre avec son jeton");
        return;
      }
      if (requete.jeton !== jeton) {
        this.erreur(requete, 'etat_change', "L'état a changé depuis l'aperçu : refais l'aperçu");
        return;
      }
      const fait = await gestionnaire.appliquer(requete.ordre, parametres);
      this.logger.info('PilotePont', `${pont} : ${requete.ordre} appliqué (requête ${requete.id}${requete.emetteur ? `, de ${requete.emetteur}` : ''})`);
      this.repondre(requete, { ok: true, resultat: fait.resultat, sauvegarde: fait.sauvegarde });
    } catch (error) {
      this.logger.warn('PilotePont', `${pont} : ${requete.ordre} en erreur : ${error instanceof Error ? error.message : String(error)}`);
      this.erreur(requete, 'erreur_pilote', error instanceof Error ? error.message : String(error));
    }
  }
}
