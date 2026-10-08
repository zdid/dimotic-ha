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

/** Les trois outils de Mistral, au format MCP, puis ceux propres à Claude Code. */
export const MCP_TOOLS: McpToolDef[] = [
  ...IA_TOOLS.map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })),
  ...MCP_ONLY_TOOLS
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
}

export class McpToolbox {
  constructor(private readonly deps: McpToolboxDeps) {}

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'obtenir_details': return JSON.stringify(await this.details(args), null, 2);
      case 'diagnostiquer_resolution': return JSON.stringify(await this.diagnose(args), null, 2);
      case 'tester_phrase': return JSON.stringify(await this.deps.simulate(String(args.phrase ?? ''), args.utiliser_mistral === true), null, 2);
      default:
        return this.deps.toolExecutor.execute({ id: `mcp-${Date.now()}`, type: 'function', function: { name, arguments: args } });
    }
  }

  private async details(args: Record<string, unknown>): Promise<unknown> {
    const registry = this.deps.registry;
    if (!registry.isAvailable()) return { error: 'référentiel HA indisponible' };
    const limit = Math.min(Math.max(Number(args.limite) || 20, 1), MAX_DETAILS);

    const entities = typeof args.entity_id === 'string' && args.entity_id
      ? [registry.getEntity(args.entity_id)].filter((e) => e !== undefined)
      : await registry.getEntitiesByQuoiAndLieux(
          typeof args.quoi === 'string' && args.quoi ? slugify(args.quoi) : undefined,
          Array.isArray(args.lieux) ? (args.lieux as string[]) : []
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
          classement: {
            quoi: taxonomy.quoi ?? taxonomy.slug_quoi,
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
    const find = (slug: string | undefined, ls: string[]) => registry.getEntitiesByQuoiAndLieux(slug, ls);

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
