import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { detectVariables, detectVariableHints, detectBundlePaths } from '../ScriptTemplate';

// Outils v1.12 — cases à cocher de « Préparer et écrire une carte SD » : wrapper, sd-extras.sh et profil du moteur.
const APP = path.join(__dirname, '..', '..', '..');
const SCRIPTS = path.join(APP, 'reposcripts', 'scripts');
const WRAPPER = fs.readFileSync(path.join(APP, 'reposcripts', 'wrappers', 'prepare-sd-card.sh'), 'utf8');

describe('wrapper prepare-sd-card.sh — champs de l\'assistant', () => {
  const hints = detectVariableHints(WRAPPER);
  const variables = detectVariables(WRAPPER);

  it('SERVICES, INTEGRATIONS_HA, COMPTES et OPTIONS_SYSTEME sont des listes à cocher', () => {
    for (const nom of ['SERVICES', 'INTEGRATIONS_HA', 'COMPTES', 'OPTIONS_SYSTEME']) {
      expect(variables).toContain(nom);
      expect(hints[nom]?.type).toBe('checklist');
    }
  });

  it('les services demandés sont proposés, Whisper et Piper compris, et mosquitto aussi', () => {
    const h = hints.SERVICES as { options: string[] };
    for (const s of ['homeassistant', 'zigbee2mqtt', 'mosquitto', 'dimotic-maj', 'portainer-agent', 'whisper', 'piper']) {
      expect(h.options).toContain(s);
    }
  });

  it('WireGuard et Claude Code sont proposés, pas de chemin stable du dongle', () => {
    const h = hints.OPTIONS_SYSTEME as { options: string[] };
    expect(h.options).toEqual(['rotation-journaux-docker', 'fuseau-paris', 'sauvegarde-nextcloud', 'wireguard', 'claude-code']);
  });

  it('DuckDNS : listes déroulantes des domaines (noisy, stfort) et des machines, avec « autre »', () => {
    for (const i of [1, 2]) {
      const d = hints[`DUCKDNS_DOMAINE_${i}`] as { type: string; options: string[] };
      expect(d.type).toBe('select');
      expect(d.options).toEqual(expect.arrayContaining(['aucun', 'dimoticnoisy', 'dimotic-noisy-ha', 'dimotic-stfort-ha', 'autre']));
      const m = hints[`DUCKDNS_MACHINE_${i}`] as { type: string; options: string[] };
      expect(m.type).toBe('select');
      expect(m.options).toContain('autre');
      expect(variables).toEqual(expect.arrayContaining([`DUCKDNS_DOMAINE_${i}_AUTRE`, `DUCKDNS_MACHINE_${i}_AUTRE`, `DUCKDNS_PORT_${i}`]));
    }
    expect(variables).toContain('DUCKDNS_TOKEN');
  });

  it('l\'archive embarque sd-extras.sh et les modèles', () => {
    const chemins = detectBundlePaths(WRAPPER).map((b) => b.dest);
    expect(chemins).toEqual(expect.arrayContaining(['scripts/sd-extras.sh', 'scripts/modeles', 'scripts/sauvegarde-rendu', 'scripts/sauvegarde-rendu/BackupScript.js']));
  });

  it('sauvegarde Nextcloud : champs de l\'assistant (mot de passe d\'application sensible, site en liste)', () => {
    for (const nom of ['NEXTCLOUD_URL', 'NEXTCLOUD_USER', 'NEXTCLOUD_DOSSIER', 'SAUVEGARDE_MACHINE', 'NEXTCLOUD_MOT_DE_PASSE']) expect(variables).toContain(nom);
    expect((hints.SAUVEGARDE_SITE as { type: string; options: string[] }).options).toEqual(['noisy', 'stfort']);
    expect(WRAPPER).toMatch(/"  password: \$\(q "\$NEXTCLOUD_MOT_DE_PASSE"\)"/);   // « password: » -> masqué à l'affichage
  });

  it('le profil généré ne s\'affiche pas avec le jeton ni les mots de passe', () => {
    expect(WRAPPER).toMatch(/sed -E 's\/\^\( \*\(password\|token\): \)/);
  });
});

/** Exécute du bash qui source sd-extras.sh, avec une racine d'image factice. */
function bash(rootfs: string, corps: string, env: Record<string, string> = {}) {
  const script = `set -euo pipefail\nsource '${SCRIPTS}/sd-extras.sh'\nROOTFS='${rootfs}'\nin_chroot() { echo "$1" >> '${rootfs}/chroot.log'; }\n${corps}`;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'extras-'));

describe('sd-extras.sh — services', () => {
  it('pose chaque service dans /docker/<service>/ avec son compose, sans rien démarrer', () => {
    const root = tmp();
    const r = bash(root, 'extras_pose_services "homeassistant,zigbee2mqtt,mosquitto,portainer-agent,whisper,piper"');
    expect(r.status, r.stderr).toBe(0);
    for (const s of ['homeassistant', 'zigbee2mqtt', 'mosquitto', 'portainer-agent', 'whisper', 'piper']) {
      expect(fs.existsSync(path.join(root, 'docker', s, 'compose.yaml')), s).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'docker/mosquitto/config/mosquitto.conf'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'docker/homeassistant/config'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'docker/whisper/compose.yaml'), 'utf8')).toContain('wyoming-whisper');
    expect(fs.readFileSync(path.join(root, 'docker/piper/compose.yaml'), 'utf8')).toContain('wyoming-piper');
  });

  it('dimotic-maj active le profil « maj » une seule fois', () => {
    const root = tmp();
    const r = bash(root, 'extras_pose_services "dimotic-maj"; extras_pose_services "dimotic-maj"');
    expect(r.status, r.stderr).toBe(0);
    const env = fs.readFileSync(path.join(root, 'docker/dimotic-ha/.env'), 'utf8');
    expect(env.match(/COMPOSE_PROFILES=maj/g)).toHaveLength(1);
  });

  it('un service inconnu est refusé', () => {
    const r = bash(tmp(), 'extras_pose_services "inconnu"');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('service inconnu');
  });

  it('extras_valider refuse une valeur hors liste', () => {
    const r = bash(tmp(), 'extras_valider "--services" "mosquitto,truc" "$EXTRAS_SERVICES_CONNUS"');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('« truc » inconnu');
  });
});

describe('sd-extras.sh — intégrations Home Assistant', () => {
  function zips(dir: string) {
    const make = (nom: string, fichiers: Record<string, string>) => {
      const spec = JSON.stringify(fichiers);
      const r = spawnSync('python3', ['-I', '-c', `import zipfile,json,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nfor k,v in json.loads(sys.argv[2]).items(): z.writestr(k,v)\nz.close()`, path.join(dir, nom), spec]);
      expect(r.status).toBe(0);
    };
    make('hacs.zip', { '__init__.py': '# hacs', 'manifest.json': '{}' });
    make('dimotic-ha-taxonomie.zip', { 'dimotic-ha-taxonomie-essai/custom_components/dimotic_taxonomie/manifest.json': '{"version":"x"}' });
    make('dimotic-ha-plans.zip', { 'dimotic-ha-plans-essai/custom_components/dimotic_plans/manifest.json': '{"version":"y"}', 'dimotic-ha-plans-essai/README.md': 'non copié' });
  }

  it('pose HACS et les deux intégrations dimotic dans custom_components', () => {
    const root = tmp(); const z = tmp(); zips(z);
    fs.mkdirSync(path.join(root, 'docker/homeassistant'), { recursive: true });
    const r = bash(root, 'extras_pose_integrations "hacs,dimotic_taxonomie,dimotic_plans"', { EXTRAS_ZIP_DIR: z });
    expect(r.status, r.stderr).toBe(0);
    const cc = path.join(root, 'docker/homeassistant/config/custom_components');
    expect(fs.existsSync(path.join(cc, 'hacs/__init__.py'))).toBe(true);
    expect(fs.existsSync(path.join(cc, 'dimotic_taxonomie/manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(cc, 'dimotic_plans/manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(cc, 'dimotic_plans/README.md'))).toBe(false);
  });

  it('exige le service homeassistant', () => {
    const r = bash(tmp(), 'extras_pose_integrations "hacs"', { EXTRAS_ZIP_DIR: tmp() });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('service « homeassistant »');
  });

  it('refuse un chemin qui sort du dossier (archive piégée)', () => {
    const z = tmp(); const root = tmp();
    spawnSync('python3', ['-I', '-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('../evil','x')\nz.close()`, path.join(z, 'hacs.zip')]);
    fs.mkdirSync(path.join(root, 'docker/homeassistant'), { recursive: true });
    const r = bash(root, 'extras_pose_integrations "hacs"', { EXTRAS_ZIP_DIR: z });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, 'docker/homeassistant/config/evil'))).toBe(false);
  });
});

describe('sd-extras.sh — options du système', () => {
  it('rotation des journaux, fuseau, dossier de sauvegarde et WireGuard', () => {
    const root = tmp();
    const r = bash(root, 'extras_pose_options "rotation-journaux-docker,fuseau-paris,sauvegarde-nextcloud,wireguard"');
    expect(r.status, r.stderr).toBe(0);
    const daemon = JSON.parse(fs.readFileSync(path.join(root, 'etc/docker/daemon.json'), 'utf8'));
    expect(daemon['log-opts']).toEqual({ 'max-size': '10m', 'max-file': '5' });
    expect(fs.readFileSync(path.join(root, 'etc/timezone'), 'utf8').trim()).toBe('Europe/Paris');
    expect(fs.readlinkSync(path.join(root, 'etc/localtime'))).toBe('/usr/share/zoneinfo/Europe/Paris');
    expect(fs.existsSync(path.join(root, 'dimotic-backup'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'etc/wireguard'))).toBe(true);
  });

  it('les options ajoutent leurs paquets', () => {
    const r = bash(tmp(), 'echo "[$(extras_paquets "wireguard,sauvegarde-nextcloud")]"');
    expect(r.stdout.trim()).toBe('[wireguard-tools cron tar]');
    const vide = bash(tmp(), 'echo "[$(extras_paquets "fuseau-paris")]"');
    expect(vide.stdout.trim()).toBe('[]');
  });
});

describe('sd-extras.sh — sauvegarde Nextcloud (script, mot de passe, cron)', () => {
  const pose = (root: string, mdp = 'MDP-APPLICATION') =>
    bash(root, 'extras_machine_sauvegarde noisy noisy2 https://dimoticloud.duckdns.org hadimotic backups-dimotic', { NEXTCLOUD_PASSWORD: mdp });

  it('pose le script rendu par le générateur de l\'application Sauvegarde, le fichier secret (600) et le cron de 3 h 05', () => {
    const root = tmp();
    const r = pose(root);
    expect(r.status, r.stderr).toBe(0);
    const script = fs.readFileSync(path.join(root, 'dimotic-backup/nextcloud-backup.sh'), 'utf8');
    expect(script).toContain("SITE='noisy'");
    expect(script).toContain("MACHINE='noisy2'");
    expect(script).toContain("NEXTCLOUD_SERVER_URL='https://dimoticloud.duckdns.org'");
    expect(script).toContain("SECRET_FILE='/dimotic-secrets/nextcloud-backup'");
    expect(fs.statSync(path.join(root, 'dimotic-backup/nextcloud-backup.sh')).mode & 0o777).toBe(0o755);
    const secret = path.join(root, 'dimotic-secrets/nextcloud-backup');
    expect(fs.readFileSync(secret, 'utf8')).toBe('MDP-APPLICATION');
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, 'dimotic-secrets')).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(root, 'var/spool/cron/crontabs/root'), 'utf8'))
      .toBe('5 3 * * * /dimotic-backup/nextcloud-backup.sh >> /dimotic-backup/cron.log 2>&1\n');
  });

  it('le mot de passe n\'est ni dans le script, ni affiché', () => {
    const root = tmp();
    const r = pose(root);
    expect(r.stdout + r.stderr).not.toContain('MDP-APPLICATION');
    expect(fs.readFileSync(path.join(root, 'dimotic-backup/nextcloud-backup.sh'), 'utf8')).not.toContain('MDP-APPLICATION');
  });

  it('refuse sans mot de passe ou avec un nom de machine invalide', () => {
    expect(bash(tmp(), 'extras_machine_sauvegarde noisy noisy2 https://x u r').status).not.toBe(0);
    expect(bash(tmp(), 'extras_machine_sauvegarde noisy "mal nommée" https://x u r', { NEXTCLOUD_PASSWORD: 'x' }).status).not.toBe(0);
  });
});

describe('sd-extras.sh — Claude Code', () => {
  it('installe Claude Code par npm dans l\'image 64 bits et vérifie la commande', () => {
    const root = tmp();
    const r = bash(root, 'QEMU_BIN=qemu-aarch64-static; extras_pose_options "claude-code"');
    expect(r.status, r.stderr).toBe(0);
    const appels = fs.readFileSync(path.join(root, 'chroot.log'), 'utf8');
    expect(appels).toContain('npm install -g @anthropic-ai/claude-code');
    expect(appels).toContain('command -v claude');
  });

  it('refuse un système 32 bits', () => {
    const r = bash(tmp(), 'QEMU_BIN=qemu-arm-static; extras_pose_options "claude-code"');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('64 bits');
  });
});

describe('sd-extras.sh — par machine : comptes, DuckDNS et Caddy', () => {
  it('DuckDNS : un script de mise à jour par domaine (700), un cron, le Caddyfile et le compose de Caddy', () => {
    const root = tmp();
    const r = bash(root, 'extras_machine_duckdns "JETON-SECRET" "dimotic-noisy-ha=192.168.1.201:8123" "dimoticnoisy=192.168.1.62:8081"');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('JETON-SECRET');   // le jeton n'est jamais affiché
    const sh = path.join(root, 'dimotic-ha-addons/duckdns/dimotic-noisy-ha.sh');
    expect(fs.readFileSync(sh, 'utf8')).toContain('domains=dimotic-noisy-ha&token=JETON-SECRET');
    expect(fs.statSync(sh).mode & 0o777).toBe(0o700);
    // /etc/cron.d/<nom sans point> est un lien vers le fichier .cron (convention du projet) ; absolu, donc lu depuis l'image.
    expect(fs.readlinkSync(path.join(root, 'etc/cron.d/duckdns-dimotic-noisy-ha'))).toBe('/dimotic-ha-addons/duckdns/dimotic-noisy-ha.cron');
    expect(fs.readFileSync(path.join(root, 'dimotic-ha-addons/duckdns/dimotic-noisy-ha.cron'), 'utf8')).toContain('*/5 * * * * root');
    const caddyfile = fs.readFileSync(path.join(root, 'docker/caddy/Caddyfile'), 'utf8');
    expect(caddyfile).toContain('dimotic-noisy-ha.duckdns.org {\n    reverse_proxy 192.168.1.201:8123\n}');
    expect(caddyfile).toContain('dimoticnoisy.duckdns.org {\n    reverse_proxy 192.168.1.62:8081\n}');
    expect(fs.readFileSync(path.join(root, 'docker/caddy/compose.yaml'), 'utf8')).toContain('image: caddy:2');
  });

  it('DuckDNS : nom ou cible invalides, ou jeton absent, sont refusés', () => {
    expect(bash(tmp(), 'extras_machine_duckdns "t" "Mauvais Nom=1.2.3.4:80"').status).not.toBe(0);
    expect(bash(tmp(), 'extras_machine_duckdns "t" "ok=1.2.3.4"').status).not.toBe(0);
    expect(bash(tmp(), 'extras_machine_duckdns "" "ok=1.2.3.4:80"').status).not.toBe(0);
  });

  it('comptes : claude (sudo sans mot de passe, clé dédiée) et didier (clés personnelles) ; le compte du profil est ignoré', () => {
    const root = tmp(); fs.mkdirSync(path.join(root, 'etc/sudoers.d'), { recursive: true });
    const cles = tmp();
    fs.writeFileSync(path.join(cles, 'claude.pub'), 'ssh-ed25519 AAAA-claude\n');
    fs.writeFileSync(path.join(cles, 'didier.pub'), 'ssh-rsa AAAA-didier\n');
    const r = bash(root, `PERSONAL_KEYS=('${cles}/didier.pub'); EXTRAS_CLAUDE_KEY='${cles}/claude.pub'\nextras_machine_comptes "didier,claude" "autre"`);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, 'home/claude/.ssh/authorized_keys'), 'utf8')).toContain('AAAA-claude');
    expect(fs.readFileSync(path.join(root, 'home/didier/.ssh/authorized_keys'), 'utf8')).toContain('AAAA-didier');
    expect(fs.readFileSync(path.join(root, 'etc/sudoers.d/claude'), 'utf8')).toBe('claude ALL=(ALL) NOPASSWD:ALL\n');
    const ignore = bash(tmp(), `PERSONAL_KEYS=(); extras_machine_comptes "didier" "didier"`);
    expect(ignore.status, ignore.stderr).toBe(0);
    expect(ignore.stdout).toContain('déjà créé par le profil');
  });

  it('comptes : claude sans clé publique est refusé', () => {
    const root = tmp();
    const r = bash(root, `PERSONAL_KEYS=(); EXTRAS_CLAUDE_KEY='/introuvable.pub'\nextras_machine_comptes "claude" "x"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('clé publique introuvable');
  });
});

describe('flash-sd-card.js — profil', () => {
  // Le moteur attend la disposition de l'archive auto-extractible : scripts/flash-sd-card.js + node_modules/js-yaml à côté.
  const bundle = tmp();
  fs.mkdirSync(path.join(bundle, 'scripts'));
  fs.mkdirSync(path.join(bundle, 'node_modules'));
  fs.copyFileSync(path.join(SCRIPTS, 'flash-sd-card.js'), path.join(bundle, 'scripts/flash-sd-card.js'));
  fs.symlinkSync(path.join(APP, 'node_modules/js-yaml'), path.join(bundle, 'node_modules/js-yaml'));
  const require_ = createRequire(__filename);
  const { loadProfile } = require_(path.join(bundle, 'scripts/flash-sd-card.js')) as { loadProfile: (p: string) => any };
  const cles = tmp();
  fs.writeFileSync(path.join(cles, 'claude.pub'), 'ssh-ed25519 AAAA\n');

  function profil(extra: string) {
    const f = path.join(tmp(), 'profil.yaml');
    fs.writeFileSync(f, `machine: essai\npiModel: Raspberry Pi 4\ndistro: bookworm-lite\nhostname: essai\nuser: didier\npassword: x\n${extra}\n`);
    return f;
  }
  afterEach(() => { vi.restoreAllMocks(); });
  const sortie = () => vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`exit ${c}`); }) as never);

  it('lit les nouveaux champs et ajoute Caddy dès qu\'un domaine DuckDNS est donné', () => {
    const p = loadProfile(profil(`services: [homeassistant, mosquitto]\nintegrationsHa: [hacs]\noptions: [wireguard]\naccounts: [claude]\nclaudeSshKey: ${cles}/claude.pub\nduckdns:\n  token: t\n  domains:\n    - { name: dimoticnoisy, target: "192.168.1.62:8081" }`));
    expect(p.services).toEqual(['homeassistant', 'mosquitto', 'caddy']);
    expect(p.integrationsHa).toEqual(['hacs']);
    expect(p.duckdns.domains).toEqual([{ name: 'dimoticnoisy', target: '192.168.1.62:8081' }]);
  });

  it('refuse une valeur inconnue, des intégrations sans Home Assistant, plus de 2 domaines et un compte claude sans clé', () => {
    sortie(); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadProfile(profil('services: [truc]'))).toThrow('exit 1');
    expect(() => loadProfile(profil('integrationsHa: [hacs]'))).toThrow('exit 1');
    expect(() => loadProfile(profil('accounts: [claude]'))).toThrow('exit 1');
    const trois = 'duckdns:\n  token: t\n  domains:\n    - { name: a, target: "h:1" }\n    - { name: b, target: "h:2" }\n    - { name: c, target: "h:3" }';
    expect(() => loadProfile(profil(trois))).toThrow('exit 1');
    expect(() => loadProfile(profil('duckdns:\n  token: t\n  domains:\n    - { name: "Mal Nommé", target: "h:1" }'))).toThrow('exit 1');
  });

  it('sauvegarde-nextcloud exige tous ses champs, et ils sont lus quand ils sont donnés', () => {
    sortie(); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadProfile(profil('options: [sauvegarde-nextcloud]'))).toThrow('exit 1');
    expect(() => loadProfile(profil('options: [sauvegarde-nextcloud]\nsauvegarde: { site: noisy, machine: noisy2, url: "https://x", user: u, root: r }'))).toThrow('exit 1');   // mot de passe manquant
    vi.restoreAllMocks();
    const p = loadProfile(profil('options: [sauvegarde-nextcloud]\nsauvegarde: { site: noisy, machine: noisy2, url: "https://x", user: u, root: r, password: mdp }'));
    expect(p.sauvegarde).toEqual({ site: 'noisy', machine: 'noisy2', url: 'https://x', user: 'u', root: 'r', password: 'mdp' });
    // sans l'option, les champs éventuels sont ignorés
    expect(loadProfile(profil('sauvegarde: { site: noisy }')).sauvegarde).toBeNull();
  });

  it('sans rien de coché, le profil reste comme avant (listes vides, pas de DuckDNS)', () => {
    const p = loadProfile(profil(''));
    expect(p.services).toEqual([]); expect(p.options).toEqual([]); expect(p.accounts).toEqual([]); expect(p.duckdns).toBeNull();
  });
});
