import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLocalModule, AGENT_FILES } from '../DeployService';

describe('resolveLocalModule', () => {
  let racine: string;
  let base: string;
  beforeEach(() => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-'));
    // image Docker : /app/applications/teleinfo/dist/domain
    base = path.join(racine, 'app', 'applications', 'teleinfo', 'dist', 'domain');
    fs.mkdirSync(base, { recursive: true });
  });

  it("image Docker : prend le node_modules de l'application (pas de node_modules à la racine)", () => {
    const m = path.join(racine, 'app', 'applications', 'teleinfo', 'node_modules', 'argparse');
    fs.mkdirSync(m, { recursive: true });
    expect(path.resolve(resolveLocalModule('argparse', base))).toBe(path.resolve(m));
  });

  it('arbre de développement : repli sur le node_modules de la racine du projet', () => {
    const m = path.join(racine, 'app', 'node_modules', 'argparse');
    fs.mkdirSync(m, { recursive: true });
    expect(path.resolve(resolveLocalModule('argparse', base))).toBe(path.resolve(m));
  });

  it('repli sur le node_modules du cœur ; introuvable : premier chemin (erreur claire au scp)', () => {
    const c = path.join(racine, 'app', 'applications', 'core', 'node_modules', 'argparse');
    fs.mkdirSync(c, { recursive: true });
    expect(path.resolve(resolveLocalModule('argparse', base))).toBe(path.resolve(c));
    expect(resolveLocalModule('inconnu', base)).toContain(path.join('teleinfo', 'node_modules', 'inconnu'));
  });
});

describe('AGENT_FILES', () => {
  it("contient tous les fichiers locaux que l'agent exige (require('./x')) — sinon il plante sur le RPi1", () => {
    const dossier = path.join(__dirname, '..', '..', '..', 'device-agent');
    const requis = new Set<string>();
    for (const f of fs.readdirSync(dossier).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dossier, f), 'utf8');
      for (const m of src.matchAll(/require\('\.\/([a-z0-9-]+)(?:\.js)?'\)/g)) requis.add(`${m[1]}.js`);
      expect(AGENT_FILES).toContain(f); // chaque fichier de l'agent est copié
    }
    for (const r of requis) expect(AGENT_FILES).toContain(r);
    expect(AGENT_FILES).toContain('package.json');
  });
});
