/**
 * Lecture / dépôt / suppression des automatisations Home Assistant, pour les outils MCP
 * `lire_automatisations_ha`, `deposer_automatisation` et `supprimer_automatisation`
 * (conception Claude Code §5, niveau 2 — specs ia v1.21 §19.9).
 *
 * HA n'a aucune commande WebSocket pour la config brute d'une automatisation : seule la route REST
 * `/api/config/automation/config/{id}` existe, et seul le process `core` détient le jeton HA. ia passe donc
 * par le pont générique HaRestBridge (`ha:rest:request` → `ia:ha:rest:result`, même mécanisme que scriptsha) ;
 * le core recharge les automatisations après un dépôt.
 *
 * Garde-fous (jamais de dépôt « à l'aveugle ») :
 *  - sans `confirme: true`, l'outil ne fait RIEN : il renvoie un aperçu (ce qui serait créé/remplacé/supprimé) ;
 *  - l'existant est sauvegardé (data/ia/automations-backups/) AVANT tout remplacement ou suppression ;
 *  - contrôles de forme et alerte anti-boucle (une entité à la fois déclencheur et cible) avant l'envoi ;
 *  - HA valide lui-même le schéma : son message d'erreur est renvoyé tel quel.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IEventBus, HaBridgeClient } from '../../../core/dist/exports';

/** Événement de réponse du core — à déclarer dans `bridgedEvents` (index.ts). */
export const HA_REST_REPLY_EVENT = 'ia:ha:rest:result';

interface RestResult { id: string; success: boolean; result?: unknown; error?: string }

const REQUEST_TIMEOUT_MS = 10000;
const MAX_BACKUPS_PER_ID = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface AutomationSummary { id: string; alias: string; etat: string; entity_id: string; derniere_execution?: unknown }

export class HaAutomationClient {
  private readonly waiting = new Map<string, Array<(r: RestResult) => void>>();
  private readonly backupDir: string;

  constructor(private readonly eventBus: IEventBus, private readonly registry: HaBridgeClient, dataDir: string) {
    this.backupDir = path.join(dataDir, 'automations-backups');
    this.eventBus.onGeneric<RestResult>(HA_REST_REPLY_EVENT, (r) => {
      const next = this.waiting.get(r.id)?.shift();
      if (next) next(r);
    });
  }

  // --- lecture -----------------------------------------------------------------------------------

  /** Automatisations connues de HA (entités `automation.*`), avec l'id de config qui sert aux appels REST. */
  list(): AutomationSummary[] {
    if (!this.registry.isAvailable()) return [];
    return this.registry.getAllEntities()
      .filter((e) => e.entity_id.startsWith('automation.'))
      .map((e) => ({
        id: String(e.attributes?.id ?? ''),
        alias: String(e.friendly_name ?? e.attributes?.friendly_name ?? e.entity_id),
        etat: String(e.state),
        entity_id: e.entity_id,
        derniere_execution: e.attributes?.last_triggered
      }));
  }

  async get(id: string): Promise<{ ok: true; config: unknown } | { ok: false; error: string }> {
    const r = await this.request('get', id);
    return r.success ? { ok: true, config: r.result } : { ok: false, error: r.error ?? 'échec' };
  }

  listBackups(id?: string): Array<{ fichier: string; id: string; date: string }> {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ fichier: f, id: f.replace(/__.*$/, ''), date: f.replace(/^.*__/, '').replace(/\.json$/, '') }))
      .filter((b) => !id || b.id === id)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  // --- écriture ----------------------------------------------------------------------------------

  /** Aperçu ou dépôt. Sans `confirm`, ne modifie rien. */
  async deposit(id: string, definition: unknown, confirm: boolean): Promise<unknown> {
    const idError = this.checkId(id);
    if (idError) return { error: idError };
    const problems = this.checkDefinition(definition);
    if (problems.length) return { error: 'définition refusée avant envoi à HA', problemes: problems };
    const def = definition as Record<string, unknown>;

    const existing = await this.get(id);
    const exists = existing.ok;
    const warnings = this.loopWarnings(def);
    if (!exists && existing.ok === false && !/HTTP 404/.test(existing.error)) {
      return { error: `lecture de l'existant impossible : ${existing.error}` };
    }

    if (!confirm) {
      return {
        action: exists ? 'remplacement' : 'création',
        id,
        effectue: false,
        message: 'AUCUNE modification faite. Montre cet aperçu à l\'utilisateur, puis rappelle l\'outil avec confirme: true seulement après son accord explicite.',
        definition_deposee: def,
        ...(exists ? { definition_actuelle_remplacee: existing.config, sauvegarde: 'sera faite avant remplacement' } : {}),
        ...(warnings.length ? { avertissements: warnings } : {})
      };
    }

    const backup = exists ? this.backup(id, existing.config) : undefined;
    const written = await this.request('set', id, def);
    if (!written.success) return { error: `HA a refusé la définition : ${written.error}`, ...(backup ? { sauvegarde: backup } : {}), effectue: false };
    return {
      effectue: true,
      action: exists ? 'remplacement' : 'création',
      id,
      automatisations_rechargees: true,
      ...(backup ? { sauvegarde: backup } : {}),
      ...(warnings.length ? { avertissements: warnings } : {}),
      annuler: exists ? `redéposer le contenu de la sauvegarde « ${backup} » (lire_automatisations_ha, sauvegardes)` : `supprimer_automatisation id=${id}`
    };
  }

  async remove(id: string, confirm: boolean): Promise<unknown> {
    const idError = this.checkId(id);
    if (idError) return { error: idError };
    const existing = await this.get(id);
    if (!existing.ok) return { error: `automatisation « ${id} » introuvable ou illisible : ${existing.error}` };
    if (!confirm) {
      return {
        action: 'suppression', id, effectue: false,
        message: 'AUCUNE modification faite. Montre cet aperçu à l\'utilisateur, puis rappelle l\'outil avec confirme: true seulement après son accord explicite.',
        definition_supprimee: existing.config, sauvegarde: 'sera faite avant suppression'
      };
    }
    const backup = this.backup(id, existing.config);
    const removed = await this.request('delete', id);
    if (!removed.success) return { error: `HA a refusé la suppression : ${removed.error}`, sauvegarde: backup, effectue: false };
    // HA recharge lui-même les automatisations après une suppression par sa route de config (comme après un dépôt).
    return { effectue: true, action: 'suppression', id, sauvegarde: backup, annuler: `redéposer le contenu de la sauvegarde « ${backup} »` };
  }

  readBackup(file: string): unknown {
    const safe = path.basename(file);
    const full = path.join(this.backupDir, safe);
    if (!fs.existsSync(full)) return undefined;
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  }

  // --- internes ----------------------------------------------------------------------------------

  private checkId(id: string): string | undefined {
    return ID_PATTERN.test(id) ? undefined : 'id invalide (lettres, chiffres, _ et - seulement, 64 caractères maximum)';
  }

  private checkDefinition(def: unknown): string[] {
    const problems: string[] = [];
    if (!def || typeof def !== 'object' || Array.isArray(def)) return ['la définition doit être un objet JSON (équivalent du YAML d\'une automatisation)'];
    const d = def as Record<string, unknown>;
    if (typeof d.alias !== 'string' || !d.alias.trim()) problems.push('alias obligatoire (nom lisible de l\'automatisation)');
    if (!(d.trigger ?? d.triggers)) problems.push('trigger/triggers obligatoire');
    if (!(d.action ?? d.actions)) problems.push('action/actions obligatoire');
    if (d.mode !== undefined && !['single', 'restart', 'queued', 'parallel'].includes(String(d.mode))) problems.push('mode doit être single, restart, queued ou parallel');
    return problems;
  }

  /** Anti-boucle (incident du 18/08) : une entité qui déclenche l'automatisation ET en est la cible. */
  private loopWarnings(def: Record<string, unknown>): string[] {
    const collect = (node: unknown, keys: string[], out: Set<string>): void => {
      if (Array.isArray(node)) { node.forEach((n) => collect(n, keys, out)); return; }
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (keys.includes(k)) {
          const values = Array.isArray(v) ? v : [v];
          values.forEach((x) => { if (typeof x === 'string' && x.includes('.')) out.add(x); });
        }
        collect(v, keys, out);
      }
    };
    const triggers = new Set<string>(); const targets = new Set<string>();
    collect(def.trigger ?? def.triggers, ['entity_id'], triggers);
    collect(def.action ?? def.actions, ['entity_id'], targets);
    const both = [...triggers].filter((e) => targets.has(e));
    const out: string[] = [];
    if (both.length) out.push(`Risque de boucle : ${both.join(', ')} déclenche l'automatisation ET en est la cible. Exige from/to explicites, mode single et une condition de garde.`);
    if (def.mode === undefined) out.push('mode non précisé (HA prendra « single ») : à choisir consciemment.');
    return out;
  }

  private backup(id: string, config: unknown): string {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${id}__${stamp}.json`;
    fs.writeFileSync(path.join(this.backupDir, file), JSON.stringify(config, null, 2));
    const mine = this.listBackups(id);
    for (const old of mine.slice(MAX_BACKUPS_PER_ID)) fs.rmSync(path.join(this.backupDir, old.fichier), { force: true });
    return file;
  }

  private request(method: 'get' | 'set' | 'delete', id: string, config?: unknown): Promise<RestResult> {
    return new Promise((resolve) => {
      const resolver = (r: RestResult): void => { clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => {
        const queue = this.waiting.get(id);
        const at = queue?.indexOf(resolver) ?? -1;
        if (queue && at >= 0) queue.splice(at, 1);
        resolve({ id, success: false, error: `pas de réponse du core après ${REQUEST_TIMEOUT_MS / 1000} s` });
      }, REQUEST_TIMEOUT_MS);
      const queue = this.waiting.get(id) ?? [];
      queue.push(resolver);
      this.waiting.set(id, queue);
      this.eventBus.emitGeneric('ha:rest:request', { appId: 'ia', method, domain: 'automation', id, ...(config !== undefined ? { config } : {}) });
    });
  }
}
