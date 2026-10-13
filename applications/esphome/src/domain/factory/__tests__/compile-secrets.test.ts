import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { releverMesures, controlerTailles } from '../compile-output';
import { SecretsStore } from '../SecretsStore';

const sortie = `
Linking .pioenvs/hasat4/firmware.elf
RAM:   [=         ]   9.9% (used 32388 bytes from 327680 bytes)
Flash: [====      ]  41.4% (used 760037 bytes from 1835008 bytes)
Building .pioenvs/hasat4/firmware.bin
`;

describe('relevé des tailles', () => {
  it('lit la RAM et la flash dans la sortie de compilation', () => {
    expect(releverMesures(sortie, 770000)).toEqual({ ramUtilisee: 32388, ramDisponible: 327680, flashUtilisee: 760037, flashDisponible: 1835008, tailleOctets: 770000 });
  });
  it('null si les lignes sont absentes (compilation interrompue)', () => {
    expect(releverMesures('Compiling...', 1)).toBeNull();
  });
  const m = (o: Partial<ReturnType<typeof releverMesures> & object> = {}) => ({ ramUtilisee: 100, ramDisponible: 1000, flashUtilisee: 500, flashDisponible: 1000, tailleOctets: 500, ...o });
  const slot = { emplacementOtaOctets: 6_000_000, ramInterneOctets: 300_000 };
  it('refuse un firmware plus gros que l\'emplacement de mise à jour du modèle, avec les deux tailles', () => {
    const v = controlerTailles(m({ tailleOctets: 6_100_000 }), slot);
    expect(v).toEqual({ ok: false, raison: "le firmware (6100000 octets) ne tient pas dans l'emplacement (6000000 octets) du modèle" });
  });
  it('avertit à 90 % de l\'emplacement, de la flash et à 80 % de la RAM', () => {
    const v = controlerTailles(m({ tailleOctets: 5_500_000, flashUtilisee: 950, ramUtilisee: 850 }), slot);
    expect(v.ok && v.avertissements).toHaveLength(3);
  });
  it('sans fiche de mémoire : contrôles relatifs seulement, jamais de refus à tort', () => {
    expect(controlerTailles(m({ tailleOctets: 99_000_000 }))).toEqual({ ok: true, avertissements: [] });
    expect(controlerTailles(m({ flashUtilisee: 1100 })).ok).toBe(false);
  });
});

describe('secrets.yaml', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-')), 'secrets.yaml');
  it('crée la clé d\'un appareil neuf, conserve commentaires et clés existantes', () => {
    const f = tmp();
    fs.writeFileSync(f, '# mes secrets\nwifi_stfort_ssid: "maison"\napi_haplan-display: "ancienne"');
    const s = new SecretsStore(f, () => 'NOUVELLE');
    expect(s.creerSiAbsente('hasat4')).toBe('NOUVELLE');
    expect(fs.readFileSync(f, 'utf8')).toBe('# mes secrets\nwifi_stfort_ssid: "maison"\napi_haplan-display: "ancienne"\napi_hasat4: "NOUVELLE"\n');
  });
  it('ne remplace JAMAIS une clé existante (appareil en service : pas de réappairage)', () => {
    const f = tmp();
    fs.writeFileSync(f, 'api_haplan-display: "ancienne"\n');
    const s = new SecretsStore(f, () => 'AUTRE');
    expect(s.creerSiAbsente('haplan-display')).toBeNull();
    expect(fs.readFileSync(f, 'utf8')).toBe('api_haplan-display: "ancienne"\n');
  });
  it('crée le fichier s\'il n\'existe pas, avec une vraie clé de 32 octets', () => {
    const f = tmp();
    const cle = new SecretsStore(f).creerSiAbsente('x');
    expect(Buffer.from(cle!, 'base64')).toHaveLength(32);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});
