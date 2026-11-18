/**
 * Aides « modèle » (template) de Home Assistant créées dans l'interface (outils MCP `lire_aide_calculee` et
 * `modifier_aide_calculee`, specs ia v1.44 §19.11undecies).
 *
 * La formule d'une telle aide est dans les `options` d'une config entry du domaine `template` (.storage/core.config_entries,
 * fichier qui contient aussi les secrets de toutes les intégrations : JAMAIS lu directement). Elle n'apparaît ni dans le registre
 * des entités ni dans `config_entries/get`. Chemin retenu : le « options flow » de l'entrée (REST), qui renvoie la formule en
 * valeur suggérée ; on l'ouvre, on lit, on l'abandonne. Pour modifier : on rouvre le flux et on renvoie TOUS les champs
 * (un champ facultatif omis serait effacé) avec la nouvelle formule.
 *
 * Garde-fous : domaine `template` seulement ; sans `confirme: true`, aperçu (rendu de l'ancienne et de la nouvelle formule par
 * /api/template, erreur de rendu = refus) ; l'ancienne formule est rendue pour pouvoir revenir en arrière. Les templates écrits
 * en YAML ne sont pas des config entries : ils sont signalés comme non modifiables.
 */

import type { HaBridgeClient } from '../../../core/dist/exports';

type Pont = Pick<HaBridgeClient, 'callWs' | 'callRest'>;

interface Entree { entry_id: string; domain: string; title?: string | null }
interface Entite { entity_id: string; config_entry_id?: string | null; name?: string | null; original_name?: string | null }
interface Etat { entity_id: string; state: string; attributes?: Record<string, unknown> }
interface Champ { name: string; required?: boolean; description?: { suggested_value?: unknown }; default?: unknown }
interface Flux { type?: string; flow_id?: string; step_id?: string; data_schema?: Champ[]; errors?: Record<string, string> | null; description_placeholders?: unknown; menu_options?: unknown }

const BASE = '/api/config/config_entries/options/flow';

function normaliser(t: string): string {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** Valeurs actuelles d'un formulaire d'options (valeur suggérée, sinon défaut). */
export function valeursDuFormulaire(flux: Flux): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const c of flux.data_schema ?? []) {
    const val = c.description?.suggested_value ?? c.default;
    if (val !== undefined && val !== null) v[c.name] = val;
  }
  return v;
}

export class HaAideCalculeeClient {
  constructor(private readonly ha: Pont) {}

  private async charger(): Promise<{ entrees: Entree[]; entites: Entite[]; etats: Etat[] }> {
    const [entrees, entites, etats] = await Promise.all([
      this.ha.callWs({ type: 'config_entries/get', domain: 'template' }) as Promise<Entree[]>,
      this.ha.callWs({ type: 'config/entity_registry/list' }) as Promise<Entite[]>,
      this.ha.callWs({ type: 'get_states' }) as Promise<Etat[]>
    ]);
    return { entrees: entrees.filter((e) => e.domain === 'template'), entites, etats };
  }

  /** Trouve l'entrée : entry_id, entity_id, ou titre/nom (exact, sinon partiel et unique). */
  private trouver(cible: string, entrees: Entree[], entites: Entite[], etats: Etat[]): { entree: Entree; entite?: Entite } {
    const c = cible.trim();
    if (!c) throw new Error('cible manquante : entity_id, entry_id ou nom de l\'aide calculée');
    const parId = entrees.find((e) => e.entry_id === c);
    if (parId) return { entree: parId, entite: entites.find((x) => x.config_entry_id === parId.entry_id) };
    const ent = entites.find((e) => e.entity_id === c);
    if (ent) {
      const e = entrees.find((x) => x.entry_id === ent.config_entry_id);
      if (!e) throw new Error(`${c} n'est pas une aide « modèle » créée dans l'interface (config entry template introuvable) : si elle est écrite en YAML, elle n'est pas modifiable par l'API`);
      return { entree: e, entite: ent };
    }
    const n = normaliser(c);
    const nomDe = (e: Entree) => {
      const x = entites.find((y) => y.config_entry_id === e.entry_id);
      const fn = x ? (etats.find((s) => s.entity_id === x.entity_id)?.attributes?.friendly_name as string | undefined) : undefined;
      return [e.title ?? '', x?.name ?? '', x?.original_name ?? '', fn ?? ''].map(normaliser);
    };
    const exacts = entrees.filter((e) => nomDe(e).includes(n));
    if (exacts.length === 1) return { entree: exacts[0], entite: entites.find((x) => x.config_entry_id === exacts[0].entry_id) };
    const partiels = entrees.filter((e) => nomDe(e).some((t) => t.includes(n)));
    if (partiels.length === 1) return { entree: partiels[0], entite: entites.find((x) => x.config_entry_id === partiels[0].entry_id) };
    if (partiels.length > 1) throw new Error(`Plusieurs aides correspondent à « ${c} » : ${partiels.slice(0, 10).map((e) => `${e.title} (${e.entry_id})`).join(' ; ')}`);
    throw new Error(`Aucune aide « modèle » ne correspond à « ${c} » (voir lire_aide_calculee sans cible pour la liste)`);
  }

  private async ouvrirFlux(entryId: string): Promise<Flux> {
    const r = await this.ha.callRest('POST', BASE, { handler: entryId });
    const f = r.body as Flux;
    if (r.status >= 400 || !f?.flow_id) throw new Error(`Ouverture du formulaire de l'aide impossible (HTTP ${r.status}) : ${JSON.stringify(r.body).slice(0, 300)}`);
    return f;
  }

  private async abandonner(flowId: string | undefined): Promise<void> {
    if (!flowId) return;
    try { await this.ha.callRest('DELETE', `${BASE}/${flowId}`); } catch { /* flux déjà terminé */ }
  }

  /** Rend une formule par /api/template ; renvoie le texte ou l'erreur. */
  private async rendre(formule: string): Promise<{ ok: boolean; texte: string }> {
    const r = await this.ha.callRest('POST', '/api/template', { template: formule });
    const texte = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { ok: r.status < 400, texte: texte.slice(0, 500) };
  }

  /** Sans cible : liste des aides ; avec cible : formule et champs. */
  async lire(cible?: string): Promise<unknown> {
    const { entrees, entites, etats } = await this.charger();
    if (!cible || !cible.trim()) {
      return {
        aides_calculees: entrees.map((e) => {
          const x = entites.find((y) => y.config_entry_id === e.entry_id);
          return { entry_id: e.entry_id, titre: e.title ?? null, entity_id: x?.entity_id ?? null, valeur: x ? etats.find((s) => s.entity_id === x.entity_id)?.state ?? null : null };
        }),
        note: 'Seules les aides « modèle » créées dans l\'interface sont listées (celles écrites en YAML sont invisibles et non modifiables par l\'API).'
      };
    }
    const { entree, entite } = this.trouver(cible, entrees, entites, etats);
    const flux = await this.ouvrirFlux(entree.entry_id);
    try {
      const champs = valeursDuFormulaire(flux);
      const etat = entite ? etats.find((s) => s.entity_id === entite.entity_id) : undefined;
      const formule = typeof champs.state === 'string' ? champs.state : null;
      const { state: _omis, ...autres } = champs;
      return {
        entry_id: entree.entry_id,
        titre: entree.title ?? null,
        entity_id: entite?.entity_id ?? null,
        valeur_actuelle: etat?.state ?? null,
        unite: etat?.attributes?.unit_of_measurement ?? null,
        formule,
        autres_champs: autres,
        ...(formule === null ? { remarque: `formulaire inattendu (étape « ${flux.step_id ?? '?'} », champs : ${(flux.data_schema ?? []).map((c) => c.name).join(', ')}) : cette aide n'est peut-être pas un capteur modèle` } : {})
      };
    } finally {
      await this.abandonner(flux.flow_id);
    }
  }

  async modifier(cible: string, formule: string, confirme: boolean): Promise<unknown> {
    if (!formule || !formule.trim()) throw new Error('formule manquante');
    const { entrees, entites, etats } = await this.charger();
    const { entree, entite } = this.trouver(cible, entrees, entites, etats);
    const flux = await this.ouvrirFlux(entree.entry_id);
    let termine = false;
    try {
      const champs = valeursDuFormulaire(flux);
      if (typeof champs.state !== 'string') {
        throw new Error(`Formulaire inattendu (étape « ${flux.step_id ?? '?'} », champs : ${(flux.data_schema ?? []).map((c) => c.name).join(', ')}) : seul un capteur modèle (champ « state ») est modifiable`);
      }
      const avant = champs.state;
      const nouvelle = formule.trim();
      const [rAvant, rApres] = await Promise.all([this.rendre(avant), this.rendre(nouvelle)]);
      if (!rApres.ok) throw new Error(`Formule refusée : le rendu échoue (${rApres.texte})`);
      const apercu = {
        entry_id: entree.entry_id,
        entity_id: entite?.entity_id ?? null,
        titre: entree.title ?? null,
        formule_avant: avant,
        formule_apres: nouvelle,
        rendu_avant: rAvant.texte,
        rendu_apres: rApres.texte,
        annuler: `modifier_aide_calculee cible=${entree.entry_id} formule=${JSON.stringify(avant)} confirme=true`
      };
      if (!confirme) return { apercu: true, ...apercu, note: 'Rien n\'a été modifié. Refaire l\'appel avec confirme:true après accord de l\'utilisateur.' };

      const envoi = { ...champs, state: nouvelle };
      const r = await this.ha.callRest('POST', `${BASE}/${flux.flow_id}`, envoi);
      termine = true;
      const rep = r.body as Flux;
      if (r.status >= 400 || rep?.type === 'form') {
        termine = false;
        throw new Error(`Enregistrement refusé par HA (HTTP ${r.status}) : ${JSON.stringify(rep?.errors ?? r.body).slice(0, 300)}`);
      }
      if (rep?.type !== 'create_entry') {
        throw new Error(`Réponse inattendue de HA : ${JSON.stringify(r.body).slice(0, 300)}`);
      }
      return { fait: true, ...apercu, note: 'Formule enregistrée, l\'entité est rechargée par HA. Relire avec lire_aide_calculee pour vérifier la valeur.' };
    } finally {
      if (!termine) await this.abandonner(flux.flow_id);
    }
  }
}
