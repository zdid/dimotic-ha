import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSharedFile, sharedDir } from './sharedFiles';

// Fichiers partagés en lecture seule (conception-esphome-assembleur §4, §11).

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'partage-test-'));
  const dir = sharedDir(root, 'espdisplay');
  fs.mkdirSync(path.join(dir, 'paquets', 'ecran-salon'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'paquets', 'ecran-salon', 'r12.zip'), 'zip');
  fs.writeFileSync(path.join(root, 'espdisplay', 'config.yaml'), 'secret: non');
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'core', 'secrets_config.yaml'), 'token: T');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('resolveSharedFile', () => {
  it('sert un fichier du dossier réservé', () => {
    const r = resolveSharedFile(root, 'espdisplay', 'paquets/ecran-salon/r12.zip');
    expect(r.ok).toBe(true);
    if (r.ok) expect(fs.readFileSync(r.filePath, 'utf8')).toBe('zip');
  });

  it('refuse de remonter hors du dossier', () => {
    for (const p of ['../config.yaml', 'paquets/../../config.yaml', '../../core/secrets_config.yaml', './x', '.cache/x', 'a//b', '']) {
      const r = resolveSharedFile(root, 'espdisplay', p);
      expect(r.ok, p).toBe(false);
    }
  });

  it('refuse un appId invalide', () => {
    for (const a of ['', '..', 'a/b', 'core;rm']) expect(resolveSharedFile(root, a, 'x').ok).toBe(false);
  });

  it('refuse un lien symbolique qui sort du dossier', () => {
    fs.symlinkSync(path.join(root, 'core', 'secrets_config.yaml'), path.join(sharedDir(root, 'espdisplay'), 'piege.yaml'));
    const r = resolveSharedFile(root, 'espdisplay', 'piege.yaml');
    expect(r).toEqual({ ok: false, status: 400, message: 'chemin hors du dossier partagé' });
  });

  it('404 pour un fichier absent, un dossier, ou une application sans dossier partagé', () => {
    expect(resolveSharedFile(root, 'espdisplay', 'paquets/absent.zip')).toMatchObject({ ok: false, status: 404 });
    expect(resolveSharedFile(root, 'espdisplay', 'paquets/ecran-salon')).toMatchObject({ ok: false, status: 404 });
    expect(resolveSharedFile(root, 'core', 'secrets_config.yaml')).toMatchObject({ ok: false, status: 404 });
  });
});
