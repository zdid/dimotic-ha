/**
 * Vérification des références d'entités (outil MCP `verifier_entity_ids`, LECTURE SEULE) : parcourt les automatisations, scripts, scènes,
 * tableaux de bord, la configuration Énergie et les plans, et liste les `entity_id` cités qui N'EXISTENT PLUS dans HA (ni dans les états,
 * ni dans le registre des entités — une entité désactivée existe), avec la ou les entités existantes les plus proches.
 *
 * Aucun accès à `.storage` : tout passe par les commandes WebSocket / REST de HA et par les clients déjà existants.
 */

import type { HaBridgeClient } from '../../../core/dist/exports';
import type { HaAutomationClient } from './HaAutomationClient';
import type { HaTableauClient } from './HaTableauClient';

type Ha = Pick<HaBridgeClient, 'callWs' | 'callRest' | 'getAllEntities'>;

/** Domaines d'entités reconnus (un mot suivi d'un point n'est une entité que si son domaine est dans cette liste). */
export const DOMAINES = new Set([
  'light', 'sensor', 'binary_sensor', 'switch', 'climate', 'cover', 'fan', 'lock', 'media_player', 'number', 'select', 'text', 'button',
  'input_boolean', 'input_number', 'input_text', 'input_select', 'input_datetime', 'input_button', 'counter', 'timer', 'schedule',
  'automation', 'script', 'scene', 'person', 'device_tracker', 'weather', 'sun', 'update', 'vacuum', 'camera', 'siren', 'event',
  'humidifier', 'water_heater', 'alarm_control_panel', 'calendar', 'todo', 'zone', 'group', 'valve', 'lawn_mower', 'notify', 'tts',
  'conversation', 'image', 'remote', 'wake_word', 'stt'
]);

/** Types d'événements (pas des entités) qui ressemblent à `domaine.nom`. */
const EVENEMENTS = new Set(['timer.finished', 'timer.started', 'timer.cancelled', 'timer.paused', 'timer.restarted', 'script.started', 'automation.triggered', 'automation.reloaded']);

export interface Citations { entites: string[]; services: string[]; appareils: string[]; pieces: string[]; ambigus: string[] }

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * Éléments cités dans un objet (config d'automatisation, de tableau…) :
 *  - entités `domaine.nom` (en texte, déclencheurs, cibles, modèles) — services, événements et débuts de noms construits (`timer.minuterie_`) exclus ;
 *  - services (valeur des clés `action` / `service`) ;
 *  - appareils (`device_id`, 32 caractères hexadécimaux) et pièces (`area_id`).
 */
export function extraireCitations(objet: unknown, services: Set<string> = new Set()): Citations {
  const entites = new Set<string>(); const ambigus = new Set<string>(); const svc = new Set<string>(); const appareils = new Set<string>(); const pieces = new Set<string>();
  const texte = (t: string): void => {
    for (const m of t.replace(/states\./g, '').matchAll(/(?<![A-Za-z0-9_.])([a-z_]+)\.([a-z0-9_]+)(?![A-Za-z0-9_(])/g)) {
      const [complet, domaine] = m;
      if (!DOMAINES.has(domaine) || services.has(complet) || EVENEMENTS.has(complet) || complet.endsWith('_')) continue;
      // `notify.*` et `tts.*` peuvent être un SERVICE (application mobile : notify.mobile_app_x) OU une ENTITÉ (groupe de notification
      // créé dans l'interface : notify.administrateurs, utilisé avec notify.send_message) : classés à part, vérifiés contre les deux.
      if (domaine === 'notify' || domaine === 'tts') ambigus.add(complet);
      else entites.add(complet);
    }
  };
  const parcourir = (v: unknown, cle?: string): void => {
    if (typeof v === 'string') {
      if ((cle === 'action' || cle === 'service') && /^[a-z_]+\.[a-z0-9_]+$/.test(v)) svc.add(v);
      else if (cle === 'device_id' && HEX32.test(v)) appareils.add(v);
      else if (cle === 'area_id') pieces.add(v);
      else texte(v);
    } else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string' && cle === 'device_id' && HEX32.test(x)) appareils.add(x);
        else if (typeof x === 'string' && cle === 'area_id') pieces.add(x);
        else parcourir(x, cle);
      }
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) parcourir(x, k);
    }
  };
  parcourir(objet);
  return { entites: [...entites].sort(), services: [...svc].sort(), appareils: [...appareils].sort(), pieces: [...pieces].sort(), ambigus: [...ambigus].sort() };
}

/** Entités citées (compatibilité : voir extraireCitations). */
export function extraireEntityIds(objet: unknown, services: Set<string> = new Set()): string[] {
  return extraireCitations(objet, services).entites;
}

function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Au plus 2 entités existantes du même domaine, proches de l'identifiant manquant (distance d'édition ≤ 30 % de sa longueur). */
export function suggerer(manquant: string, existants: string[]): string[] {
  const domaine = manquant.split('.')[0];
  const seuil = Math.max(4, Math.round(manquant.length * 0.3));
  return existants
    .filter((e) => e.startsWith(`${domaine}.`))
    .map((e) => ({ e, d: distance(manquant, e) }))
    .filter((x) => x.d <= seuil)
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((x) => x.e);
}

/** Message lisible d'une erreur de HA (objet `{code, message}` ou Error). */
export function messageErreur(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') { const o = e as { message?: string; code?: string }; return o.message ?? o.code ?? JSON.stringify(e); }
  return String(e);
}

export interface Manquant { type: 'entité' | 'entité orpheline' | 'service' | 'appareil' | 'pièce'; id: string; suggestions: string[] }
export interface RapportSource { source: string; nom?: string; manquants: Manquant[] }

export class HaReferencesClient {
  constructor(
    private readonly ha: Ha,
    private readonly automations: Pick<HaAutomationClient, 'list' | 'get'>,
    private readonly tableaux: Pick<HaTableauClient, 'lire' | 'lireEnergie'>
  ) {}

  /**
   * `ids` = entités qui existent (états OU registre) ; `orphelines` = entités du registre, non désactivées, SANS état dans HA (ex. un
   * appareil supprimé dont l'entrée de registre subsiste) : citées, elles ne répondent plus jamais.
   */
  private async existants(): Promise<{ ids: Set<string>; liste: string[]; orphelines: Set<string> }> {
    const etats = new Set<string>(this.ha.getAllEntities().map((e) => e.entity_id));
    const ids = new Set<string>(etats);
    const orphelines = new Set<string>();
    try {
      const reg = (await this.ha.callWs({ type: 'config/entity_registry/list' }, 30000)) as Array<{ entity_id: string; disabled_by?: string | null }>;
      for (const e of reg) {
        ids.add(e.entity_id);
        if (!etats.has(e.entity_id) && !e.disabled_by) orphelines.add(e.entity_id);
      }
    } catch { /* le cache des états seul */ }
    return { ids, liste: [...etats], orphelines };
  }

  /** Identifiants d'appareils et de pièces existants (registres de HA). */
  private async registres(): Promise<{ appareils: Set<string> | null; pieces: Set<string> | null }> {
    const lire = async (type: string, cle: string): Promise<Set<string> | null> => {
      try {
        const r = (await this.ha.callWs({ type }, 30000)) as Array<Record<string, string>> | { areas: Array<Record<string, string>> };
        const liste = Array.isArray(r) ? r : r.areas ?? [];
        return new Set(liste.map((x) => x[cle]).filter(Boolean));
      } catch { return null; }
    };
    return { appareils: await lire('config/device_registry/list', 'id'), pieces: await lire('config/area_registry/list', 'area_id') };
  }

  private async services(): Promise<Set<string>> {
    const sortie = new Set<string>();
    try {
      const s = (await this.ha.callWs({ type: 'get_services' }, 30000)) as Record<string, Record<string, unknown>>;
      for (const [domaine, svc] of Object.entries(s)) for (const nom of Object.keys(svc)) sortie.add(`${domaine}.${nom}`);
    } catch { /* heuristique seule */ }
    return sortie;
  }

  async verifier(portee: string[] = ['automatisations', 'scripts', 'scenes', 'tableaux', 'energie', 'plans']): Promise<unknown> {
    const { ids, liste, orphelines } = await this.existants();
    const services = await this.services();
    const reg = await this.registres();
    const rapports: RapportSource[] = [];
    const erreurs: string[] = [];
    const examiner = (source: string, nom: string | undefined, objet: unknown): void => {
      const c = extraireCitations(objet, services);
      const manquants: Manquant[] = [
        ...c.entites.filter((e) => !ids.has(e)).map((e) => ({ type: 'entité' as const, id: e, suggestions: suggerer(e, liste) })),
        ...c.entites.filter((e) => orphelines.has(e)).map((e) => ({ type: 'entité orpheline' as const, id: e, suggestions: suggerer(e, liste) })),
        // Un service cité qui n'existe plus (intégration retirée, application mobile renommée…) : seulement si la liste des services est connue.
        // notify.* : manquant seulement s'il n'est NI une entité NI un service
        ...c.ambigus.filter((x) => !ids.has(x) && !services.has(x)).map((x) => ({ type: 'service' as const, id: x, suggestions: suggerer(x, [...services, ...liste]) })),
        ...(services.size ? c.services.filter((x) => !services.has(x)).map((x) => ({ type: 'service' as const, id: x, suggestions: suggerer(x, [...services]) })) : []),
        ...(reg.appareils ? c.appareils.filter((x) => !reg.appareils!.has(x)).map((x) => ({ type: 'appareil' as const, id: x, suggestions: [] })) : []),
        ...(reg.pieces ? c.pieces.filter((x) => !reg.pieces!.has(x)).map((x) => ({ type: 'pièce' as const, id: x, suggestions: [] })) : [])
      ];
      if (manquants.length) rapports.push({ source, nom, manquants });
    };
    let examines = 0;

    if (portee.includes('automatisations')) {
      for (const a of this.automations.list()) {
        if (!a.id) continue;
        const def = await this.automations.get(a.id);
        if (!def.ok) { erreurs.push(`automatisation ${a.id} : ${def.error}`); continue; }
        examines++; examiner(`automatisation ${a.id}`, a.alias, def.config);
      }
    }
    for (const [cle, domaine] of [['scripts', 'script'], ['scenes', 'scene']] as const) {
      if (!portee.includes(cle)) continue;
      for (const e of this.ha.getAllEntities().filter((x) => x.entity_id.startsWith(`${domaine}.`))) {
        const idConfig = domaine === 'script' ? e.entity_id.split('.')[1] : String(e.attributes?.id ?? '');
        if (!idConfig) continue;
        try {
          const r = await this.ha.callRest('GET', `/api/config/${domaine}/config/${idConfig}`);
          examines++; examiner(`${domaine} ${idConfig}`, e.friendly_name, r.body);
        } catch (err) { erreurs.push(`${domaine} ${idConfig} : ${messageErreur(err)}`); }
      }
    }
    if (portee.includes('tableaux')) {
      try {
        const liste = (await this.tableaux.lire(undefined)) as { tableaux: Array<{ url_path: string | null; title?: string }> };
        for (const t of liste.tableaux) {
          const c = (await this.tableaux.lire(t.url_path ?? '')) as { existe?: boolean; config?: unknown };
          if (c.existe && c.config) { examines++; examiner(`tableau ${t.url_path ?? '(par défaut)'}`, t.title, c.config); }
        }
      } catch (err) { erreurs.push(`tableaux : ${messageErreur(err)}`); }
    }
    if (portee.includes('energie')) {
      try { examines++; examiner('configuration Énergie', undefined, await this.tableaux.lireEnergie()); } catch (err) { erreurs.push(`énergie : ${messageErreur(err)}`); }
    }
    if (portee.includes('plans')) {
      try {
        const p = await this.ha.callWs({ type: 'dimotic_plans/floorplans/list' }, 30000);
        examines++; examiner('plans (Plans)', undefined, p);
      } catch { /* intégration Plans absente : ignoré */ }
    }

    return {
      entites_connues: ids.size,
      sources_examinees: examines,
      sources_avec_problemes: rapports.length,
      references_manquantes: rapports.reduce((n, r) => n + r.manquants.length, 0),
      rapports,
      ...(erreurs.length ? { erreurs_de_lecture: erreurs } : {}),
      note: "Lecture seule. Vérifie les entités, les services (clés action/service), les appareils (device_id) et les pièces (area_id). Une entité est « manquante » si elle n'est ni dans les états ni dans le registre de HA (une entité désactivée existe). « Entité orpheline » = présente dans le registre mais sans état dans HA (ne répond plus jamais). Les suggestions sont les entités existantes les plus proches : à confirmer avant de corriger. Faux positifs possibles : texte libre contenant « domaine.nom » dans une description."
    };
  }
}
