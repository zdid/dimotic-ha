/**
 * Page d'accueil (⭐ 27/08/2026, demande utilisateur : visibilité multi-machines) — lien direct
 * vers la HA configurée sur cette machine, liste personnelle de sites externes (jamais gossipée,
 * une seule adresse par entrée — voir schema.ts::externalSiteSchema), et registre des applications
 * des AUTRES machines du même site (AppGossipService.ts côté serveur).
 *
 * Rendue directement par ModuleContainer (voir loadModuleContent()) — pas un fichier de
 * présentation fetché comme les vraies applications, 'accueil' n'a pas de dossier
 * `applications/accueil/`.
 */

interface RemoteAppEntry {
  id: string;
  name: string;
  icon: string;
}

interface MachineAppsAnnouncement {
  machineId: string;
  address?: string;
  webPort: number;
  runningInDocker: boolean;
  apps: RemoteAppEntry[];
}

interface ExternalSite {
  id: string;
  label: string;
  dimoticUrl: string;
}

export function buildAccueilHtml(): string {
  return `
    <div id="accueil-view" style="padding: 1.5rem; max-width: 800px;">
      <h2>Accueil</h2>

      <section style="margin-bottom: 2rem;">
        <h3>Home Assistant</h3>
        <p id="accueil-ha-link">Non configuré.</p>
      </section>

      <section style="margin-bottom: 2rem;">
        <h3>Sites externes</h3>
        <ul id="accueil-external-sites" style="list-style:none; padding:0;"></ul>
        <form id="accueil-external-site-form" style="display:flex; gap:0.5rem; margin-top:0.75rem;">
          <input type="text" id="accueil-site-label" placeholder="Nom (ex: Chez ma fille)" required style="flex:1;">
          <input type="text" id="accueil-site-url" placeholder="http://adresse:port" required style="flex:1;">
          <button type="submit">Ajouter</button>
        </form>
      </section>

      <div id="accueil-supervision"></div>

      <section id="accueil-remote-section">
        <h3>Applications sur les autres machines</h3>
        <ul id="accueil-remote-apps" style="list-style:none; padding:0;">
          <li>Aucune autre machine détectée pour l'instant.</li>
        </ul>
      </section>
    </div>
  `;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function renderHaLink(root: ParentNode, data?: { host: string; port: number }): void {
  const el = root.querySelector('#accueil-ha-link');
  if (!el) return;
  if (!data || !data.host) {
    el.textContent = 'Non configuré.';
    return;
  }
  const url = `http://${data.host}:${data.port}`;
  el.innerHTML = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
}

function renderExternalSites(root: ParentNode, sites: ExternalSite[], socket: { emit: (event: string, data: unknown) => void }): void {
  const list = root.querySelector('#accueil-external-sites');
  if (!list) return;
  if (sites.length === 0) {
    list.innerHTML = '<li>Aucun site externe enregistré.</li>';
    return;
  }
  list.innerHTML = sites
    .map(
      (s) => `
      <li style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
        <a href="${escapeHtml(s.dimoticUrl)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>
        <span style="color:#888; font-size:0.85em;">(${escapeHtml(s.dimoticUrl)})</span>
        <button type="button" data-delete-site="${escapeHtml(s.id)}" style="margin-left:auto;">Supprimer</button>
      </li>
    `
    )
    .join('');
  list.querySelectorAll<HTMLButtonElement>('[data-delete-site]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteSite;
      if (id) socket.emit('core:external-site:delete', { id });
    });
  });
}

function renderRemoteApps(root: ParentNode, machines: MachineAppsAnnouncement[]): void {
  const list = root.querySelector('#accueil-remote-apps');
  if (!list) return;
  if (machines.length === 0) {
    list.innerHTML = "<li>Aucune autre machine détectée pour l'instant.</li>";
    return;
  }
  list.innerHTML = machines
    .map((m) => {
      const tag = m.runningInDocker ? 'Docker' : 'hôte';
      const appsHtml = m.apps
        .map((a) => {
          const label = `${a.icon} ${escapeHtml(a.name)}`;
          if (!m.address) return `<li>${label}</li>`;
          const href = `http://${m.address}:${m.webPort}/`;
          return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a></li>`;
        })
        .join('');
      return `
        <li style="margin-bottom:1rem;">
          <strong>${escapeHtml(m.machineId)}</strong> <span style="color:#888;">(${tag})</span>
          <ul style="list-style:none; padding-left:1rem;">${appsHtml}</ul>
        </li>
      `;
    })
    .join('');
}

/**
 * ⭐ 25/09/2026 — emplacement « supervision » (fonctionnelles-supervision_specs §4) : quand
 * l'application `supervision` tourne, son fragment remplace la liste brute « Applications sur les
 * autres machines ». Le core ne contient AUCUNE logique de supervision (décision utilisateur) : il
 * charge seulement `presentation/accueil.html` (balisage) et `presentation/ts/accueil.js` (une seule
 * fois, doit définir `window.supervisionAccueil.init(slot)`), puis appelle `init` à chaque visite.
 */
const SUPERVISION_ID = 'supervision';
let supervisionHtml: string | undefined;
let supervisionScript: Promise<void> | undefined;

function loadSupervisionScript(): Promise<void> {
  supervisionScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `/applications/${SUPERVISION_ID}/presentation/ts/accueil.js`;
    script.onload = () => resolve();
    script.onerror = () => { supervisionScript = undefined; reject(new Error('accueil.js introuvable')); };
    document.head.appendChild(script);
  });
  return supervisionScript;
}

async function updateSupervisionSlot(root: ParentNode): Promise<void> {
  const slot = root.querySelector<HTMLElement>('#accueil-supervision');
  const remote = root.querySelector<HTMLElement>('#accueil-remote-section');
  if (!slot || !remote) return;
  const active = window.app.moduleManager.getModules().some((m) => m.id === SUPERVISION_ID);
  if (!active) {
    slot.innerHTML = '';
    remote.style.display = '';
    return;
  }
  if (slot.dataset.loaded === 'true') return;
  try {
    if (supervisionHtml === undefined) {
      const response = await fetch(`/applications/${SUPERVISION_ID}/presentation/accueil.html`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      supervisionHtml = await response.text();
    }
    await loadSupervisionScript();
    slot.innerHTML = supervisionHtml;
    slot.dataset.loaded = 'true';
    remote.style.display = 'none';
    (window as unknown as { supervisionAccueil?: { init: (el: HTMLElement) => void } }).supervisionAccueil?.init(slot);
  } catch (error) {
    // Repli : la liste brute du gossip reste affichée.
    console.error('[Accueil] Fragment supervision indisponible:', error);
    remote.style.display = '';
  }
}

export function initAccueilApp(): void {
  const root = (window as unknown as { __moduleContainerRoot?: ParentNode }).__moduleContainerRoot;
  if (!root) return;

  const socket = window.app.socketService.getSocket();

  // Rendu immédiat avec ce qui est déjà connu (évite un flash vide si les événements persistants
  // sont déjà arrivés avant cette visite de l'onglet) — les écouteurs ci-dessous prennent le relais
  // pour toute mise à jour ultérieure.
  renderHaLink(root, window.app.haAddress);
  renderExternalSites(root, window.app.externalSites || [], socket);
  renderRemoteApps(root, window.app.remoteApps || []);

  window.addEventListener('app:ha-address', (e) => renderHaLink(root, (e as CustomEvent).detail));
  window.addEventListener('core:external-sites:list', (e) => renderExternalSites(root, (e as CustomEvent).detail.sites, socket));
  window.addEventListener('app:remote-apps', (e) => renderRemoteApps(root, (e as CustomEvent).detail));
  void updateSupervisionSlot(root);
  window.addEventListener('modules:loaded', () => {
    const slot = root.querySelector<HTMLElement>('#accueil-supervision');
    if (slot) delete slot.dataset.loaded;
    void updateSupervisionSlot(root);
  });

  const form = root.querySelector<HTMLFormElement>('#accueil-external-site-form');
  form?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const labelInput = root.querySelector<HTMLInputElement>('#accueil-site-label');
    const urlInput = root.querySelector<HTMLInputElement>('#accueil-site-url');
    const label = labelInput?.value.trim();
    const dimoticUrl = urlInput?.value.trim();
    if (!label || !dimoticUrl) return;
    socket.emit('core:external-site:save', { id: `site_${Date.now()}`, label, dimoticUrl });
    if (labelInput) labelInput.value = '';
    if (urlInput) urlInput.value = '';
  });

  socket.emit('core:external-sites:get');
}

(window as unknown as { accueilApp: { init: () => void } }).accueilApp = { init: initAccueilApp };
