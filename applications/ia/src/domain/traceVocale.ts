/**
 * ⭐ 12/11/2026 (specs ia v1.40 §16.15) — trace de bout en bout d'une demande vocale.
 *
 * Une trace par requête `/api/chat` : satellite, texte reçu de HA (sortie de la reconnaissance vocale), chemin suivi,
 * outils appelés, ordres au planificateur et leurs réponses, réponse rendue, état réel des entités visées relu
 * quelques secondes après, verdict. Une ligne JSON par trace dans `data/ia/traces-vocales/AAAA-MM-JJ.jsonl`.
 */
import fs from 'node:fs';
import path from 'node:path';

export type CheminTrace = 'texte_suspect' | 'radio' | 'cache' | 'interpreteur' | 'mistral';

export type VerdictTrace =
  | 'erreur'
  | 'action_en_echec'
  | 'action_non_constatee'
  | 'action_verifiee'
  | 'reponse_sans_action'
  | 'sans_action';

/** Verdicts écrits en WARN dans le journal et retenus par `anomalies` (outil MCP). */
export const VERDICTS_ANOMALIE: VerdictTrace[] = ['erreur', 'action_en_echec', 'action_non_constatee', 'reponse_sans_action'];

export interface OutilTrace {
  tour: number;
  nom: string;
  arguments: unknown;
  resultat: string;
}

export interface ActionTrace {
  /** Paramètres de l'ordre (verbe/quoi/lieux/valeur, ou radio). */
  ordre: unknown;
  succes: boolean;
  message: string;
  /** Lus dans le message du planificateur (« <domaine>.<service> exécuté sur <ids>. »). */
  domaine?: string;
  service?: string;
  entites: string[];
}

export interface VerificationTrace {
  entity_id: string;
  /** États acceptés ; vide = non vérifiable (état relu sans verdict). */
  attendu: string[];
  constate?: string;
  conforme?: boolean;
}

export interface TraceVocale {
  id: string;
  debut: string;
  dureeMs?: number;
  satellite?: { nom?: string; piece?: string; lieu?: string };
  question: string;
  libre: boolean;
  questionSuspecte: boolean;
  chemin?: CheminTrace;
  outils: OutilTrace[];
  actions: ActionTrace[];
  reponse?: string;
  gardeFou: boolean;
  erreur?: string;
  jetons?: { prompt: number; completion: number; cache: number };
  verification: VerificationTrace[];
  verdict?: VerdictTrace;
}

export function nouvelleTrace(question: string, libre: boolean, maintenant: Date = new Date()): TraceVocale {
  return {
    id: `${maintenant.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    debut: maintenant.toISOString(),
    question,
    libre,
    questionSuspecte: questionSuspecte(question),
    outils: [],
    actions: [],
    gardeFou: false,
    verification: []
  };
}

/** Texte vide, ou dont moins de la moitié des lettres sont latines (reconnaissance vocale dans une autre langue). */
export function questionSuspecte(question: string): boolean {
  const lettres = [...question].filter((c) => /\p{L}/u.test(c));
  if (lettres.length === 0) return true;
  const latines = lettres.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latines / lettres.length < 0.5;
}

const CIBLE = /^\s*([a-z_]+)\.([a-z_]+) exécuté sur (.+?)\.?\s*$/;

/** Ordre transmis au planificateur et sa réponse ; la cible est lue dans le message (format de `execution.ts`). */
export function actionDepuisReponse(ordre: unknown, reponse: { success: boolean; message: string }): ActionTrace {
  const action: ActionTrace = { ordre, succes: reponse.success, message: reponse.message, entites: [] };
  const m = CIBLE.exec(reponse.message ?? '');
  if (m) {
    action.domaine = m[1];
    action.service = m[2];
    action.entites = m[3].split(',').map((s) => s.trim()).filter((s) => /^[a-z_]+\.[a-z0-9_]+$/.test(s));
  }
  return action;
}

/** États acceptés après un service ; vide = non vérifiable. */
export function etatsAttendus(service?: string): string[] {
  switch (service) {
    case 'turn_on': return ['on'];
    case 'turn_off': return ['off'];
    case 'open_cover': return ['open', 'opening'];
    case 'close_cover': return ['closed', 'closing'];
    case 'lock': return ['locked'];
    case 'unlock': return ['unlocked'];
    default: return [];
  }
}

const VERBE_ACTION = /\b(allum|[ée]tei[gn]|ouvr|ferm|lanc|d[ée]marr|arr[êe]t|coup|baiss|mont|monte|descend|r[èe]gl|mets?\b|joue)/i;

/** Verdict (§16.15) : le premier qui s'applique. */
export function verdict(trace: TraceVocale): VerdictTrace {
  if (trace.erreur) return 'erreur';
  if (trace.actions.length > 0) {
    if (trace.actions.some((a) => !a.succes)) return 'action_en_echec';
    if (trace.verification.some((v) => v.conforme === false)) return 'action_non_constatee';
    return 'action_verifiee';
  }
  // Sans aucun outil (ni lecture d'état) : une réponse « La lumière est éteinte » après `obtenir_etat` n'est pas suspecte.
  if (trace.outils.length === 0 && trace.reponse && VERBE_ACTION.test(trace.reponse)) return 'reponse_sans_action';
  return 'sans_action';
}

/** Entités à relire : celles des actions réussies, avec leurs états attendus. */
export function aVerifier(trace: TraceVocale): VerificationTrace[] {
  const vues = new Set<string>();
  const liste: VerificationTrace[] = [];
  for (const a of trace.actions) {
    if (!a.succes) continue;
    for (const id of a.entites) {
      if (vues.has(id)) continue;
      vues.add(id);
      liste.push({ entity_id: id, attendu: etatsAttendus(a.service) });
    }
  }
  return liste;
}

/** Ligne de journal courte : `<verdict> : <satellite> « question » → « réponse »`. */
export function resume(trace: TraceVocale): string {
  const sat = trace.satellite?.nom ?? trace.satellite?.lieu ?? 'sans satellite';
  const court = (s: string | undefined, n: number): string => (s ?? '').replace(/\s+/g, ' ').slice(0, n);
  const suspect = trace.questionSuspecte ? ' [texte reçu suspect]' : '';
  return `${trace.verdict} : ${sat} « ${court(trace.question, 120)} »${suspect} → « ${court(trace.reponse ?? trace.erreur, 160)} » (${trace.chemin ?? '?'}, ${trace.dureeMs ?? '?'} ms)`;
}

/** Date locale AAAA-MM-JJ. */
export function jourLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Fichiers de traces : un par jour, ajout en fin, purge au-delà de `joursConserves`. */
export class JournalTraces {
  constructor(private readonly dossier: string) {}

  ecrire(trace: TraceVocale): void {
    fs.mkdirSync(this.dossier, { recursive: true });
    fs.appendFileSync(path.join(this.dossier, `${jourLocal(new Date(trace.debut))}.jsonl`), JSON.stringify(trace) + '\n');
  }

  /** Supprime les fichiers plus vieux que `joursConserves` jours ; renvoie leur nombre. */
  purger(joursConserves: number, maintenant: Date = new Date()): number {
    if (!fs.existsSync(this.dossier)) return 0;
    const limite = new Date(maintenant);
    limite.setDate(limite.getDate() - joursConserves);
    const borne = jourLocal(limite);
    let n = 0;
    for (const f of fs.readdirSync(this.dossier)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[1] < borne) { fs.unlinkSync(path.join(this.dossier, f)); n++; }
    }
    return n;
  }

  /** Traces d'un jour, les plus récentes d'abord, filtrées. */
  lire(opts: { jour?: string; limite?: number; anomalies?: boolean; texte?: string } = {}): { jour: string; total: number; traces: TraceVocale[]; jours_disponibles: string[] } {
    const jour = opts.jour && /^\d{4}-\d{2}-\d{2}$/.test(opts.jour) ? opts.jour : jourLocal(new Date());
    const limite = Math.min(Math.max(1, Math.floor(opts.limite ?? 20)), 100);
    const fichier = path.join(this.dossier, `${jour}.jsonl`);
    const jours = fs.existsSync(this.dossier)
      ? fs.readdirSync(this.dossier).map((f) => /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1]).filter((j): j is string => !!j).sort().reverse()
      : [];
    if (!fs.existsSync(fichier)) return { jour, total: 0, traces: [], jours_disponibles: jours.slice(0, 15) };
    let traces: TraceVocale[] = [];
    for (const ligne of fs.readFileSync(fichier, 'utf8').split('\n')) {
      if (!ligne.trim()) continue;
      try { traces.push(JSON.parse(ligne) as TraceVocale); } catch { /* ligne tronquée : ignorée */ }
    }
    if (opts.anomalies) traces = traces.filter((t) => (t.verdict && VERDICTS_ANOMALIE.includes(t.verdict)) || t.questionSuspecte);
    if (opts.texte) {
      const q = opts.texte.toLowerCase();
      traces = traces.filter((t) => `${t.question} ${t.reponse ?? ''}`.toLowerCase().includes(q));
    }
    const total = traces.length;
    return { jour, total, traces: traces.reverse().slice(0, limite), jours_disponibles: jours.slice(0, 15) };
  }
}
