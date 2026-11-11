/**
 * ⭐ 11/11/2026 (specs ia v1.38 §16.13) — radios à la voix.
 *
 * « mets France Inter », « joue FIP dans la cuisine », « arrête la radio » : reconnu ici sans
 * Mistral (phrase simple) ou par les outils `jouer_radio` / `arreter_radio` (phrase libre). `ia`
 * n'agit pas elle-même sur HA : la commande part à `planificateur` par le canal des actions
 * (`ia:tool:execute`, champ `media` ; specs planificateur v1.13 §8bis). Pas de canal dédié : le cœur ne
 * relit les `bridgedEvents` d'une application qu'à son premier chargement (une application rechargée
 * depuis la racine externe garderait l'ancienne liste jusqu'au redémarrage du cœur).
 *
 * Le lecteur est choisi par une table explicite lieu → `media_player` (configuration `radio`) :
 * la taxonomie ne range pas les lecteurs par lieu de façon fiable (constaté sur ha2 : hasat3 dans
 * « Salle », Chromecast sans lieu), et HA ne dit pas à `ia` quel satellite a parlé.
 */
import { z } from 'zod';
import { CorrelatedRequester } from '../../../core/dist/exports';
import type { IEventBus, Logger } from '../../../core/dist/exports';
import type { CorrelatedReponse } from './types';

export const stationSchema = z.object({
  nom: z.string(),
  /** Autres façons de la nommer (« inter », « franceinfo »…). */
  aussi: z.array(z.string()).default([]),
  /** Adresse du flux (MP3 de préférence : le plus sûr pour les lecteurs ESPHome). */
  flux: z.string()
});

export const DEFAULT_STATIONS: z.infer<typeof stationSchema>[] = [
  { nom: 'France Inter', aussi: ['inter'], flux: 'http://icecast.radiofrance.fr/franceinter-midfi.mp3' },
  { nom: 'France Info', aussi: ['franceinfo', 'info'], flux: 'http://icecast.radiofrance.fr/franceinfo-midfi.mp3' },
  { nom: 'FIP', aussi: [], flux: 'http://icecast.radiofrance.fr/fip-midfi.mp3' },
  { nom: 'RTL', aussi: ['r t l'], flux: 'https://icecast.rtl.fr/rtl-1-44-128' },
  { nom: 'France Musique', aussi: [], flux: 'http://icecast.radiofrance.fr/francemusique-midfi.mp3' },
  { nom: 'Nostalgie', aussi: [], flux: 'https://streaming.nrjaudio.fm/oug7girb92oc?origine=tingfm' }
];

export const radioSchema = z.object({
  /** Lieu utilisé quand la phrase n'en donne pas. */
  lieuDefaut: z.string().default('salon'),
  /** Lieu → entité `media_player`. */
  lecteurs: z.record(z.string()).default({ salon: 'media_player.hasat3' }),
  stations: z.array(stationSchema).default(DEFAULT_STATIONS)
});

export type RadioConfig = z.infer<typeof radioSchema>;
export type Station = z.infer<typeof stationSchema>;

export const DEFAULT_RADIO_CONFIG: RadioConfig = { lieuDefaut: 'salon', lecteurs: { salon: 'media_player.hasat3' }, stations: DEFAULT_STATIONS };

/** minuscules, sans accents ni ponctuation, apostrophes → espace. */
export function normaliser(texte: string): string {
  return texte.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function contientMots(texte: string, mots: string): boolean {
  const m = normaliser(mots);
  return m !== '' && ` ${texte} `.includes(` ${m} `);
}

/** Station nommée dans le texte (déjà normalisé) — le nom le plus long l'emporte. */
export function trouverStation(texte: string, stations: Station[]): Station | undefined {
  let meilleure: { station: Station; longueur: number } | undefined;
  for (const station of stations) {
    for (const nom of [station.nom, ...station.aussi]) {
      const n = normaliser(nom);
      if (contientMots(texte, n) && (!meilleure || n.length > meilleure.longueur)) meilleure = { station, longueur: n.length };
    }
  }
  return meilleure?.station;
}

/** Lieu demandé (« dans la cuisine », « au salon ») parmi les lieux de la table, sinon undefined. */
export function trouverLieu(texte: string, lecteurs: Record<string, string>): string | undefined {
  const m = texte.match(/\b(?:dans|au)\b(?: (?:le|la|l|les))? (.+)$/);
  if (!m) return undefined;
  const queue = m[1];
  const lieux = Object.keys(lecteurs).sort((a, b) => normaliser(b).length - normaliser(a).length);
  return lieux.find((lieu) => contientMots(queue, lieu)) ?? queue;
}

export interface CommandeRadio {
  action: 'jouer' | 'arreter';
  station?: Station;
  /** Lieu nommé dans la phrase (peut ne pas être dans la table → refus clair). */
  lieu?: string;
}

const VERBES_JOUER = /^(?:mets|met|mettre|remets|joue|jouer|lance|lancer|ecoute|ecouter|passe|passer|allume)\b/;
const VERBES_ARRETER = /^(?:arrete|arreter|coupe|couper|stop|stoppe|stopper|eteins|eteindre)\b/;
const OBJET_ARRET = /\b(?:radio|musique|lecture|son)\b/;

/** Reconnaît une commande radio simple ; `undefined` sinon (la phrase suit son chemin habituel). */
export function reconnaitreCommandeRadio(question: string, config: RadioConfig): CommandeRadio | undefined {
  const texte = normaliser(question);
  if (texte === 'stop' || (VERBES_ARRETER.test(texte) && OBJET_ARRET.test(texte))) {
    return { action: 'arreter', lieu: trouverLieu(texte, config.lecteurs) };
  }
  if (VERBES_JOUER.test(texte)) {
    const station = trouverStation(texte, config.stations);
    if (station) return { action: 'jouer', station, lieu: trouverLieu(texte, config.lecteurs) };
  }
  return undefined;
}

interface MediaPlayRequest {
  /** Champs d'`executer_action` (canal partagé) — ignorés par planificateur quand `media` est présent. */
  verbe: string;
  quoi: string;
  lieux: string[];
  media: { entity_id: string; action: 'jouer' | 'arreter'; media_url?: string; titre?: string };
}

/** Exécution par `planificateur` (`ia:media:play`) et phrases parlées. */
export class RadioService {
  private readonly requester: CorrelatedRequester<MediaPlayRequest, CorrelatedReponse>;

  constructor(
    eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly getConfig: () => RadioConfig,
    private readonly timeoutMs: number
  ) {
    this.requester = new CorrelatedRequester<MediaPlayRequest, CorrelatedReponse>(eventBus, 'ia:tool:execute', 'ia:tool:execute:reply');
  }

  private lecteur(lieu?: string): { lieu: string; entityId?: string } {
    const config = this.getConfig();
    const voulu = lieu ?? config.lieuDefaut;
    const cle = Object.keys(config.lecteurs).find((l) => normaliser(l) === normaliser(voulu));
    return { lieu: cle ?? voulu, entityId: cle ? config.lecteurs[cle] : undefined };
  }

  stationsConnues(): string[] {
    return this.getConfig().stations.map((s) => s.nom);
  }

  /** `station` : nom libre (outil Mistral) ou station déjà reconnue. */
  async jouer(station: string | Station, lieu?: string): Promise<{ success: boolean; message: string }> {
    const s = typeof station === 'string' ? trouverStation(normaliser(station), this.getConfig().stations) : station;
    if (!s) return { success: false, message: `Je ne connais pas la radio « ${station} ». Radios connues : ${this.stationsConnues().join(', ')}.` };
    const { lieu: l, entityId } = this.lecteur(lieu);
    if (!entityId) return { success: false, message: `Je n'ai pas de lecteur dans « ${l} ».` };
    const reply = await this.envoyer({ entity_id: entityId, action: 'jouer', media_url: s.flux, titre: s.nom });
    return reply.success ? { success: true, message: `Je mets ${s.nom} dans ${articleLieu(l)}.` } : { success: false, message: `Je n'ai pas pu mettre ${s.nom} : ${reply.message}` };
  }

  async arreter(lieu?: string): Promise<{ success: boolean; message: string }> {
    const { lieu: l, entityId } = this.lecteur(lieu);
    if (!entityId) return { success: false, message: `Je n'ai pas de lecteur dans « ${l} ».` };
    const reply = await this.envoyer({ entity_id: entityId, action: 'arreter' });
    return reply.success ? { success: true, message: `J'arrête la radio dans ${articleLieu(l)}.` } : { success: false, message: `Je n'ai pas pu arrêter la radio : ${reply.message}` };
  }

  private async envoyer(media: MediaPlayRequest['media']): Promise<{ success: boolean; message: string }> {
    try {
      const reply = await this.requester.request({ verbe: media.action, quoi: 'radio', lieux: [], media }, this.timeoutMs);
      return { success: reply.success, message: reply.message };
    } catch (error) {
      this.logger.error('RadioService', `planificateur ne répond pas (ia:tool:execute, media) : ${error}`);
      return { success: false, message: 'planificateur ne répond pas' };
    }
  }
}

/** « le salon », « la cuisine », « l'entrée » — article approximatif pour la phrase parlée. */
function articleLieu(lieu: string): string {
  const n = normaliser(lieu);
  if (/^[aeiouhy]/.test(n)) return `l'${lieu}`;
  if (/(?:e|ie|tion|ere)$/.test(n) && !/(?:salon|garage|bureau)$/.test(n)) return `la ${lieu}`;
  return `le ${lieu}`;
}
