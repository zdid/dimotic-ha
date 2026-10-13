/**
 * Client minimal de l'API du moteur Docker par son socket Unix (fonctionnelles-esphome_specs §5.1, conception §11.1) :
 * pas de client Docker dans l'image, seulement HTTP sur le socket. Sert à inspecter, démarrer le conteneur ESPHome et
 * y lancer des commandes (`esphome compile`, `esphome upload`, `esptool`), sortie lue en direct.
 */

import * as http from 'node:http';

export interface ResultatExec {
  codeSortie: number;
  sortie: string;
}

export interface DockerClient {
  etat(conteneur: string): Promise<{ existe: boolean; enMarche: boolean }>;
  demarrer(conteneur: string): Promise<void>;
  exec(conteneur: string, commande: string[], options?: { surSortie?: (morceau: string) => void; delaiMs?: number }): Promise<ResultatExec>;
}

type Reponse = { statut: number; corps: Buffer };

export class DockerApi implements DockerClient {
  constructor(private readonly socket: string) {}

  private requete(methode: string, chemin: string, corps?: unknown, flux?: (b: Buffer) => void, delaiMs = 30_000): Promise<Reponse> {
    return new Promise((resolve, reject) => {
      const charge = corps === undefined ? undefined : Buffer.from(JSON.stringify(corps));
      const req = http.request(
        { socketPath: this.socket, method: methode, path: chemin, headers: charge ? { 'Content-Type': 'application/json', 'Content-Length': charge.length } : {} },
        (res) => {
          const morceaux: Buffer[] = [];
          res.on('data', (b: Buffer) => (flux ? flux(b) : morceaux.push(b)));
          res.on('end', () => resolve({ statut: res.statusCode ?? 0, corps: Buffer.concat(morceaux) }));
          res.on('error', reject);
        }
      );
      req.setTimeout(delaiMs, () => req.destroy(new Error(`Docker : délai dépassé (${chemin})`)));
      req.on('error', reject);
      if (charge) req.write(charge);
      req.end();
    });
  }

  private json<T>(r: Reponse): T {
    return JSON.parse(r.corps.toString('utf8')) as T;
  }

  async etat(conteneur: string): Promise<{ existe: boolean; enMarche: boolean }> {
    const r = await this.requete('GET', `/containers/${encodeURIComponent(conteneur)}/json`);
    if (r.statut === 404) return { existe: false, enMarche: false };
    if (r.statut !== 200) throw new Error(`Docker : inspection de ${conteneur} refusée (${r.statut})`);
    return { existe: true, enMarche: this.json<{ State: { Running: boolean } }>(r).State.Running === true };
  }

  async demarrer(conteneur: string): Promise<void> {
    const r = await this.requete('POST', `/containers/${encodeURIComponent(conteneur)}/start`);
    if (r.statut !== 204 && r.statut !== 304) throw new Error(`Docker : démarrage de ${conteneur} refusé (${r.statut}) ${r.corps.toString('utf8').slice(0, 200)}`);
  }

  async exec(conteneur: string, commande: string[], options: { surSortie?: (morceau: string) => void; delaiMs?: number } = {}): Promise<ResultatExec> {
    const delai = options.delaiMs ?? 30 * 60_000;
    const creation = await this.requete('POST', `/containers/${encodeURIComponent(conteneur)}/exec`, { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: commande });
    if (creation.statut !== 201) throw new Error(`Docker : exec refusé (${creation.statut}) ${creation.corps.toString('utf8').slice(0, 200)}`);
    const id = this.json<{ Id: string }>(creation).Id;

    // Flux multiplexé : trames de 8 octets d'en-tête (type, 0, 0, 0, taille sur 4 octets) puis la charge ; une trame peut être coupée entre deux morceaux.
    let reste = Buffer.alloc(0);
    let sortie = '';
    const demux = (b: Buffer): void => {
      reste = Buffer.concat([reste, b]);
      while (reste.length >= 8) {
        const taille = reste.readUInt32BE(4);
        if (reste.length < 8 + taille) break;
        const texte = reste.subarray(8, 8 + taille).toString('utf8');
        reste = reste.subarray(8 + taille);
        sortie += texte;
        options.surSortie?.(texte);
      }
    };
    const demarrage = await this.requete('POST', `/exec/${id}/start`, { Detach: false, Tty: false }, demux, delai);
    if (demarrage.statut !== 200) throw new Error(`Docker : lancement de la commande refusé (${demarrage.statut})`);
    const fin = await this.requete('GET', `/exec/${id}/json`);
    return { codeSortie: this.json<{ ExitCode: number }>(fin).ExitCode, sortie };
  }
}
