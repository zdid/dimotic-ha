/**
 * Script TypeScript pour le tableau de bord Scripts HA.
 */

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface ScriptEntry {
  id: string;
  title: string;
  description: string;
  originalFilename: string;
  deployed: boolean;
  deployedAt?: string;
  createdAt: string;
  updatedAt?: string;
  pending: boolean;
}

let socket: any | null = null;
let listenersReady = false;
let scripts: ScriptEntry[] = [];

function init(): void {
  try {
    socket = window.app.socketService.getSocket();

    if (!listenersReady) {
      setupEventListeners();
      listenersReady = true;
    }
    setupUploadForm();
    setupContentModal();
    requestInitialList();
    hideLoading();

    console.log('[Scripts HA UI] Initialisation terminée');
  } catch (error) {
    console.error('[Scripts HA UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('scriptsha:scripts:list', (list: ScriptEntry[]) => {
    scripts = list;
    renderScripts();
    hideLoading();
  });

  socket.on('scriptsha:script:content', (data: { id: string; content: string }) => {
    showContentModal(data.id, data.content);
  });

  socket.on('scriptsha:error', (data: { message: string; id?: string }) => {
    showListError(data.message);
  });
}

function requestInitialList(): void {
  socket?.emit('scriptsha:scripts:get');
}

function hideLoading(): void {
  const loading = $('loading');
  if (loading) loading.style.display = 'none';
}

// ==========================================================================
// Liste des scripts
// ==========================================================================

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderScripts(): void {
  const el = $('scripts-list');
  if (!el) return;

  if (scripts.length === 0) {
    el.innerHTML = '<div class="empty">Aucun script déposé.</div>';
    return;
  }

  el.innerHTML = scripts.map((s) => {
    const badge = s.pending
      ? '<span class="badge pending">en cours…</span>'
      : s.deployed
        ? '<span class="badge deployed">diffusé</span>'
        : '<span class="badge not-deployed">non diffusé</span>';

    const toggleBtn = s.pending
      ? ''
      : s.deployed
        ? `<button class="btn btn-secondary" data-action="undeploy" data-id="${escapeHtml(s.id)}">Retirer</button>`
        : `<button class="btn btn-primary" data-action="deploy" data-id="${escapeHtml(s.id)}">Diffuser</button>`;

    const deleteBtn = s.deployed
      ? ''
      : `<button class="btn btn-danger" data-action="delete" data-id="${escapeHtml(s.id)}">Supprimer</button>`;

    return `
    <div class="script-row">
      <div class="script-info">
        <div class="script-title">${escapeHtml(s.title)}${badge}</div>
        <div class="script-desc">${escapeHtml(s.description || 'Pas de description')}</div>
      </div>
      <div class="script-actions">
        <button class="btn btn-secondary" data-action="content" data-id="${escapeHtml(s.id)}">Voir le contenu</button>
        ${toggleBtn}
        ${deleteBtn}
      </div>
    </div>
  `;
  }).join('');

  el.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (!id) return;
      if (action === 'content') socket?.emit('scriptsha:script:get_content', { id });
      if (action === 'deploy') socket?.emit('scriptsha:script:deploy', { id });
      if (action === 'undeploy') socket?.emit('scriptsha:script:undeploy', { id });
      if (action === 'delete') {
        if (confirm('Supprimer ce script ?')) socket?.emit('scriptsha:script:delete', { id });
      }
    });
  });
}

function showListError(message: string): void {
  const el = $('list-error');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 6000);
}

// ==========================================================================
// Modale de consultation du contenu
// ==========================================================================

function setupContentModal(): void {
  const overlay = $('content-overlay');
  const closeBtn = $('content-close');
  closeBtn?.addEventListener('click', () => overlay?.classList.remove('active'));
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
}

function showContentModal(id: string, content: string): void {
  const script = scripts.find((s) => s.id === id);
  const title = $('content-modal-title');
  const body = $('content-body');
  if (title) title.textContent = script ? `Contenu — ${script.title}` : 'Contenu du script';
  if (body) body.textContent = content;
  $('content-overlay')?.classList.add('active');
}

// ==========================================================================
// Dépôt de fichier
// ==========================================================================

function setupUploadForm(): void {
  $('upload-submit')?.addEventListener('click', () => void submitUpload());
}

async function submitUpload(): Promise<void> {
  const errorEl = $('upload-error');
  if (errorEl) errorEl.style.display = 'none';

  const titleInput = $('upload-title') as HTMLInputElement | null;
  const descriptionInput = $('upload-description') as HTMLTextAreaElement | null;
  const fileInput = $('upload-file') as HTMLInputElement | null;

  const title = (titleInput?.value || '').trim();
  const description = (descriptionInput?.value || '').trim();
  const file = fileInput?.files?.[0];

  if (!title || !file) {
    if (errorEl) { errorEl.textContent = 'Titre et fichier sont obligatoires.'; errorEl.style.display = 'block'; }
    return;
  }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('description', description);
  formData.append('file', file);

  try {
    const response = await fetch('/api/apps/scriptsha/upload', { method: 'POST', body: formData });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${response.status}`);
    }
    if (titleInput) titleInput.value = '';
    if (descriptionInput) descriptionInput.value = '';
    if (fileInput) fileInput.value = '';
  } catch (error) {
    if (errorEl) {
      errorEl.textContent = `Échec du dépôt: ${error instanceof Error ? error.message : String(error)}`;
      errorEl.style.display = 'block';
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
