/**
 * Composant DiffusionManager — écran « Diffusion des données » (⭐ 29/09/2026,
 * techniques-diffusion-data_specs v1.3 §2bis/§9) : mode de diffusion de CETTE machine (propre à la
 * machine), état de la connexion, machines vues, bouton Resynchroniser, fichiers de data/ avec leur
 * état (reproduit / isolé / supprimé) et le dernier échange. Serveur : DiffusionService.
 */

interface DiffusionFileView {
  path: string;
  app: string;
  size?: number;
  mtime?: number;
  state: 'reproduit' | 'isolé' | 'exclu' | 'supprimé';
  last?: { event: string; machine: string; at: string };
}

interface DiffusionStatus {
  machineId: string;
  mode: 'arretee' | 'complet' | 'reception';
  connected: boolean;
  lastSync?: string;
  peers: Record<string, string>;
  files: DiffusionFileView[];
}

const MODES: Array<{ id: DiffusionStatus['mode']; label: string; hint: string }> = [
  { id: 'arretee', label: 'Arrêtée', hint: 'Rien ne part, rien n’arrive (valeur par défaut).' },
  { id: 'complet', label: 'Complète', hint: 'Envoie et reçoit — machines de production.' },
  { id: 'reception', label: 'Réception seule', hint: 'Reçoit la production, n’envoie rien ; les applications actives ici sont isolées (ni envoyées ni remplacées) — machine de développement.' }
];

const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const when = (iso?: string | number): string => (iso ? new Date(iso).toLocaleString('fr-FR') : '—');
const size = (n?: number): string => (n === undefined ? '' : n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(1)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);

const createTemplate = (): HTMLTemplateElement => {
  const template = document.createElement('template');
  template.innerHTML = `
    <style>
      .diffusion { padding: 20px; background: #2c3e50; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,.3); color: #ecf0f1; }
      .diffusion h2 { color: #ecf0f1; margin-bottom: 10px; }
      .section-description { margin: 0 0 16px 0; color: #95a5a6; font-size: 0.9rem; }
      .modes { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
      .mode { display: flex; gap: 10px; align-items: flex-start; padding: 10px; background: #34495e; border-radius: 6px; cursor: pointer; }
      .mode.active { outline: 2px solid #3498db; }
      .mode .hint { font-size: 0.8rem; color: #95a5a6; }
      .state { display: flex; gap: 20px; flex-wrap: wrap; font-size: 0.9rem; margin-bottom: 12px; }
      .btn { padding: 8px 14px; border-radius: 4px; border: none; background: #3498db; color: #fff; cursor: pointer; }
      .btn:disabled { opacity: .5; cursor: default; }
      .toolbar { display: flex; gap: 10px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
      .toolbar input { padding: 6px 10px; border-radius: 4px; border: 1px solid #4a6278; background: #2c3e50; color: #ecf0f1; width: 240px; }
      table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
      th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #34495e; }
      td.path { font-family: monospace; word-break: break-all; }
      .muted { color: #95a5a6; }
      .tag { padding: 1px 6px; border-radius: 8px; font-size: 0.75rem; background: #27ae60; }
      .tag.isole { background: #e67e22; } .tag.supprime { background: #7f8c8d; }
    </style>
    <div class="diffusion">
      <h2>🔁 Diffusion des données</h2>
      <p class="section-description">Reproduction des fichiers de <code>data/</code> entre les machines dimotic-ha (MQTT, sans message retenu ; le plus récent gagne, l'ancienne version reste dans l'historique local). Jamais reproduits : fichiers <code>machine_…</code> et <code>secrets_…</code>, <code>tmp</code>, <code>node_modules</code>, <code>.bak</code>, plus de 1 Mo (sauf images de plan). Le mode est propre à CETTE machine.</p>
      <div class="modes" id="modes"></div>
      <div class="state" id="state"></div>
      <div class="toolbar">
        <button class="btn" id="resync">🔄 Resynchroniser</button>
        <input id="filter" placeholder="Filtrer (application, fichier)…">
        <span class="muted" id="count"></span>
      </div>
      <table>
        <thead><tr><th>Fichier</th><th>État</th><th>Dernier échange</th><th>Modifié</th><th>Taille</th></tr></thead>
        <tbody id="files"></tbody>
      </table>
    </div>
  `;
  return template;
};

class DiffusionManager extends HTMLElement {
  private socket: any;
  private status: DiffusionStatus | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot!.appendChild(createTemplate().content.cloneNode(true));
  }

  connectedCallback(): void {
    this.socket = window.app.socketService.getSocket();
    this.socket.on('core:diffusion:status', (s: DiffusionStatus) => {
      this.status = s;
      this.render();
    });
    this.shadowRoot!.getElementById('resync')?.addEventListener('click', () => this.socket.emit('core:diffusion:resync'));
    this.shadowRoot!.getElementById('filter')?.addEventListener('input', () => this.renderFiles());
    this.socket.emit('core:diffusion:status:get');
  }

  private render(): void {
    const s = this.status;
    if (!s) return;
    const root = this.shadowRoot!;
    root.getElementById('modes')!.innerHTML = MODES.map((m) => `
      <label class="mode ${m.id === s.mode ? 'active' : ''}">
        <input type="radio" name="mode" value="${m.id}" ${m.id === s.mode ? 'checked' : ''}>
        <span><strong>${m.label}</strong><br><span class="hint">${m.hint}</span></span>
      </label>`).join('');
    root.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.value !== s.mode && confirm(`Passer la diffusion de cette machine en mode « ${MODES.find((m) => m.id === input.value)?.label} » ?`)) {
          this.socket.emit('core:diffusion:mode:set', { mode: input.value });
        } else {
          this.render();
        }
      });
    });
    const peers = Object.entries(s.peers);
    root.getElementById('state')!.innerHTML = `
      <span>Machine : <strong>${esc(s.machineId)}</strong></span>
      <span>Broker : ${s.connected ? '🟢 connecté' : '🔴 non connecté'}</span>
      <span>Dernière synchronisation : ${when(s.lastSync)}</span>
      <span>Machines vues : ${peers.length ? peers.map(([m, at]) => `${esc(m)} <span class="muted">(${when(at)})</span>`).join(', ') : '<span class="muted">aucune</span>'}</span>`;
    (root.getElementById('resync') as HTMLButtonElement).disabled = s.mode === 'arretee';
    this.renderFiles();
  }

  private renderFiles(): void {
    const s = this.status;
    if (!s) return;
    const root = this.shadowRoot!;
    const q = (root.getElementById('filter') as HTMLInputElement).value.trim().toLowerCase();
    const files = s.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    root.getElementById('count')!.textContent = `${files.length} fichier(s)${q ? ` sur ${s.files.length}` : ''}`;
    root.getElementById('files')!.innerHTML = files.map((f) => `
      <tr>
        <td class="path">${esc(f.path)}</td>
        <td><span class="tag ${f.state === 'isolé' ? 'isole' : f.state === 'supprimé' ? 'supprime' : ''}">${esc(f.state)}</span></td>
        <td>${f.last ? `${esc(f.last.event)} ${f.last.event === 'reçu' ? `de ${esc(f.last.machine)}` : ''} <span class="muted">${when(f.last.at)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="muted">${when(f.mtime)}</td>
        <td class="muted">${size(f.size)}</td>
      </tr>`).join('');
  }
}

customElements.define('app-diffusion-manager', DiffusionManager);
