import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLocalModule } from '../DeployService';

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
