import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DockerApi } from '../DockerApi';

const trame = (type: number, texte: string): Buffer => {
  const charge = Buffer.from(texte);
  const e = Buffer.alloc(8);
  e[0] = type;
  e.writeUInt32BE(charge.length, 4);
  return Buffer.concat([e, charge]);
};

let serveur: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (serveur ? serveur.close(() => r()) : r())));

function faux(routes: (req: http.IncomingMessage, res: http.ServerResponse, corps: string) => void): Promise<string> {
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dock-')), 'docker.sock');
  serveur = http.createServer((req, res) => {
    let corps = '';
    req.on('data', (c) => (corps += c));
    req.on('end', () => routes(req, res, corps));
  });
  return new Promise((r) => serveur!.listen(socket, () => r(socket)));
}

describe('DockerApi', () => {
  it('inspecte : conteneur en marche, arrêté, absent', async () => {
    const socket = await faux((req, res) => {
      if (req.url === '/containers/esphome/json') { res.writeHead(200); res.end(JSON.stringify({ State: { Running: false } })); }
      else if (req.url === '/containers/actif/json') { res.writeHead(200); res.end(JSON.stringify({ State: { Running: true } })); }
      else { res.writeHead(404); res.end('{}'); }
    });
    const d = new DockerApi(socket);
    expect(await d.etat('esphome')).toEqual({ existe: true, enMarche: false });
    expect(await d.etat('actif')).toEqual({ existe: true, enMarche: true });
    expect(await d.etat('inconnu')).toEqual({ existe: false, enMarche: false });
  });

  it('démarre un conteneur arrêté (204) ou déjà démarré (304), refuse sinon', async () => {
    const socket = await faux((req, res) => { res.writeHead(req.url!.includes('deja') ? 304 : req.url!.includes('casse') ? 500 : 204); res.end(); });
    const d = new DockerApi(socket);
    await expect(d.demarrer('esphome')).resolves.toBeUndefined();
    await expect(d.demarrer('deja')).resolves.toBeUndefined();
    await expect(d.demarrer('casse')).rejects.toThrow(/refusé/);
  });

  it('lance une commande, relit la sortie en direct (trames coupées comprises) et le code de sortie', async () => {
    let creation = '';
    const socket = await faux((req, res, corps) => {
      if (req.url === '/containers/esphome/exec') { creation = corps; res.writeHead(201); res.end(JSON.stringify({ Id: 'abc' })); }
      else if (req.url === '/exec/abc/start') {
        res.writeHead(200);
        const t1 = Buffer.concat([trame(1, 'Compiling...\n'), trame(2, 'RAM:   [=  ]  9.9% (used 1 bytes from 10 bytes)\n')]);
        res.write(t1.subarray(0, 11)); // coupe au milieu d'une trame
        setTimeout(() => { res.write(t1.subarray(11)); res.end(); }, 20);
      } else if (req.url === '/exec/abc/json') { res.writeHead(200); res.end(JSON.stringify({ ExitCode: 0 })); }
      else { res.writeHead(404); res.end(); }
    });
    const morceaux: string[] = [];
    const r = await new DockerApi(socket).exec('esphome', ['esphome', 'compile', '/config/x.yaml'], { surSortie: (m) => morceaux.push(m) });
    expect(JSON.parse(creation)).toMatchObject({ Cmd: ['esphome', 'compile', '/config/x.yaml'], AttachStdout: true, AttachStderr: true, Tty: false });
    expect(r).toEqual({ codeSortie: 0, sortie: 'Compiling...\nRAM:   [=  ]  9.9% (used 1 bytes from 10 bytes)\n' });
    expect(morceaux).toHaveLength(2);
  });

  it('rend le code de sortie d\'une commande en échec', async () => {
    const socket = await faux((req, res) => {
      if (req.url!.endsWith('/exec')) { res.writeHead(201); res.end('{"Id":"z"}'); }
      else if (req.url === '/exec/z/start') { res.writeHead(200); res.end(trame(2, 'ERROR boom\n')); }
      else { res.writeHead(200); res.end('{"ExitCode":2}'); }
    });
    expect(await new DockerApi(socket).exec('esphome', ['x'])).toEqual({ codeSortie: 2, sortie: 'ERROR boom\n' });
  });

  it('exec refusé : erreur explicite', async () => {
    const socket = await faux((_req, res) => { res.writeHead(409); res.end('{"message":"conteneur arrêté"}'); });
    await expect(new DockerApi(socket).exec('esphome', ['x'])).rejects.toThrow(/exec refusé \(409\)/);
  });
});
