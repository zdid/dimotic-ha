/**
 * Évaluation de l'état des sauvegardes d'une machine (fonctionnelles-supervision_specs §5), à partir
 * de la réponse de l'application sauvegarde (`sauvegarde:supervision:status:reply`, lue par SSH :
 * script/cron installés, status.json, marqueurs last-<dossier>-<cadence>). Affichage seulement.
 */

/** Une machine de la réponse de sauvegarde (fonctionnelles-sauvegarde_specs §5quater). */
export interface BackupMachineReport {
  id: string;
  site: string;
  machine: string;
  host: string;
  reachable: boolean;
  error?: string;
  scriptInstalled: boolean;
  cronInstalled: boolean;
  status: Record<string, BackupFolderStatus> | null;
  lastSuccess: Record<string, Record<string, string>>;
}

export interface BackupFolderStatus {
  lastRun?: string;
  success?: boolean;
  cadences?: string;
  cadencesEchec?: string;
  tarExit?: string;
  tarLog?: string;
}

export type BackupLevel = 'ok' | 'warn' | 'error' | 'none';

/** `text` peut contenir `{date}`, remplacé côté navigateur par `date` (ISO) formatée à l'heure
 *  locale du navigateur — le process peut tourner en UTC (Docker). */
export interface BackupLine {
  level: BackupLevel | 'info';
  text: string;
  date?: string;
}

export interface BackupView {
  level: BackupLevel;
  /** Machine de sauvegarde (site/machine) correspondante. */
  target: string;
  lines: BackupLine[];
}

const DAY_MS = 24 * 3600 * 1000;
/** Seuils de « dernière réussite trop ancienne » (décision utilisateur du 25/09/2026). */
export const MAX_AGE_DAYS: Record<string, number> = { journalier: 2, hebdomadaire: 8 };

const RANK: Record<BackupLevel, number> = { ok: 0, warn: 1, none: 2, error: 3 };

export function evaluateBackup(report: BackupMachineReport, now = Date.now()): BackupView {
  const target = `${report.site}/${report.machine}`;
  if (!report.reachable) {
    return { level: 'error', target, lines: [{ level: 'error', text: `Injoignable par SSH : ${report.error || 'erreur inconnue'}` }] };
  }

  const lines: BackupLine[] = [];
  const missing: string[] = [];
  if (!report.scriptInstalled) missing.push('script absent');
  if (!report.cronInstalled) missing.push('cron absent');
  if (!report.status) missing.push('jamais exécutée');
  if (missing.length > 0) {
    lines.push({ level: 'none', text: `Aucune sauvegarde (${missing.join(', ')}) — « 📤 Pousser » dans Sauvegarde` });
  }

  const folders = new Set([...Object.keys(report.status ?? {}), ...Object.keys(report.lastSuccess)]);
  for (const folder of [...folders].sort()) {
    const s = report.status?.[folder];
    if (s) {
      if (s.success === false) {
        const cause = [
          s.cadencesEchec ? `envoi en échec : ${s.cadencesEchec}` : '',
          s.tarExit && s.tarExit !== '0' ? `tar code ${s.tarExit}` : '',
          s.tarLog ? s.tarLog.slice(0, 200) : ''
        ].filter(Boolean).join(' — ');
        lines.push({ level: 'error', text: `${folder} : échec de la dernière exécution ({date})${cause ? ` — ${cause}` : ''}`, date: s.lastRun });
      } else {
        const partial = s.cadencesEchec ? ` — en échec : ${s.cadencesEchec}` : '';
        lines.push({ level: partial ? 'warn' : 'ok', text: `${folder} : dernière exécution {date} (${s.cadences || '—'})${partial}`, date: s.lastRun });
      }
    }
    const markers = report.lastSuccess[folder] ?? {};
    for (const [cadence, maxDays] of Object.entries(MAX_AGE_DAYS)) {
      const iso = markers[cadence];
      if (!iso) {
        // Marqueurs écrits seulement par le script poussé depuis le 25/09/2026 ; l'hebdomadaire
        // n'apparaît qu'après la première exécution hebdomadaire réussie.
        if (Object.keys(report.lastSuccess).length > 0) {
          lines.push({ level: 'info', text: `${folder} ${cadence} : pas encore de réussite enregistrée` });
        }
        continue;
      }
      const age = now - Date.parse(iso);
      const tooOld = Number.isNaN(age) || age > maxDays * DAY_MS;
      lines.push({
        level: tooOld ? 'warn' : 'ok',
        text: `${folder} ${cadence} : dernière réussite {date}${tooOld ? ` — plus de ${maxDays} jours` : ''}`,
        date: iso
      });
    }
  }
  if (report.status && Object.keys(report.lastSuccess).length === 0) {
    lines.push({ level: 'info', text: 'Dates de réussite par cadence inconnues : script à repousser (« 📤 Pousser »)' });
  }

  let level: BackupLevel = 'ok';
  for (const line of lines) {
    if (line.level !== 'info' && RANK[line.level] > RANK[level]) level = line.level;
  }
  return { level, target, lines };
}
