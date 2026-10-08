/**
 * Outils exposés à Claude Code par le serveur MCP (specs ia v1.19 §19) :
 *  - les trois outils déjà donnés à Mistral (tools.ts) — mêmes schémas, même ToolExecutor ;
 *  - trois outils de LECTURE propres à Claude Code, qui n'agissent jamais sur la maison :
 *      obtenir_details            attributs réels + classement quoi/lieu des entités
 *      diagnostiquer_resolution   « pourquoi cette entité (ne) ressort (pas) ? »
 *      tester_phrase              simulation d'une phrase dans le pipeline d'ia, sans rien exécuter
 */

import type { HaBridgeClient } from '../../../core/dist/exports';
import type { McpToolDef } from './McpHttpServer';
import { IA_TOOLS } from './tools';
import type { ToolExecutor } from './ToolExecutor';
import type { PlannerReader, PlannerSection } from './PlannerReader';
import type { HaAutomationClient } from './HaAutomationClient';

const CONFIRM_PROP = { type: 'boolean', description: 'false/absent = APERÇU seulement (rien n\'est modifié). true = exécute, À N\'UTILISER QU\'APRÈS l\'accord explicite de l\'utilisateur sur l\'aperçu.' };

/** Outils d'écriture des automatisations HA (niveau 2) : aperçu d'abord, sauvegarde avant remplacement. */
export const HA_AUTOMATION_TOOLS: McpToolDef[] = [
  {
    name: 'lire_automatisations_ha',
    description: 'Lit les automatisations de Home Assistant (lecture seule). Sans paramètre : liste (id, nom, état, dernière exécution). Avec id : définition complète. Avec sauvegardes=true : sauvegardes disponibles (et leur contenu si fichier est donné).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant de configuration de l\'automatisation (champ id, pas l\'entity_id)' },
        sauvegardes: { type: 'boolean', description: 'Lister les sauvegardes faites avant remplacement/suppression (filtrées par id si donné)' },
        fichier: { type: 'string', description: 'Nom d\'un fichier de sauvegarde à lire (avec sauvegardes=true)' }
      }
    }
  },
  {
    name: 'deposer_automatisation',
    description: 'DÉPOSE (crée ou remplace) une automatisation dans Home Assistant, puis recharge les automatisations. Sans confirme:true, renvoie seulement un aperçu et ne modifie RIEN. L\'existant est sauvegardé avant remplacement. Respecte l\'anti-boucle : from/to explicites, mode single, condition de garde.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Identifiant stable de l\'automatisation (lettres, chiffres, _ et -)' },
        definition: { type: 'object', description: 'Définition JSON de l\'automatisation, comme son YAML : alias, description, mode, trigger(s), condition(s), action(s)' },
        confirme: CONFIRM_PROP
      },
      required: ['id', 'definition']
    }
  },
  {
    name: 'supprimer_automatisation',
    description: 'SUPPRIME une automatisation de Home Assistant. Sans confirme:true, renvoie seulement un aperçu. La définition est sauvegardée avant suppression.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Identifiant de configuration' }, confirme: CONFIRM_PROP }, required: ['id'] }
  }
];

/** lister_entites côté MCP : comme celui de Mistral + filtre de catégorie HA (réglages / diagnostic). Mistral n'est pas modifié. */
const LISTER_ENTITES_MCP: McpToolDef = {
  name: 'lister_entites',
  description: "Liste les entités Home Assistant connues correspondant à un filtre QUOI/OÙ (les deux paramètres sont optionnels — absents, retourne toutes les entités). Chaque entité porte sa `categorie` HA : 'principale' (commande/mesure), 'config' (réglage : seuils, modes…) ou 'diagnostic'. `categorie` filtre dessus ; sans lui, toutes sont renvoyées (comportement habituel).",
  inputSchema: {
    type: 'object',
    properties: {
      quoi: { type: 'string', description: 'Catégorie QUOI (ex: "lumière", "température")' },
      lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux à filtrer. Plusieurs lieux = l\'un OU l\'autre. Un repère précis avec un lieu = les deux à la fois (ex: ["plafonnier de la chambre"]).' },
      categorie: { type: 'string', enum: ['principale', 'config', 'diagnostic', 'toutes'], description: "Ne garder que les entités de cette catégorie HA (défaut : toutes). 'principale' écarte les réglages et le diagnostic." }
    }
  }
};

export const MCP_ONLY_TOOLS: McpToolDef[] = [
  {
    name: 'obtenir_details',
    description:
      "Détails réels d'entités (LECTURE SEULE) : état, attributs Home Assistant (luminosité, position, température, unité…) " +
      "et classement quoi/lieu précis/pièce/étage. À préférer à obtenir_etat quand on a besoin d'une valeur numérique ou de comprendre " +
      "comment une entité est classée. Donner entity_id, ou un filtre quoi/lieux comme lister_entites.",
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Identifiant exact (ex: light.plafonnier_chambre)' },
        quoi: { type: 'string', description: 'Catégorie QUOI (ex: "lumière")' },
        lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux (voir lister_entites)' },
        limite: { type: 'number', description: 'Nombre maximum d\'entités détaillées (défaut 20, max 50)' }
      }
    }
  },
  {
    name: 'diagnostiquer_resolution',
    description:
      "Explique comment une demande quoi/lieux est résolue (LECTURE SEULE) : le quoi et chaque lieu existent-ils, combien d'entités " +
      "chacun donne seul puis combinés, et les noms proches du catalogue en cas de faute. À utiliser quand lister_entites ne retourne " +
      "pas ce qu'on attend.",
    inputSchema: {
      type: 'object',
      properties: {
        quoi: { type: 'string', description: 'Catégorie QUOI demandée' },
        lieux: { type: 'array', items: { type: 'string' }, description: 'Lieux demandés' }
      }
    }
  },
  {
    name: 'tester_phrase',
    description:
      "Simule une phrase domotique SANS rien exécuter (ni action, ni création de planification) : indique si elle est déjà en cache, " +
      "si l'interpréteur déterministe la reconnaît (énoncés décodés et entités visées) et, seulement si utiliser_mistral vaut true, " +
      "ce que Mistral en ferait en mode simulation (appel facturé).",
    inputSchema: {
      type: 'object',
      properties: {
        phrase: { type: 'string', description: 'Phrase à tester, comme dite à la maison (ex: "allume le plafonnier de la chambre")' },
        utiliser_mistral: { type: 'boolean', description: 'Si la phrase n\'est pas reconnue localement, interroger aussi Mistral en simulation (défaut false)' }
      },
      required: ['phrase']
    }
  }
];

MCP_ONLY_TOOLS.push({
  name: 'lire_planificateur',
  description:
    "Lit les données du planificateur (LECTURE SEULE, rien n'est modifié) : planifications et macros existantes, ce que le " +
    "planificateur a reçu de l'assistant (actions_recues), et ce qui a réellement été envoyé à Home Assistant à chaque exécution " +
    "(commandes_ha : résolu ou non, entité visée, erreur). Sections : statut, planifications, macros, actions_recues, " +
    "commandes_ha, yaml. Sans `nom`, planifications et macros sont résumées ; avec `nom`, la définition complète.",
  inputSchema: {
    type: 'object',
    properties: {
      section: { type: 'string', enum: ['statut', 'planifications', 'macros', 'actions_recues', 'commandes_ha', 'yaml'], description: 'Donnée à lire' },
      nom: { type: 'string', description: 'Nom (ou numéro, pour une planification) d\'une planification ou macro : définition complète. Obligatoire pour yaml.' },
      limite: { type: 'number', description: 'Nombre maximum d\'éléments pour actions_recues et commandes_ha (défaut 10, max 30)' }
    },
    required: ['section']
  }
});

/** Les trois outils de Mistral, au format MCP, puis ceux propres à Claude Code. */
export const MCP_TOOLS: McpToolDef[] = [
  ...IA_TOOLS.map((t) => t.function.name === 'lister_entites' ? LISTER_ENTITES_MCP : ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })),
  ...MCP_ONLY_TOOLS,
  ...HA_AUTOMATION_TOOLS
];

const NOISY_ATTRIBUTES = new Set(['entity_picture', 'icon', 'supported_features', 'attribution', 'friendly_name', 'editable', 'restored', 'attributs_taxonomie']);
const MAX_DETAILS = 50;

function slugify(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Noms du catalogue proches de `term` (fautes de frappe, pluriel, mot contenu) — jamais plus de 3. */
function closest(term: string, candidates: string[]): string[] {
  const t = slugify(term);
  if (!t) return [];
  return candidates
    .map((name) => ({ name, d: slugify(name).includes(t) || t.includes(slugify(name)) ? 0 : distance(t, slugify(name)) }))
    .filter((c) => c.d <= Math.max(2, Math.floor(t.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((c) => c.name);
}

/** actions_recues porte `request`/`reply` en TEXTE JSON : les rendre structurés pour qu'ils se lisent. */
function parseJsonStrings(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    if ((key === 'request' || key === 'reply') && typeof value === 'string') {
      try { out[key] = JSON.parse(value); continue; } catch { /* texte brut conservé */ }
    }
    out[key] = value;
  }
  return out;
}

function trimValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (Array.isArray(value)) return value.length > 20 ? [...value.slice(0, 20).map(trimValue), `… (${value.length} éléments)`] : value.map(trimValue);
  return value;
}

export interface McpToolboxDeps {
  toolExecutor: ToolExecutor;
  registry: HaBridgeClient;
  excludedQuoiIds: () => string[];
  /** Simulation d'une phrase (IaService.simulatePhrase). */
  simulate: (phrase: string, useMistral: boolean) => Promise<unknown>;
  /** Lecture du planificateur (PlannerReader). */
  planner: PlannerReader;
  /** Automatisations HA (lecture / dépôt / suppression, via le pont REST du core). */
  automations: HaAutomationClient;
}

export class McpToolbox {
  constructor(private readonly deps: McpToolboxDeps) {}

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'obtenir_details': return JSON.stringify(await this.details(args), null, 2);
      case 'diagnostiquer_resolution': return JSON.stringify(await this.diagnose(args), null, 2);
      case 'lire_planificateur': return JSON.stringify(await this.readPlanner(args), null, 2);
      case 'lire_automatisations_ha': return JSON.stringify(await this.readAutomations(args), null, 2);
      case 'deposer_automatisation': return JSON.stringify(await this.deps.automations.deposit(String(args.id ?? ''), args.definition, args.confirme === true), null, 2);
      case 'supprimer_automatisation': return JSON.stringify(await this.deps.automations.remove(String(args.id ?? ''), args.confirme === true), null, 2);
      case 'lister_entites': return this.listEntities(args);
      case 'tester_phrase': return JSON.stringify(await this.deps.simulate(String(args.phrase ?? ''), args.utiliser_mistral === true), null, 2);
      default:
        return this.deps.toolExecutor.execute({ id: `mcp-${Date.now()}`, type: 'function', function: { name, arguments: args } });
    }
  }

  /** lister_entites : résolution identique à Mistral (ToolExecutor), puis catégorie HA et filtre optionnel. */
  private async listEntities(args: Record<string, unknown>): Promise<string> {
    if (!this.deps.registry.isAvailable()) return JSON.stringify({ error: 'référentiel HA indisponible' });
    const quoi = typeof args.quoi === 'string' && args.quoi ? slugify(args.quoi) : undefined;
    const lieux = Array.isArray(args.lieux) ? (args.lieux as string[]) : [];
    // includeTechnical : côté MCP on voit TOUT (avec la catégorie) ; Mistral, lui, n'a que les entités « utilisateur ».
    const all = await this.deps.registry.getEntitiesByQuoiAndLieux(quoi, lieux, true);
    const wanted = typeof args.categorie === 'string' ? args.categorie : 'toutes';
    const entities = all
      .map((e) => ({ entity_id: e.entity_id, name: e.friendly_name, categorie: e.entity_category ?? 'principale', ...(e.disabled_by ? { desactivee_par: e.disabled_by } : {}) }))
      .filter((e) => wanted === 'toutes' || e.categorie === wanted);
    return JSON.stringify({ entities, ...(wanted !== 'toutes' ? { filtre_categorie: wanted, ecartees: all.length - entities.length } : {}) });
  }

  private async readAutomations(args: Record<string, unknown>): Promise<unknown> {
    const automations = this.deps.automations;
    const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
    if (args.sauvegardes === true) {
      if (typeof args.fichier === 'string' && args.fichier) {
        const content = automations.readBackup(args.fichier);
        return content === undefined ? { error: `sauvegarde « ${args.fichier} » introuvable` } : { fichier: args.fichier, definition: content };
      }
      return { sauvegardes: automations.listBackups(id) };
    }
    if (id) {
      const read = await automations.get(id);
      return read.ok ? { id, definition: read.config } : { error: read.error };
    }
    const list = automations.list();
    return { total: list.length, automatisations: list };
  }

  private async readPlanner(args: Record<string, unknown>): Promise<unknown> {
    const section = String(args.section ?? '') as PlannerSection;
    const nom = typeof args.nom === 'string' && args.nom.trim() ? args.nom.trim() : undefined;
    const limit = Math.min(Math.max(Number(args.limite) || 10, 1), 30);
    const planner = this.deps.planner;

    if (section === 'yaml') {
      if (!nom) return { error: 'nom obligatoire pour la section yaml' };
      const read = await planner.readYaml(nom);
      return read.data === undefined ? { error: `planificateur n'a pas fourni le YAML de « ${nom} » (inconnue, ou planificateur ne répond pas)` } : { yaml: read.data, frais: read.frais };
    }
    if (!['statut', 'planifications', 'macros', 'actions_recues', 'commandes_ha'].includes(section)) {
      return { error: `section inconnue : ${section}` };
    }

    const read = await planner.read(section as Exclude<PlannerSection, 'yaml'>);
    if (read.data === undefined) return { error: 'planificateur ne répond pas et aucune donnée connue (application arrêtée ou désactivée ?)' };
    const meta = { frais: read.frais, recu_a: read.recu_a, ...(read.frais ? {} : { avertissement: 'planificateur n\'a pas répondu à temps : dernière donnée connue' }) };

    if (section === 'statut') return { ...meta, statut: read.data };

    if (section === 'planifications') {
      const plans = (read.data as Array<Record<string, unknown>>) ?? [];
      if (nom) {
        const found = plans.find((p) => p.name === nom || String(p.id) === nom);
        return found ? { ...meta, planification: found } : { ...meta, error: `planification « ${nom} » introuvable`, noms: plans.map((p) => `${p.id ?? '?'} : ${p.name}`) };
      }
      return {
        ...meta,
        total: plans.length,
        planifications: plans.map((p) => ({
          id: p.id, nom: p.name, active: p.active, phrase_originale: p.phrase_originale, declencheur: p.trigger,
          prochain_declenchement: p.next_fire_at, manquee: p.missed, anomalie: p.anomalie, terminee_le: p.completed_at
        }))
      };
    }

    if (section === 'macros') {
      const macros = (read.data as Array<{ name: string; steps?: unknown[] }>) ?? [];
      if (nom) {
        const found = macros.find((m) => m.name === nom);
        return found ? { ...meta, macro: found } : { ...meta, error: `macro « ${nom} » introuvable`, noms: macros.map((m) => m.name) };
      }
      return { ...meta, total: macros.length, macros: macros.map((m) => ({ nom: m.name, etapes: m.steps?.length ?? 0 })) };
    }

    // actions_recues / commandes_ha : les plus récentes d'abord (déjà l'ordre de planificateur)
    const list = Array.isArray(read.data) ? read.data : [];
    return { ...meta, total: list.length, elements: list.slice(0, limit).map(parseJsonStrings) };
  }

  private async details(args: Record<string, unknown>): Promise<unknown> {
    const registry = this.deps.registry;
    if (!registry.isAvailable()) return { error: 'référentiel HA indisponible' };
    const limit = Math.min(Math.max(Number(args.limite) || 20, 1), MAX_DETAILS);

    const entities = typeof args.entity_id === 'string' && args.entity_id
      ? [registry.getEntity(args.entity_id)].filter((e) => e !== undefined)
      : await registry.getEntitiesByQuoiAndLieux(
          typeof args.quoi === 'string' && args.quoi ? slugify(args.quoi) : undefined,
          Array.isArray(args.lieux) ? (args.lieux as string[]) : [],
          true
        );

    return {
      total: entities.length,
      tronque: entities.length > limit,
      entites: entities.slice(0, limit).map((e) => {
        const taxonomy = (e!.attributes?.attributs_taxonomie ?? {}) as Record<string, unknown>;
        const attributs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(e!.attributes ?? {})) {
          if (!NOISY_ATTRIBUTES.has(key)) attributs[key] = trimValue(value);
        }
        return {
          entity_id: e!.entity_id,
          nom: e!.friendly_name,
          domaine: e!.domain,
          device_class: e!.device_class,
          etat: e!.state,
          zone_ha: e!.area_id,
          categorie: e!.entity_category ?? 'principale',
          desactivee_par: e!.disabled_by ?? undefined,
          masquee_par: e!.hidden_by ?? undefined,
          integration: e!.platform,
          classement: {
            quoi: taxonomy.quoi ?? taxonomy.slug_quoi,
            quoi_appareil: taxonomy.quoi_appareil,
            lieu_precis: taxonomy.lieu_precis,
            lieu: taxonomy.lieu_principal,
            lieu_pere: taxonomy.lieu_pere,
            lieu_grand_pere: taxonomy.lieu_grand_pere
          },
          attributs
        };
      })
    };
  }

  private async diagnose(args: Record<string, unknown>): Promise<unknown> {
    const registry = this.deps.registry;
    if (!registry.isAvailable()) return { error: 'référentiel HA indisponible' };
    const quoi = typeof args.quoi === 'string' && args.quoi ? args.quoi : undefined;
    const lieux = Array.isArray(args.lieux) ? (args.lieux as string[]) : [];
    const quoiSlug = quoi ? slugify(quoi) : undefined;

    const excluded = new Set(this.deps.excludedQuoiIds());
    const quoiCatalog = registry.getQuoiCatalog().filter((q) => !excluded.has(q.quoi_id));
    const quoiNames = quoiCatalog.map((q) => q.label || q.quoi_id);
    const lieuNames = registry.getLieuCatalog(excluded);
    const find = (slug: string | undefined, ls: string[]) => registry.getEntitiesByQuoiAndLieux(slug, ls, true);

    const notes: string[] = [];
    const quoiInfo = quoiSlug
      ? await (async () => {
          const known = quoiCatalog.find((q) => q.quoi_id === quoiSlug || slugify(q.label || '') === quoiSlug);
          const count = (await find(quoiSlug, [])).length;
          if (!known && count === 0) notes.push(`« ${quoi} » n'est pas un QUOI connu.`);
          return { demande: quoi, connu: Boolean(known), entites: count, proches: known ? [] : closest(quoi!, quoiNames) };
        })()
      : undefined;

    const lieuxInfo = [];
    for (const lieu of lieux) {
      const seul = (await find(undefined, [lieu])).length;
      const avecQuoi = quoiSlug ? (await find(quoiSlug, [lieu])).length : seul;
      const connu = lieuNames.some((n) => slugify(n) === slugify(lieu));
      if (seul === 0) notes.push(`Aucune entité pour le lieu « ${lieu} », tous quoi confondus.`);
      else if (quoiSlug && avecQuoi === 0) notes.push(`Le lieu « ${lieu} » existe (${seul} entité(s)) mais aucune n'est de quoi « ${quoi} ».`);
      const proches = connu ? [] : closest(lieu, lieuNames);
      if (!connu && seul > 0) notes.push(`« ${lieu} » n'est pas un lieu du catalogue (entités trouvées seulement par leur nom)${proches.length ? ` — vouliez-vous dire : ${proches.join(', ')} ?` : ''}.`);
      lieuxInfo.push({ demande: lieu, dans_catalogue: connu, entites_tous_quoi: seul, entites_avec_ce_quoi: avecQuoi, proches });
    }

    const combine = await find(quoiSlug, lieux);
    if (combine.length === 0 && notes.length === 0) {
      notes.push('Chaque critère donne des entités séparément mais aucune ne les satisfait ensemble.');
    }

    return {
      demande: { quoi, lieux },
      resultat: { entites: combine.length, entity_ids: combine.slice(0, 30).map((e) => e.entity_id) },
      quoi: quoiInfo,
      lieux: lieuxInfo,
      remarques: notes
    };
  }
}
