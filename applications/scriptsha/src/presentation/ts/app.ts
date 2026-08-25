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
  builtin: boolean;
  driftsFromBuiltin: boolean;
}

interface ImportCandidate {
  id: string;
  domain: 'script' | 'automation';
  title: string;
}

let socket: any | null = null;
let listenersReady = false;
let scripts: ScriptEntry[] = [];
let importCandidates: ImportCandidate[] = [];

function init(): void {
  try {
    socket = window.app.socketService.getSocket();

    if (!listenersReady) {
      setupEventListeners();
      listenersReady = true;
    }
    setupUploadForm();
    setupContentModal();
    setupImportModal();
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

  socket.on('scriptsha:import:candidates', (data: { candidates: ImportCandidate[] }) => {
    importCandidates = data.candidates;
    renderImportCandidates();
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

    const driftBadge = s.driftsFromBuiltin
      ? '<span class="badge drift" title="Le contenu sur disque diffère du modèle intégré à l\'application">⚠️ diverge du modèle intégré</span>'
      : '';

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
        <div class="script-title">${escapeHtml(s.title)}${badge}${driftBadge}</div>
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
// Import depuis HA (⭐ 25/08/2026)
// ==========================================================================

function setupImportModal(): void {
  const overlay = $('import-overlay');
  $('import-open')?.addEventListener('click', () => {
    importCandidates = [];
    const listEl = $('import-list');
    if (listEl) listEl.innerHTML = '<div class="empty">Recherche en cours...</div>';
    const submitBtn = $('import-submit') as HTMLButtonElement | null;
    if (submitBtn) submitBtn.disabled = true;
    overlay?.classList.add('active');
    socket?.emit('scriptsha:import:candidates:get');
  });
  $('import-close')?.addEventListener('click', () => overlay?.classList.remove('active'));
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
  $('import-submit')?.addEventListener('click', () => submitImport());
}

function renderImportCandidates(): void {
  const listEl = $('import-list');
  const submitBtn = $('import-submit') as HTMLButtonElement | null;
  if (!listEl) return;

  if (importCandidates.length === 0) {
    listEl.innerHTML = '<div class="empty">Rien à importer — tout ce qui existe dans HA est déjà connu de scriptsha.</div>';
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  listEl.innerHTML = importCandidates.map((c) => `
    <label class="import-row">
      <input type="checkbox" data-import-id="${escapeHtml(c.id)}">
      <span class="import-title">${escapeHtml(c.title)}</span>
      <span class="import-domain">${c.domain === 'automation' ? 'automatisation' : 'script'}</span>
    </label>
  `).join('');

  const updateSubmitState = (): void => {
    if (!submitBtn) return;
    submitBtn.disabled = listEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked').length === 0;
  };
  listEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', updateSubmitState);
  });
  updateSubmitState();
}

function submitImport(): void {
  const listEl = $('import-list');
  if (!listEl) return;
  const selectedIds = new Set(
    Array.from(listEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
      .map((cb) => cb.dataset.importId)
  );
  const selected = importCandidates.filter((c) => selectedIds.has(c.id));
  if (selected.length === 0) return;

  socket?.emit('scriptsha:import:apply', { candidates: selected });
  $('import-overlay')?.classList.remove('active');
}

// ==========================================================================
// Dépôt de fichier
// ==========================================================================

/**
 * Extrait un champ scalaire de tête d'un YAML brut (⭐ 24/08/2026 — pas un vrai parseur, juste de
 * quoi préremplir le formulaire depuis alias/description quand ils sont déjà dans le fichier
 * déposé : ni titre ni description ne devraient être obligatoires à retaper si le fichier les a
 * déjà). Gère la valeur simple (avec guillemets optionnels) et le bloc replié/littéral
 * (`>`/`>-`/`|`/`|-` suivi de lignes indentées) — suffisant pour alias/description, pas un besoin
 * de gérer tout YAML ici (aucun parseur YAML côté navigateur dans cette app).
 */
function extractYamlField(text: string, field: string): string {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${field}:\\s*(.*)$`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx === -1) return '';
  const rest = (lines[idx].match(re)?.[1] ?? '').trim();
  if (/^[|>][-+]?\s*$/.test(rest)) {
    const blockLines: string[] = [];
    for (let i = idx + 1; i < lines.length; i++) {
      if (/^\s+\S/.test(lines[i])) blockLines.push(lines[i].trim());
      else break;
    }
    return blockLines.join(' ').trim();
  }
  return rest.replace(/^['"]|['"]$/g, '');
}

function setupUploadForm(): void {
  $('upload-submit')?.addEventListener('click', () => void submitUpload());

  $('upload-file')?.addEventListener('change', () => {
    const fileInput = $('upload-file') as HTMLInputElement | null;
    const titleInput = $('upload-title') as HTMLInputElement | null;
    const descriptionInput = $('upload-description') as HTMLTextAreaElement | null;
    const file = fileInput?.files?.[0];
    if (!file) return;

    file.text().then((text) => {
      // Ne jamais écraser ce que l'utilisateur a déjà tapé — seulement combler un champ vide.
      if (titleInput && !titleInput.value.trim()) {
        const alias = extractYamlField(text, 'alias');
        if (alias) titleInput.value = alias;
      }
      if (descriptionInput && !descriptionInput.value.trim()) {
        const description = extractYamlField(text, 'description');
        if (description) descriptionInput.value = description;
      }
    }).catch(() => {
      // Fichier illisible côté client : pas bloquant, submitUpload() re-tentera côté serveur et
      // affichera l'erreur réelle si le fichier est vraiment invalide.
    });
  });
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
