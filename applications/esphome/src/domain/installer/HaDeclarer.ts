/**
 * Déclaration d'un appareil ESPHome dans Home Assistant et vérification (fonctionnelles-esphome_specs §3.10, §6.1 étapes 4-5).
 *
 * Tout passe par la liaison HA du cœur de CETTE instance (aucun jeton d'un HA sur une machine d'un autre site) :
 *  - `config_entries/get` (domaine esphome) et `config/device_registry/list` (WebSocket) : l'appareil existe-t-il, quelle version ;
 *  - flux de configuration REST `esphome` : adresse et port, puis clé de chiffrement, puis « autoriser les appels de service ».
 */

export interface ClientHa {
  callWs(message: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  callRest(method: 'GET' | 'POST' | 'DELETE', apiPath: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown }>;
}

export interface EntreeEsphome { entry_id: string; title: string; state: string; data?: { host?: string; device_name?: string } }
export interface AppareilHa { id: string; name: string; name_by_user?: string | null; sw_version?: string | null; config_entries: string[] }

export class ErreurHa extends Error {}

export interface CibleAppareil {
  appareil: string;
  nomAffichage: string;
  adresse: string;
}

export interface EtatHa {
  entree: EntreeEsphome | null;
  appareil: AppareilHa | null;
}

/** Entrée ESPHome de l'appareil : par nom réseau (`device_name`), sinon par adresse, sinon par titre (nom d'affichage). */
export function trouverEntree(entrees: EntreeEsphome[], c: CibleAppareil): EntreeEsphome | null {
  return (
    entrees.find((e) => e.data?.device_name === c.appareil) ??
    entrees.find((e) => e.data?.host === c.adresse) ??
    entrees.find((e) => e.title === c.nomAffichage) ??
    null
  );
}

export class HaDeclarer {
  constructor(private readonly ha: ClientHa) {}

  /** Lit l'état de l'appareil dans HA : son entrée ESPHome et son appareil (version du firmware). */
  async etat(c: CibleAppareil): Promise<EtatHa> {
    const entrees = (await this.ha.callWs({ type: 'config_entries/get', domain: 'esphome' })) as EntreeEsphome[];
    const entree = trouverEntree(entrees ?? [], c);
    if (!entree) return { entree: null, appareil: null };
    const appareils = (await this.ha.callWs({ type: 'config/device_registry/list' })) as AppareilHa[];
    const appareil = (appareils ?? []).find((a) => a.config_entries?.includes(entree.entry_id)) ?? null;
    return { entree, appareil };
  }

  /**
   * Déclare un appareil NEUF dans HA. `cle` : clé de chiffrement de l'API (seulement connue pour un appareil créé par l'usine).
   * Renvoie l'identifiant de l'entrée créée.
   */
  async declarer(opts: { adresse: string; portApi: number; cle?: string; autoriserAppelsService: boolean }): Promise<string> {
    const post = async (chemin: string, corps: unknown): Promise<any> => {
      const r = await this.ha.callRest('POST', chemin, corps);
      if (r.status >= 400) throw new ErreurHa(`HA a refusé (${r.status}) : ${JSON.stringify(r.body).slice(0, 200)}`);
      return r.body;
    };
    let flux = await post('/config/config_entries/flow', { handler: 'esphome', show_advanced_options: false });
    const id = flux.flow_id as string;
    for (let etape = 0; etape < 6 && flux.type === 'form'; etape++) {
      const champs: string[] = (flux.data_schema ?? []).map((f: { name: string }) => f.name);
      if (flux.step_id === 'user') flux = await post(`/config/config_entries/flow/${id}`, { host: opts.adresse, port: opts.portApi });
      else if (champs.includes('noise_psk')) {
        if (!opts.cle) throw new ErreurHa("l'appareil demande une clé de chiffrement qui n'est pas dans le message de pose (appareil déjà existant : la clé est dans le secrets.yaml de l'usine, api_<appareil>)");
        flux = await post(`/config/config_entries/flow/${id}`, { noise_psk: opts.cle });
      } else if (flux.step_id === 'discovery_confirm' || champs.length === 0) flux = await post(`/config/config_entries/flow/${id}`, {});
      else throw new ErreurHa(`étape inattendue du flux d'ajout ESPHome : ${flux.step_id} (${champs.join(', ')})`);
      if (flux.errors && Object.keys(flux.errors).length > 0 && flux.type === 'form') {
        throw new ErreurHa(`HA refuse l'ajout : ${JSON.stringify(flux.errors)}`);
      }
    }
    if (flux.type !== 'create_entry') throw new ErreurHa(`ajout de l'appareil dans HA non terminé (${flux.type}${flux.reason ? ' : ' + flux.reason : ''})`);
    const entryId: string = flux.result?.entry_id ?? flux.result;
    if (opts.autoriserAppelsService) await this.autoriserAppelsService(entryId);
    return entryId;
  }

  private async autoriserAppelsService(entryId: string): Promise<void> {
    const r = await this.ha.callRest('POST', '/config/config_entries/options/flow', { handler: entryId });
    if (r.status >= 400) throw new ErreurHa(`options de l'appareil refusées (${r.status})`);
    const flux = r.body as { flow_id: string; type: string; data_schema?: { name: string }[] };
    if (flux.type !== 'form') return;
    const champ = (flux.data_schema ?? []).map((f) => f.name).find((n) => /allow_service_calls/.test(n));
    if (!champ) return;
    const fin = await this.ha.callRest('POST', `/config/config_entries/options/flow/${flux.flow_id}`, { [champ]: true });
    if (fin.status >= 400) throw new ErreurHa(`options de l'appareil refusées (${fin.status})`);
  }
}
