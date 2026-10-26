import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBundleSource } from '../BundleBuilder';

const APP = path.join(__dirname, '..', '..', '..'); // dossier de l'application Outils (celle qui s'exécute)

describe('resolveBundleSource — scripts embarqués', () => {
  const ancien = process.env.PROJECT_ROOT;
  afterEach(() => { if (ancien === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = ancien; });

  it('un fichier de l\'application Outils vient de l\'application qui s\'exécute, pas de la racine du projet (image Docker)', () => {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'racine-image-'));
    fs.mkdirSync(path.join(racine, 'applications/outils/reposcripts/scripts'), { recursive: true });
    fs.writeFileSync(path.join(racine, 'applications/outils/reposcripts/scripts/prepare-sd-card.sh'), 'VERSION DE L\'IMAGE (ancienne)');
    process.env.PROJECT_ROOT = racine;
    const src = resolveBundleSource('applications/outils/reposcripts/scripts/prepare-sd-card.sh');
    expect(src).toBe(path.join(APP, 'reposcripts/scripts/prepare-sd-card.sh'));
    expect(fs.readFileSync(src, 'utf8')).not.toContain('VERSION DE L\'IMAGE');
  });

  it('un fichier hors de l\'application Outils (ex. scripts/…) vient de la racine du projet', () => {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'racine-'));
    process.env.PROJECT_ROOT = racine;
    expect(resolveBundleSource('scripts/flash-sd-card.js')).toBe(path.join(racine, 'scripts/flash-sd-card.js'));
  });

  it('un fichier de l\'application Outils absent de l\'application retombe sur la racine du projet', () => {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'racine-'));
    process.env.PROJECT_ROOT = racine;
    expect(resolveBundleSource('applications/outils/reposcripts/scripts/inexistant.sh')).toBe(path.join(racine, 'applications/outils/reposcripts/scripts/inexistant.sh'));
  });
});
