/**
 * Calcul pur des délais de déclenchement (Trigger → millisecondes). Port de
 * ts-planner/src/scheduler.ts (fonction triggerToMs et ses aides), sans état ni effet de bord —
 * la gestion des minuteurs actifs est dans scheduler-runtime.ts. Voir specs §3 : ce calcul est
 * strictement déterministe, jamais fait par l'IA ; toute plage aléatoire est retirée à chaque appel
 * (jamais figée une fois pour toutes).
 */

import type { Trigger } from './types';
import type { Logger } from '../../../core/dist/exports';

/** true si `trigger` reprogramme automatiquement une nouvelle occurrence après déclenchement. */
export function isRecurring(trigger: Trigger): boolean {
  return ['recurrence', 'recurrence_complex', 'window', 'time'].includes(trigger.type);
}

/** Calcule le délai en ms avant la prochaine occurrence de `trigger`, ou null si non calculable. */
export function triggerToMs(trigger: Trigger, logger?: Logger, now: Date = new Date()): number | null {
  switch (trigger.type) {
    case 'delay': {
      if (trigger.seconds !== undefined) return trigger.seconds * 1000;
      if (trigger.seconds_min !== undefined && trigger.seconds_max !== undefined) {
        const s = randInt(trigger.seconds_min, trigger.seconds_max);
        logger?.debug('scheduler', `Aléatoire résolu: ${s}s (${trigger.seconds_min}-${trigger.seconds_max})`);
        return s * 1000;
      }
      return null;
    }

    case 'time': {
      const atStr = (trigger.at_min && trigger.at_max) ? randTime(trigger.at_min, trigger.at_max) : trigger.at;
      if (!atStr) return null;
      return msUntilTime(atStr, now);
    }

    case 'date': {
      if (!trigger.on) return null;
      const [year, month, day] = trigger.on.split('-').map(Number);
      const target = new Date(year, month - 1, day);
      if (trigger.at) {
        const [h, m] = trigger.at.split(':').map(Number);
        target.setHours(h, m, 0, 0);
      }
      const diff = target.getTime() - now.getTime();
      return diff > 0 ? diff : null;
    }

    case 'recurrence': {
      if (!trigger.at && !(trigger.at_min && trigger.at_max)) return null;
      const atStr = (trigger.at_min && trigger.at_max) ? randTime(trigger.at_min, trigger.at_max) : trigger.at!;
      const target = new Date(now);
      const [h, m] = atStr.split(':').map(Number);
      target.setHours(h, m, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);

      for (let i = 0; i < 7; i++) {
        const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][target.getDay()];
        const allowed = !trigger.days || trigger.days.includes(dayKey);
        const excluded = trigger.except_days?.includes(dayKey) ?? false;
        if (allowed && !excluded) break;
        target.setDate(target.getDate() + 1);
      }
      return target.getTime() - now.getTime();
    }

    case 'recurrence_complex': {
      const target = resolveComplexPattern(trigger.pattern || '', trigger.at, trigger.at_min, trigger.at_max, now);
      return target ? target.getTime() - now.getTime() : null;
    }

    case 'window': {
      if (!trigger.from) return null;
      return msUntilTime(trigger.from, now);
    }

    case 'duration': {
      if (trigger.seconds !== undefined) return trigger.seconds * 1000;
      if (trigger.seconds_min !== undefined && trigger.seconds_max !== undefined) {
        return randInt(trigger.seconds_min, trigger.seconds_max) * 1000;
      }
      return null;
    }

    default:
      logger?.warn('scheduler', `Type de déclencheur non géré: ${trigger.type}`);
      return null;
  }
}

function resolveComplexPattern(
  pattern: string,
  at?: string,
  atMin?: string,
  atMax?: string,
  now: Date = new Date()
): Date | null {
  const atStr = (atMin && atMax) ? randTime(atMin, atMax) : (at || '00:00');
  const [h, m] = atStr.split(':').map(Number);
  const setTime = (d: Date) => { d.setHours(h, m, 0, 0); return d; };

  if (pattern === 'last_day_of_month') {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    setTime(d);
    if (d <= now) {
      const next = new Date(now.getFullYear(), now.getMonth() + 2, 0);
      setTime(next);
      return next;
    }
    return d;
  }

  if (pattern.startsWith('first_') || pattern.startsWith('last_')) {
    const parts = pattern.split('_');
    const position = parts[0];
    const dayName = parts[1];
    const days: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
    };
    const targetDay = days[dayName];
    if (targetDay === undefined) return null;

    const d = findNthWeekday(now.getFullYear(), now.getMonth(), targetDay, position === 'first' ? 1 : -1);
    setTime(d);
    if (d <= now) {
      const nextMonth = now.getMonth() + 1;
      const nextYear = nextMonth > 11 ? now.getFullYear() + 1 : now.getFullYear();
      const d2 = findNthWeekday(nextYear, nextMonth % 12, targetDay, position === 'first' ? 1 : -1);
      setTime(d2);
      return d2;
    }
    return d;
  }

  return null;
}

function findNthWeekday(year: number, month: number, weekday: number, nth: number): Date {
  if (nth > 0) {
    const d = new Date(year, month, 1);
    while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
    d.setDate(d.getDate() + (nth - 1) * 7);
    return d;
  } else {
    const d = new Date(year, month + 1, 0);
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d;
  }
}

function msUntilTime(timeStr: string, from: Date): number {
  const [h, m] = timeStr.split(':').map(Number);
  const target = new Date(from);
  target.setHours(h, m, 0, 0);
  if (target <= from) target.setDate(target.getDate() + 1);
  return target.getTime() - from.getTime();
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randTime(from: string, to: string): string {
  const [h1, m1] = from.split(':').map(Number);
  const [h2, m2] = to.split(':').map(Number);
  const rand = randInt(h1 * 60 + m1, h2 * 60 + m2);
  return `${String(Math.floor(rand / 60)).padStart(2, '0')}:${String(rand % 60).padStart(2, '0')}`;
}
