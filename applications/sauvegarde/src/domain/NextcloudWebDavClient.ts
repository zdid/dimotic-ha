/**
 * Client WebDAV Nextcloud minimal pour l'assistant de restauration (§6ter de la spec) — lecture
 * seule : listage des sauvegardes (PROPFIND, profondeur 1 niveau par niveau) et lecture d'un petit
 * fichier texte (manifeste). Le téléchargement de l'archive elle-même se fait SUR la machine cible
 * (décision du 23/09/2026, point 14), par le script de restauration, jamais ici.
 *
 * Identifiants fournis à chaque appel (saisis dans l'assistant, jamais stockés — point 3) : une
 * machine fraîchement déployée n'a ni config Nextcloud ni fichier secret.
 *
 * Arborescence attendue (§4quater) : <rootPath>/<site>/<machine>/<cadence>/<parent>-<date>.tar.gz
 * + <parent>-<date>.manifest.txt. Parcours niveau par niveau (Depth: 1) plutôt qu'un seul
 * `Depth: infinity`, que Nextcloud peut refuser selon sa configuration.
 */

export interface NextcloudCredentials {
  serverUrl: string;
  user: string;
  password: string;
  rootPath: string;
}

interface DavEntry {
  /** Dernier segment du chemin, décodé. */
  name: string;
  isCollection: boolean;
  size: number;
}

/** Une sauvegarde disponible = une archive (et son manifeste éventuel) pour un parent et une date. */
export interface BackupEntry {
  site: string;
  machine: string;
  cadence: string;
  parent: string;
  date: string;
  archiveSize: number;
  hasManifest: boolean;
}

export interface ManifestItem {
  name: string;
  /** Taille décompressée en octets — absente pour un manifeste antérieur au 23/09/2026. */
  size?: number;
}

const ARCHIVE_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;
const MANIFEST_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.manifest\.txt$/;

export class NextcloudHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class NextcloudWebDavClient {
  constructor(private readonly creds: NextcloudCredentials) {}

  private baseUrl(): string {
    const root = this.creds.rootPath.replace(/^\/+|\/+$/g, '');
    const base = `${this.creds.serverUrl.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(this.creds.user)}`;
    return root ? `${base}/${root.split('/').map(encodeURIComponent).join('/')}` : base;
  }

  private urlFor(segments: string[]): string {
    return [this.baseUrl(), ...segments.map(encodeURIComponent)].join('/');
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.creds.user}:${this.creds.password}`).toString('base64');
  }

  private async request(method: string, url: string, headers: Record<string, string> = {}): Promise<string> {
    const response = await fetch(url, { method, headers: { Authorization: this.authHeader(), ...headers } });
    if (response.status === 401) throw new NextcloudHttpError(401, 'Identifiants Nextcloud refusés (utilisateur ou mot de passe).');
    if (response.status === 404) throw new NextcloudHttpError(404, `Introuvable sur Nextcloud : ${url}`);
    if (!response.ok && response.status !== 207) throw new NextcloudHttpError(response.status, `Nextcloud a répondu ${response.status} ${response.statusText}`);
    return response.text();
  }

  /** Contenu immédiat d'une collection (PROPFIND Depth: 1), sans l'entrée de la collection elle-même. */
  private async listDir(segments: string[]): Promise<DavEntry[]> {
    const xml = await this.request('PROPFIND', this.urlFor(segments) + '/', { Depth: '1' });
    const entries: DavEntry[] = [];
    const responses = xml.split(/<d:response>/i).slice(1);
    // La première réponse est la collection interrogée elle-même.
    for (const block of responses.slice(1)) {
      const href = /<d:href>([^<]*)<\/d:href>/i.exec(block)?.[1] ?? '';
      const name = decodeURIComponent(href.replace(/\/+$/, '').split('/').pop() ?? '');
      if (!name) continue;
      const isCollection = /<d:collection\s*\/>/i.test(block);
      const size = Number(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/i.exec(block)?.[1] ?? 0);
      entries.push({ name, isCollection, size });
    }
    return entries;
  }

  /** Toutes les sauvegardes présentes sous rootPath, triées par date décroissante. */
  async listBackups(): Promise<BackupEntry[]> {
    const backups = new Map<string, BackupEntry>();
    for (const site of (await this.listDir([])).filter((e) => e.isCollection)) {
      for (const machine of (await this.listDir([site.name])).filter((e) => e.isCollection)) {
        for (const cadence of (await this.listDir([site.name, machine.name])).filter((e) => e.isCollection)) {
          for (const file of (await this.listDir([site.name, machine.name, cadence.name])).filter((e) => !e.isCollection)) {
            const archive = ARCHIVE_RE.exec(file.name);
            const manifest = MANIFEST_RE.exec(file.name);
            const match = archive || manifest;
            if (!match) continue;
            const [, parent, date] = match;
            const key = [site.name, machine.name, cadence.name, parent, date].join('|');
            const entry = backups.get(key) ?? {
              site: site.name, machine: machine.name, cadence: cadence.name, parent, date, archiveSize: 0, hasManifest: false
            };
            if (archive) entry.archiveSize = file.size;
            if (manifest) entry.hasManifest = true;
            backups.set(key, entry);
          }
        }
      }
    }
    // Une entrée sans archive (manifeste orphelin) n'est pas restaurable.
    return Array.from(backups.values())
      .filter((b) => b.archiveSize > 0)
      .sort((a, b) => b.date.localeCompare(a.date) || a.cadence.localeCompare(b.cadence));
  }

  /** Manifeste d'une sauvegarde : une ligne par élément, `nom` ou `nom<TAB>octets`. */
  async readManifest(b: Pick<BackupEntry, 'site' | 'machine' | 'cadence' | 'parent' | 'date'>): Promise<ManifestItem[]> {
    const text = await this.request('GET', this.urlFor([b.site, b.machine, b.cadence, `${b.parent}-${b.date}.manifest.txt`]));
    return text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim()).map((line) => {
      const [name, size] = line.split('\t');
      const bytes = Number(size);
      return size !== undefined && size !== '' && Number.isFinite(bytes) ? { name, size: bytes } : { name };
    });
  }
}
