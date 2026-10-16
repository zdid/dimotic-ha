/**
 * Création / liste / suppression des « aides » Home Assistant (timer, input_boolean, input_number…) pour l'outil MCP
 * `creer_aide_ha`. Passe par le pont générique HaHelperBridge du cœur (`ha:helper:request` → `ia:ha:helper:result`) :
 * seul le cœur détient le jeton HA. Même principe que scriptsha.
 *
 * Garde-fous : sans `confirme: true` rien n'est modifié (aperçu : entity_id obtenu, collision éventuelle) ; la définition
 * d'une aide supprimée est sauvegardée dans data/ia/aides-backups/ avant suppression.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IEventBus } from '../../../core/dist/exports';

/** Événement de réponse du cœur — à déclarer dans `bridgedEvents` (index.ts). */
export const HA_HELPER_REPLY_EVENT = 'ia:ha:helper:result';

/** Domaines d'aides acceptés (même patron de commandes WebSocket `<domaine>/create|list|delete`). */
export const AIDES_DOMAINES = ['timer', 'input_boolean', 'input_number', 'input_text', 'input_select', 'input_datetime', 'counter'] as const;

interface HelperResult { requestId: string; success: boolean; result?: unknown; error?: string }

const TIMEOUT_MS = 10000;

function slug(texte: string): string {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export class HaAideClient {
  private readonly waiting = new Map<string, (r: HelperResult) => void>();
  private readonly backupDir: string;

  constructor(private readonly eventBus: IEventBus, dataDir: string) {
    this.backupDir = path.join(dataDir, 'aides-backups');
    this.eventBus.onGeneric<HelperResult>(HA_HELPER_REPLY_EVENT, (r) => {
      const next = this.waiting.get(r.requestId);
      if (next) { this.waiting.delete(r.requestId); next(r); }
    });
  }

  private appeler(method: 'list' | 'create' | 'delete', domain: string, id?: string, data?: Record<string, unknown>): Promise<HelperResult> {
    const requestId = `ia-aide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve({ requestId, success: false, error: `pas de réponse du cœur après ${TIMEOUT_MS / 1000} s` });
      }, TIMEOUT_MS);
      this.waiting.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
      this.eventBus.emitGeneric('ha:helper:request', { appId: 'ia', requestId, method, domain, ...(id ? { id } : {}), ...(data ? { data } : {}) });
    });
  }

  private controlerDomaine(domaine: string): void {
    if (!(AIDES_DOMAINES as readonly string[]).includes(domaine)) throw new Error(`Domaine « ${domaine} » non géré : ${AIDES_DOMAINES.join(', ')}`);
  }

  async lister(domaine: string): Promise<unknown> {
    this.controlerDomaine(domaine);
    const r = await this.appeler('list', domaine);
    if (!r.success) throw new Error(r.error ?? 'échec de la liste');
    return { domaine, aides: r.result };
  }

  async creer(domaine: string, nom: string, options: Record<string, unknown>, confirme: boolean): Promise<unknown> {
    this.controlerDomaine(domaine);
    if (!nom.trim()) throw new Error('« nom » obligatoire');
    const idPrevu = slug(nom);
    const existantes = (await this.lister(domaine) as { aides: Array<{ id?: string; name?: string }> }).aides ?? [];
    const collision = existantes.find((a) => a.id === idPrevu || a.name?.toLowerCase() === nom.toLowerCase());
    const apercu = {
      action: 'creer',
      aide: { domaine, nom, options },
      entityIdPrevu: `${domaine}.${idPrevu}`,
      dejaExistante: collision ?? null,
      annuler: `creer_aide_ha action=supprimer domaine=${domaine} id=${idPrevu} confirme=true`
    };
    if (!confirme) return { effectue: false, ...apercu, message: "AUCUNE modification faite. Montre cet aperçu à l'utilisateur, puis rappelle l'outil avec confirme: true seulement après son accord explicite." };
    if (collision) throw new Error(`« ${domaine}.${idPrevu} » existe déjà : création refusée`);
    const r = await this.appeler('create', domaine, undefined, { name: nom, ...options });
    if (!r.success) throw new Error(r.error ?? 'HA a refusé la création');
    return { effectue: true, ...apercu, cree: r.result };
  }

  async supprimer(domaine: string, id: string, confirme: boolean): Promise<unknown> {
    this.controlerDomaine(domaine);
    if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`id invalide : « ${id} » (identifiant de l'aide, sans le domaine)`);
    const existantes = (await this.lister(domaine) as { aides: Array<{ id?: string }> }).aides ?? [];
    const cible = existantes.find((a) => a.id === id);
    if (!cible) throw new Error(`Aide « ${domaine}.${id} » inconnue (ou non gérée par l'interface)`);
    const apercu = { action: 'supprimer', aide: cible, entityId: `${domaine}.${id}`, annuler: `creer_aide_ha action=creer domaine=${domaine} nom=${JSON.stringify((cible as { name?: string }).name ?? id)} confirme=true` };
    if (!confirme) return { effectue: false, ...apercu, message: "AUCUNE modification faite. Montre cet aperçu à l'utilisateur, puis rappelle l'outil avec confirme: true seulement après son accord explicite." };
    fs.mkdirSync(this.backupDir, { recursive: true });
    const sauvegarde = `${domaine}__${id}__${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(this.backupDir, sauvegarde), JSON.stringify(cible, null, 2), 'utf8');
    const r = await this.appeler('delete', domaine, id);
    if (!r.success) throw new Error(r.error ?? 'HA a refusé la suppression');
    return { effectue: true, ...apercu, sauvegarde };
  }
}
