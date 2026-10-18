/**
 * Tableaux de bord Home Assistant (Lovelace) et configuration Énergie, pour les outils MCP `lire_tableaux_de_bord`,
 * `deposer_tableau_de_bord`, `lire_energie` et `deposer_energie`.
 *
 * Tout passe par les commandes WebSocket de HA (`lovelace/…`, `energy/…`) via l'appel générique du cœur (seul détenteur du
 * jeton) : l'agent n'a jamais besoin de lire ni d'écrire `.storage`. Le jeton doit être administrateur.
 *
 * Garde-fous : sans `confirme: true` rien n'est modifié (aperçu : ce qui change, taille, création éventuelle) ; la
 * configuration existante est sauvegardée dans data/ia/tableaux-backups/ AVANT tout remplacement ; contrôles de forme
 * avant l'envoi (HA valide aussi, son message d'erreur est renvoyé tel quel).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HaBridgeClient } from '../../../core/dist/exports';

type Ws = Pick<HaBridgeClient, 'callWs'>;

interface Tableau { id?: string; url_path?: string | null; title?: string; mode?: string; icon?: string }
interface Vue { title?: string; path?: string; cards?: unknown[]; sections?: unknown[]; type?: string }

const URL_PATH = /^[a-z0-9]+(-[a-z0-9_]+)+$/;
const MAX_SAUVEGARDES = 20;

function resume(config: unknown): { vues: Array<{ titre: string; chemin?: string; cartes: number }>; strategie?: unknown } {
  const c = (config ?? {}) as { views?: Vue[]; strategy?: unknown };
  return {
    vues: (c.views ?? []).map((v) => ({ titre: v.title ?? v.path ?? '(sans titre)', chemin: v.path, cartes: (v.cards?.length ?? 0) + (v.sections?.length ?? 0) })),
    ...(c.strategy ? { strategie: c.strategy } : {})
  };
}

export class HaTableauClient {
  private readonly backupDir: string;

  constructor(private readonly ha: Ws, dataDir: string) {
    this.backupDir = path.join(dataDir, 'tableaux-backups');
  }

  private ws(message: Record<string, unknown>): Promise<unknown> {
    return this.ha.callWs(message, 30000);
  }

  /** Liste des tableaux (le tableau par défaut a `url_path` null) ; avec `urlPath` : sa configuration complète. */
  async lire(urlPath?: string | null): Promise<unknown> {
    if (urlPath === undefined) {
      const liste = (await this.ws({ type: 'lovelace/dashboards/list' })) as Tableau[];
      return { tableaux: [{ url_path: null, title: 'Tableau par défaut (lovelace)', mode: 'par défaut (le lire avec url_path vide)' }, ...liste.map((t) => ({ url_path: t.url_path, title: t.title, mode: t.mode, icon: t.icon }))] };
    }
    const config = await this.configOuNull(urlPath || null);
    if (config === null) return { url_path: urlPath || null, existe: false, note: 'aucune configuration enregistrée (tableau en mode automatique, ou inconnu)' };
    return { url_path: urlPath || null, existe: true, resume: resume(config), config };
  }

  private async configOuNull(urlPath: string | null): Promise<unknown | null> {
    try {
      return await this.ws({ type: 'lovelace/config', force: true, ...(urlPath ? { url_path: urlPath } : {}) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/config_not_found|not found/i.test(msg)) return null;
      throw e;
    }
  }

  async deposer(urlPath: string | null, config: unknown, creer: { titre?: string; icone?: string } | undefined, confirme: boolean): Promise<unknown> {
    const c = config as { views?: unknown; strategy?: unknown } | null;
    if (!c || typeof c !== 'object' || Array.isArray(c) || (!Array.isArray(c.views) && !c.strategy)) {
      throw new Error('« config » doit être un objet avec « views » (liste de vues) ou « strategy »');
    }
    if (urlPath !== null && !URL_PATH.test(urlPath)) throw new Error(`url_path invalide : « ${urlPath} » (minuscules, chiffres et au moins un tiret, ex. energie-direct)`);

    const existe = urlPath === null ? true : ((await this.ws({ type: 'lovelace/dashboards/list' })) as Tableau[]).some((t) => t.url_path === urlPath);
    if (!existe && !creer) throw new Error(`Le tableau « ${urlPath} » n'existe pas : donner « creer » ({titre, icone}) pour le créer`);
    const avant = existe ? await this.configOuNull(urlPath) : null;
    const identique = avant !== null && JSON.stringify(avant) === JSON.stringify(config);
    const apercu = {
      action: !existe ? 'creation' : avant === null ? 'premiere configuration' : identique ? 'identique (rien à changer)' : 'remplacement',
      url_path: urlPath,
      ...(!existe ? { creation: { titre: creer?.titre ?? urlPath, icone: creer?.icone ?? 'mdi:view-dashboard' } } : {}),
      avant: avant === null ? null : resume(avant),
      apres: resume(config),
      tailleOctets: JSON.stringify(config).length,
      annuler: avant === null ? 'supprimer le tableau dans HA (Paramètres > Tableaux de bord)' : 'redéposer la sauvegarde faite avant remplacement (dossier data/ia/tableaux-backups/)'
    };
    if (!confirme) return { effectue: false, ...apercu, message: "AUCUNE modification faite. Montre cet aperçu à l'utilisateur, puis rappelle l'outil avec confirme: true seulement après son accord explicite." };
    if (identique) return { effectue: false, ...apercu };

    let sauvegarde: string | undefined;
    if (avant !== null) sauvegarde = this.sauvegarder(urlPath, avant);
    if (!existe) {
      await this.ws({ type: 'lovelace/dashboards/create', url_path: urlPath, title: creer?.titre ?? urlPath, icon: creer?.icone ?? 'mdi:view-dashboard', show_in_sidebar: true, require_admin: false, mode: 'storage' });
    }
    await this.ws({ type: 'lovelace/config/save', config, ...(urlPath ? { url_path: urlPath } : {}) });
    return { effectue: true, ...apercu, ...(sauvegarde ? { sauvegarde } : {}) };
  }

  /** Préférences du tableau Énergie. */
  async lireEnergie(): Promise<unknown> {
    try {
      return await this.ws({ type: 'energy/get_prefs' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not_found|not found/i.test(msg)) return { configure: false, note: "le tableau Énergie n'est pas encore configuré" };
      throw e;
    }
  }

  async deposerEnergie(prefs: unknown, confirme: boolean): Promise<unknown> {
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('« prefs » doit être un objet (energy_sources, device_consumption…)');
    const permis = ['energy_sources', 'device_consumption', 'device_consumption_water'];
    const inconnus = Object.keys(prefs).filter((k) => !permis.includes(k));
    if (inconnus.length) throw new Error(`Clés non gérées : ${inconnus.join(', ')} (permises : ${permis.join(', ')})`);
    const avant = await this.lireEnergie();
    const apercu = {
      action: 'energie',
      modifie: Object.keys(prefs),
      avant: Object.fromEntries(Object.keys(prefs).map((k) => [k, ((avant as Record<string, unknown>)?.[k] as unknown[] | undefined)?.length ?? 0])),
      apres: Object.fromEntries(Object.entries(prefs as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.length : '?'])),
      note: "Seules les clés données sont remplacées (les autres restent). Chaque clé est remplacée ENTIÈRE : renvoyer la liste complète voulue.",
      annuler: 'redéposer la sauvegarde faite avant (dossier data/ia/tableaux-backups/)'
    };
    if (!confirme) return { effectue: false, ...apercu, message: "AUCUNE modification faite. Montre cet aperçu à l'utilisateur, puis rappelle l'outil avec confirme: true seulement après son accord explicite." };
    const sauvegarde = this.sauvegarder('energie', avant);
    await this.ws({ type: 'energy/save_prefs', ...(prefs as Record<string, unknown>) });
    return { effectue: true, ...apercu, sauvegarde };
  }

  private sauvegarder(nom: string | null, contenu: unknown): string {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const base = nom ?? 'lovelace';
    const fichier = `${base}__${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(this.backupDir, fichier), JSON.stringify(contenu, null, 2), 'utf8');
    const anciens = fs.readdirSync(this.backupDir).filter((f) => f.startsWith(`${base}__`)).sort();
    for (const f of anciens.slice(0, Math.max(0, anciens.length - MAX_SAUVEGARDES))) fs.unlinkSync(path.join(this.backupDir, f));
    return fichier;
  }
}
