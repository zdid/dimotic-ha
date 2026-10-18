/**
 * Étiquettes (labels) de Home Assistant pour les outils MCP `lire_etiquettes_ha` et `etiqueter_ha` — par les commandes
 * WebSocket `config/label_registry/…` et `config/entity_registry/update` via l'appel générique du cœur (jeton
 * administrateur requis). Les étiquettes rangent les automatisations/scripts dans le tableau « Automatisations ».
 *
 * Garde-fous : sans `confirme: true`, aperçu seulement ; une étiquette inconnue n'est créée que si `creer: true`
 * (sinon refus, pour éviter une faute de frappe qui créerait une carte fantôme) ; l'identifiant d'étiquette est
 * le nom sans accents ni majuscules (comme le fait HA).
 */

import type { HaBridgeClient } from '../../../core/dist/exports';

type Ws = Pick<HaBridgeClient, 'callWs'>;

interface Etiquette { label_id: string; name: string; icon?: string | null }
interface Entite { entity_id: string; labels?: string[] }

function norm(texte: string): string {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Identifiant que HA donne à une étiquette créée (slug avec « _ »). */
function slugEtiquette(nom: string): string {
  return nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export class HaEtiquetteClient {
  constructor(private readonly ha: Ws) {}

  private ws<T = unknown>(message: Record<string, unknown>): Promise<T> {
    return this.ha.callWs(message, 30000) as Promise<T>;
  }

  /** Étiquettes existantes, avec le nombre d'automatisations/scripts qui les portent. */
  async lire(): Promise<unknown> {
    const [etiquettes, entites] = await Promise.all([
      this.ws<Etiquette[]>({ type: 'config/label_registry/list' }),
      this.ws<Entite[]>({ type: 'config/entity_registry/list' })
    ]);
    const rangables = entites.filter((e) => /^(automation|script)\./.test(e.entity_id));
    return {
      etiquettes: etiquettes.map((l) => ({
        id: l.label_id,
        nom: l.name,
        icone: l.icon ?? null,
        automatisationsEtScripts: rangables.filter((e) => (e.labels ?? []).includes(l.label_id)).map((e) => e.entity_id)
      })),
      sansEtiquette: rangables.filter((e) => !(e.labels ?? []).length).map((e) => e.entity_id)
    };
  }

  /**
   * Pose des étiquettes sur des entités. mode « ajouter » (défaut) garde les étiquettes déjà posées, « remplacer »
   * les écrase, « retirer » enlève celles données.
   */
  async etiqueter(
    entites: string[],
    etiquettes: string[],
    mode: 'ajouter' | 'remplacer' | 'retirer',
    creer: boolean,
    confirme: boolean
  ): Promise<unknown> {
    if (!entites.length) throw new Error('Aucune entité donnée.');
    if (!etiquettes.length && mode !== 'remplacer') throw new Error('Aucune étiquette donnée.');
    const [registre, existantes] = await Promise.all([
      this.ws<Etiquette[]>({ type: 'config/label_registry/list' }),
      this.ws<Entite[]>({ type: 'config/entity_registry/list' })
    ]);

    const aCreer: string[] = [];
    const ids: string[] = [];
    for (const demande of etiquettes) {
      const trouvee = registre.find((l) => l.label_id === demande) ?? registre.find((l) => norm(l.name) === norm(demande));
      if (trouvee) ids.push(trouvee.label_id);
      else if (mode === 'retirer') continue;
      else if (!creer) throw new Error(`Étiquette « ${demande} » inconnue (existantes : ${registre.map((l) => l.name).join(', ') || 'aucune'}). Repasser creer:true pour la créer, après accord de l'utilisateur.`);
      else { aCreer.push(demande); ids.push(slugEtiquette(demande)); }
    }

    const plan = entites.map((entityId) => {
      const reg = existantes.find((e) => e.entity_id === entityId);
      if (!reg) throw new Error(`Entité ${entityId} absente du registre des entités (pas d'unique_id : étiquette impossible).`);
      const avant = reg.labels ?? [];
      const apres = mode === 'remplacer' ? [...new Set(ids)]
        : mode === 'retirer' ? avant.filter((l) => !ids.includes(l))
        : [...new Set([...avant, ...ids])];
      return { entityId, avant, apres };
    });

    if (!confirme) {
      return { apercu: true, etiquettesACreer: aCreer, modifications: plan, note: aCreer.length ? 'Une nouvelle étiquette = une carte à ajouter au tableau « Automatisations » (lire_tableaux_de_bord / deposer_tableau_de_bord).' : undefined };
    }

    for (const nom of aCreer) {
      const cree = await this.ws<Etiquette>({ type: 'config/label_registry/create', name: nom.charAt(0).toUpperCase() + nom.slice(1) });
      const devine = slugEtiquette(nom);
      if (cree?.label_id && cree.label_id !== devine) for (const p of plan) p.apres = p.apres.map((l) => (l === devine ? cree.label_id : l));
    }
    for (const p of plan) await this.ws({ type: 'config/entity_registry/update', entity_id: p.entityId, labels: p.apres });
    return { applique: true, etiquettesCreees: aCreer, modifications: plan };
  }
}
