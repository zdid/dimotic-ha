// src/ha/sync/DeviceAreaAssigner.ts
// Maintient l'affectation d'un appareil MQTT à la pièce déduite de son NOM (lieu de la taxonomie), à CHAQUE passage.
//
// Pourquoi : `device.suggested_area` n'est appliquée par HA qu'à la CRÉATION de l'appareil. Un appareil dont le lieu change
// ensuite (renommage, correction) ou qui a été créé dans une pièce provisoire y reste indéfiniment. Ce service compare la
// pièce réelle de l'appareil dans HA à la pièce attendue et la corrige par la WebSocket (`config/device_registry/update`).
// Le NOM est donc la source de vérité (comme le rappelle fonctionnelles-nommage) ; une affectation manuelle contraire est
// rétablie au passage suivant d'une découverte (démarrage, HA en ligne, republication).
//
// Jamais bloquant pour la publication de la découverte : les demandes sont mises en file et traitées par lot (un seul
// `device_registry/list` pour toutes). Un appareil pas encore connu de HA (première découverte) est retenté quelques fois ;
// à la création, c'est de toute façon `suggested_area` qui l'affecte.

import type { HaWsClient } from './HaWsClient';
import type { Logger } from '../../infrastructure/logger/index';

type Ws = Pick<HaWsClient, 'callWs'>;

interface Device { id: string; name?: string | null; name_by_user?: string | null; area_id?: string | null; identifiers?: Array<[string, string]> }
interface Area { area_id: string; name: string }
interface Demande { identifiers: string[]; areaName: string; essais: number }

const DELAI_LOT_MS = 4000;
const MAX_ESSAIS = 3;
/** Une même demande identique n'est pas revérifiée avant ce délai. */
const REVERIFICATION_MS = 10 * 60 * 1000;
/** Réconciliation périodique des appareils (hors MQTT compris) dont le NOM suit la convention `quoi---précis--lieu…`. */
const RECONCILIATION_DELAI_MS = 60 * 1000;
const RECONCILIATION_PERIODE_MS = 10 * 60 * 1000;

/** Lieu (pièce) lu dans un nom `quoi---[précis--]lieu[--père[--grand-père]]` ; null si le nom ne suit pas la convention. */
export function lieuDuNom(nom: string): string | null {
  const i = nom.indexOf('---');
  if (i < 0) return null;
  const segments = nom.slice(i + 3).split('--').map((x) => x.trim()).filter(Boolean);
  if (!segments.length) return null;
  return (segments.length === 1 ? segments[0] : segments[1]) ?? null;
}

export class DeviceAreaAssigner {
  private readonly file = new Map<string, Demande>();
  private readonly dernieres = new Map<string, { areaName: string; quand: number }>();
  private minuteur?: NodeJS.Timeout;
  private reconciliation?: NodeJS.Timeout;
  private readonly piecesAbsentesTracees = new Set<string>();

  constructor(
    private readonly ha: Ws,
    private readonly logger: Logger,
    private readonly maintenant: () => number = () => Date.now(),
    private readonly delaiLotMs = DELAI_LOT_MS
  ) {}

  /** `identifiers` : identifiants MQTT de l'appareil (device.identifiers de la découverte) ; `areaName` : pièce attendue. */
  request(identifiers: unknown, areaName: string): void {
    const ids = (Array.isArray(identifiers) ? identifiers : [identifiers]).filter((x): x is string => typeof x === 'string' && x.length > 0);
    const nom = areaName.trim();
    if (!ids.length || !nom) return;
    const cle = ids.join('|');
    const derniere = this.dernieres.get(cle);
    if (derniere && derniere.areaName === nom && this.maintenant() - derniere.quand < REVERIFICATION_MS) return;
    this.dernieres.set(cle, { areaName: nom, quand: this.maintenant() });
    this.file.set(cle, { identifiers: ids, areaName: nom, essais: 0 });
    this.programmer();
  }

  stop(): void {
    if (this.minuteur) clearTimeout(this.minuteur);
    this.minuteur = undefined;
    if (this.reconciliation) clearInterval(this.reconciliation);
    this.reconciliation = undefined;
  }

  /**
   * Contrôle périodique de TOUS les appareils de HA dont le nom suit la convention (appareils d'intégrations natives
   * renommés par l'utilisateur ou par l'agent, qui ne passent jamais par une découverte MQTT) : leur pièce doit être le
   * lieu du nom. Le nom reste la source de vérité. Une pièce absente de HA n'est pas créée (ignorée, tracée).
   */
  demarrerReconciliation(delaiMs = RECONCILIATION_DELAI_MS, periodeMs = RECONCILIATION_PERIODE_MS): void {
    if (this.reconciliation) return;
    const premier = setTimeout(() => { void this.reconcilierNoms(); }, delaiMs);
    premier.unref?.();
    this.reconciliation = setInterval(() => { void this.reconcilierNoms(); }, periodeMs);
    this.reconciliation.unref?.();
  }

  /** Une passe de réconciliation (publique pour les essais). Ne lève jamais. Retourne le nombre d'appareils corrigés. */
  async reconcilierNoms(): Promise<number> {
    let appareils: Device[];
    let pieces: Area[];
    try {
      appareils = (await this.ha.callWs({ type: 'config/device_registry/list' })) as Device[];
      const brut = (await this.ha.callWs({ type: 'config/area_registry/list' })) as Area[] | { areas: Area[] };
      pieces = Array.isArray(brut) ? brut : brut.areas ?? [];
    } catch (e) {
      this.logger.debug('DeviceAreaAssigner', `Réconciliation : registres HA illisibles : ${e instanceof Error ? e.message : e}`);
      return 0;
    }
    let corriges = 0;
    for (const appareil of appareils) {
      const nom = (appareil.name_by_user ?? appareil.name ?? '').trim();
      const lieu = lieuDuNom(nom);
      if (!lieu) continue;
      const piece = pieces.find((p) => p.name.trim().toLowerCase() === lieu.toLowerCase());
      if (!piece) {
        if (!this.piecesAbsentesTracees.has(lieu.toLowerCase())) {
          this.piecesAbsentesTracees.add(lieu.toLowerCase());
          this.logger.info('DeviceAreaAssigner', `Réconciliation : pièce « ${lieu} » absente de HA (appareil « ${nom} ») — non créée, à créer dans HA`);
        }
        continue;
      }
      if (appareil.area_id === piece.area_id) continue;
      const avant = pieces.find((p) => p.area_id === appareil.area_id)?.name ?? 'aucune';
      try {
        await this.ha.callWs({ type: 'config/device_registry/update', device_id: appareil.id, area_id: piece.area_id });
        corriges++;
        this.logger.info('DeviceAreaAssigner', `Réconciliation : appareil « ${nom} » : pièce ${avant} → ${piece.name}`);
      } catch (e) {
        this.logger.warn('DeviceAreaAssigner', `Réconciliation : « ${nom} » vers ${piece.name} refusée : ${e instanceof Error ? e.message : e}`);
      }
    }
    return corriges;
  }

  private programmer(): void {
    if (this.minuteur || this.delaiLotMs < 0) return;
    this.minuteur = setTimeout(() => { this.minuteur = undefined; void this.traiter(); }, this.delaiLotMs);
    this.minuteur.unref?.();
  }

  /** Traite la file (appelée par le minuteur ; publique pour les essais). Ne lève jamais. */
  async traiter(): Promise<void> {
    if (this.file.size === 0) return;
    const lot = [...this.file.entries()];
    this.file.clear();
    let appareils: Device[];
    let pieces: Area[];
    try {
      appareils = (await this.ha.callWs({ type: 'config/device_registry/list' })) as Device[];
      const brut = (await this.ha.callWs({ type: 'config/area_registry/list' })) as Area[] | { areas: Area[] };
      pieces = Array.isArray(brut) ? brut : brut.areas ?? [];
    } catch (e) {
      this.logger.debug('DeviceAreaAssigner', `Lecture des registres HA impossible, lot abandonné : ${e instanceof Error ? e.message : e}`);
      for (const [cle] of lot) this.dernieres.delete(cle); // à reprendre au prochain passage
      return;
    }

    for (const [cle, d] of lot) {
      const appareil = appareils.find((x) => (x.identifiers ?? []).some(([domaine, id]) => domaine === 'mqtt' && d.identifiers.includes(id)));
      if (!appareil) {
        // Pas (encore) connu de HA : la création le placera via suggested_area ; on retente quelques fois.
        if (d.essais + 1 < MAX_ESSAIS) { this.file.set(cle, { ...d, essais: d.essais + 1 }); this.programmer(); }
        continue;
      }
      const piece = pieces.find((p) => p.name.trim().toLowerCase() === d.areaName.toLowerCase());
      if (!piece) { this.logger.debug('DeviceAreaAssigner', `Pièce « ${d.areaName} » absente de HA : affectation ignorée`); continue; }
      if (appareil.area_id === piece.area_id) continue;
      const avant = pieces.find((p) => p.area_id === appareil.area_id)?.name ?? 'aucune';
      try {
        await this.ha.callWs({ type: 'config/device_registry/update', device_id: appareil.id, area_id: piece.area_id });
        this.logger.info('DeviceAreaAssigner', `Appareil « ${appareil.name_by_user ?? appareil.name ?? appareil.id} » : pièce ${avant} → ${piece.name}`);
      } catch (e) {
        this.logger.warn('DeviceAreaAssigner', `Affectation de « ${appareil.name ?? appareil.id} » à ${piece.name} refusée : ${e instanceof Error ? e.message : e}`);
        this.dernieres.delete(cle);
      }
    }
  }
}
