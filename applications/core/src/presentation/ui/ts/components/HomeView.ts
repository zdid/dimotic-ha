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

      <section>
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
