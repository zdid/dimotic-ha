/**
 * Script TypeScript pour le tableau de bord Outils (bibliothèque de scripts shell paramétrables).
 */

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface OutilScriptSummary {
  id: string;
  title: string;
  description: string;
  filename: string;
  requiresSudo: boolean;
  builtin: boolean;
}

interface OutilsStatus {
  scripts: OutilScriptSummary[];
}

type VariableHint =
  | { type: 'select'; options: string[]; help?: string; default?: string }
  | { type: 'checklist'; options: string[]; help?: string }
  | { type: 'text'; help?: string; default?: string };

interface OutilScriptDetail extends OutilScriptSummary {
  content: string;
  variables: string[];
  variableHints: Record<string, VariableHint>;
  // ⭐ 18/09/2026 — true si le script déclare au moins une dépendance @outils:bundle : la
  // génération passe alors par le serveur (archive auto-extractible), pas un Blob client direct.
  hasBundling: boolean;
  // ⭐ 19/09/2026 — dernières valeurs saisies, persistées côté serveur (voir renderVariableField).
  savedValues: Record<string, string>;
  // ⭐ 20/09/2026 — contenu brut du <id>.yaml (voir bouton "Télécharger en .zip").
  yamlContent: string;
}

interface AddScriptResult {
  success: boolean;
  error?: string;
}

interface BundleResult {
  success: boolean;
  token?: string;
  filename?: string;
  error?: string;
}

interface ZipResult {
  success: boolean;
  token?: string;
  filename?: string;
  error?: string;
}

interface DeleteScriptResult {
  success: boolean;
  error?: string;
}

let socket: any | null = null;
let listenersReady = false;
let currentScripts: OutilScriptSummary[] = [];
let currentDetail: OutilScriptDetail | null = null;

function init(): void {
  try {
    socket = window.app.socketService.getSocket();
    if (!listenersReady) {
      setupEventListeners();
      listenersReady = true;
    }
    requestInitialStatus();
    hideLoading();
    console.log('[Outils UI] Initialisation terminée');
  } catch (error) {
    console.error('[Outils UI] Erreur d\'initialisation:', error);
  }
}

function setupEventListeners(): void {
  if (!socket) return;

  socket.on('outils:status', (status: OutilsStatus) => {
    currentScripts = status.scripts;
    renderScriptList();
    showMainContent();
  });

  socket.on('outils:script:result', (detail: OutilScriptDetail) => {
    currentDetail = detail;
    renderDetail();
  });

  socket.on('outils:script:add:result', (result: AddScriptResult) => {
    const btn = $('btn-add-script') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    if (result.success) {
      showAlert('Script ajouté.', 'success', 'add');
      const yamlInput = $('add-yaml') as HTMLInputElement | null;
      const wrapperInput = $('add-wrapper') as HTMLInputElement | null;
      const engineInput = $('add-engine') as HTMLInputElement | null;
      const zipInput = $('add-zip') as HTMLInputElement | null;
      if (yamlInput) yamlInput.value = '';
      if (wrapperInput) wrapperInput.value = '';
      if (engineInput) engineInput.value = '';
      if (zipInput) zipInput.value = '';
    } else {
      showAlert(result.error || 'Échec de l\'ajout.', 'error', 'add');
    }
  });

  socket.on('outils:script:delete:result', (result: DeleteScriptResult) => {
    if (!result.success) {
      showAlert(result.error || 'Échec de la suppression.', 'error', 'list');
    } else if (currentDetail) {
      const detailCard = $('detail-card');
      if (detailCard) detailCard.style.display = 'none';
      currentDetail = null;
    }
  });

  socket.on('outils:error', (data: { message: string }) => {
    showAlert(data.message, 'error', 'list');
  });

  socket.on('outils:bundle:result', (result: BundleResult) => { onBundleResult(result); });
  socket.on('outils:zip:result', (result: ZipResult) => { onZipResult(result); });

  socket.on('connect', () => {
    console.log('[Outils UI] Connecté au serveur Socket.io');
    requestInitialStatus();
  });

  socket.on('disconnect', () => {
    console.log('[Outils UI] Déconnecté du serveur Socket.io');
  });

  $('btn-add-script')?.addEventListener('click', () => { void submitAddScript(); });
  $('btn-add-zip')?.addEventListener('click', () => { void submitAddZip(); });
  $('btn-generate')?.addEventListener('click', () => generateAndDownload());
  $('btn-generate-zip')?.addEventListener('click', () => { void generateZip(); });
  $('btn-copy-command')?.addEventListener('click', () => { void copyCommand(); });
}

function requestInitialStatus(): void {
  if (!socket) return;
  socket.emit('outils:status:get');
}

function renderScriptList(): void {
  const listEl = $('script-list');
  const emptyHint = $('empty-hint');
  if (!listEl) return;

  if (currentScripts.length === 0) {
    listEl.innerHTML = '';
    if (emptyHint) emptyHint.style.display = 'block';
    return;
  }
  if (emptyHint) emptyHint.style.display = 'none';

  listEl.innerHTML = currentScripts.map((s) => `
    <div class="script-item" data-id="${escapeHtml(s.id)}">
      <div class="script-info">
        <strong>${escapeHtml(s.title)}</strong>
        <span>${escapeHtml(s.description || 'Aucune description')}</span>
      </div>
      <div class="script-actions">
        ${s.builtin ? '<span class="builtin-badge">intégré</span>' : ''}
        ${s.requiresSudo ? '<span class="sudo-badge">sudo</span>' : ''}
        <button class="btn btn-primary btn-small" data-action="select" data-id="${escapeHtml(s.id)}">Sélectionner</button>
        ${s.builtin ? '' : `<button class="btn btn-danger btn-small" data-action="delete" data-id="${escapeHtml(s.id)}">Retirer</button>`}
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('[data-action="select"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id;
      if (id) selectScript(id);
    });
  });
  listEl.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).dataset.id;
      const script = currentScripts.find((s) => s.id === id);
      if (id && script && confirm(`Retirer le script « ${script.title} » ?`)) {
        socket?.emit('outils:script:delete', { id });
      }
    });
  });
}

function selectScript(id: string): void {
  if (!socket) return;
  socket.emit('outils:script:get', { id });
}

function renderDetail(): void {
  if (!currentDetail) return;
  const card = $('detail-card');
  const titleHeader = $('detail-title-header');
  const descriptionEl = $('detail-description');
  const formEl = $('variable-form');
  const noVarsHint = $('no-variables-hint');
  const commandBox = $('command-box');

  if (titleHeader) titleHeader.textContent = currentDetail.title;
  if (descriptionEl) descriptionEl.textContent = currentDetail.description || '';
  if (commandBox) commandBox.style.display = 'none';

  if (formEl) {
    if (currentDetail.variables.length === 0) {
      formEl.innerHTML = '';
      if (noVarsHint) noVarsHint.style.display = 'block';
    } else {
      if (noVarsHint) noVarsHint.style.display = 'none';
      formEl.innerHTML = currentDetail.variables.map((v) => renderVariableField(v, currentDetail!.variableHints[v], currentDetail!.savedValues[v])).join('');
    }
  }

  if (card) card.style.display = 'block';
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function humanizeLabel(token: string): string {
  const lower = token.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Rend un champ de variable selon la directive détectée dans le script (⭐ 18/09/2026, demande
 * explicite — "ce sera dans le script lui-même que c'est une liste, pas dans l'application") :
 * `select` -> liste déroulante (un choix), `checklist` -> cases à cocher (plusieurs choix, valeurs
 * jointes par des virgules à la génération, voir readVariableValue()), sinon un simple champ texte
 * (comportement par défaut, inchangé). `hint`, quand présent, s'affiche sous le libellé. `default`
 * (⭐ 18/09/2026), quand présent, préremplit un champ texte ou présélectionne une option d'un select.
 * `savedValue` (⭐ 19/09/2026, valeur réellement saisie la dernière fois — voir ScriptValues.ts côté
 * serveur) prime sur `default` : plus pertinent qu'un défaut générique déclaré par le script.
 */
function renderVariableField(name: string, hint: VariableHint | undefined, savedValue: string | undefined): string {
  const label = escapeHtml(humanizeLabel(name));
  const id = `var-${escapeHtml(name)}`;
  const hintHtml = hint?.help ? `<div class="field-hint">${escapeHtml(hint.help)}</div>` : '';

  if (hint?.type === 'select') {
    const selected = savedValue || hint.default;
    const options = hint.options.map((o) => `<option value="${escapeHtml(o)}"${o === selected ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
    return `
      <div class="form-group">
        <label for="${id}">${label}</label>
        <select id="${id}" data-var="${escapeHtml(name)}">
          <option value="">— choisir —</option>
          ${options}
        </select>
        ${hintHtml}
      </div>
    `;
  }

  if (hint?.type === 'checklist') {
    const savedSet = new Set((savedValue || '').split(',').map((s) => s.trim()).filter(Boolean));
    const items = hint.options.map((o) => `
      <label class="checklist-item">
        <input type="checkbox" value="${escapeHtml(o)}"${savedSet.has(o) ? ' checked' : ''}> ${escapeHtml(o)}
      </label>
    `).join('');
    return `
      <div class="form-group">
        <label>${label}</label>
        <div class="checklist" id="${id}" data-var="${escapeHtml(name)}" data-kind="checklist">
          ${items}
        </div>
        ${hintHtml}
      </div>
    `;
  }

  const defaultValue = savedValue || (hint?.type === 'text' ? hint.default : undefined);
  return `
    <div class="form-group">
      <label for="${id}">${label}</label>
      <input type="text" id="${id}" data-var="${escapeHtml(name)}" placeholder="${escapeHtml(name)}" value="${escapeHtml(defaultValue || '')}">
      ${hintHtml}
    </div>
  `;
}

/** Lit la valeur courante d'une variable, quel que soit le type de champ rendu par
 *  renderVariableField() (texte/select -> .value, checklist -> cases cochées jointes par ','). */
function readVariableValue(name: string): string {
  const el = $(`var-${name}`);
  if (!el) return '';
  if (el.dataset.kind === 'checklist') {
    const checked = Array.from(el.querySelectorAll('input[type="checkbox"]:checked')) as HTMLInputElement[];
    return checked.map((c) => c.value).join(',');
  }
  return (el as HTMLInputElement | HTMLSelectElement).value ?? '';
}

/**
 * ⭐ 18/09/2026, demande explicite suite à un bug réel constaté (script téléchargé seul, échoue hors
 * d'un clone du dépôt) — un script `hasBundling` (voir OutilScriptDetail) n'est plus téléchargé
 * directement comme un simple Blob : le texte substitué est envoyé au serveur (`outils:bundle:build`)
 * qui construit une archive auto-extractible autonome (voir BundleBuilder.ts), puis le navigateur
 * télécharge le résultat via la route HTTP générique une fois `outils:bundle:result` reçu. Un script
 * SANS dépendance déclarée garde le téléchargement Blob direct, comportement historique inchangé.
 */
function generateAndDownload(): void {
  if (!currentDetail) return;

  let content = currentDetail.content;
  const missing: string[] = [];
  const values: Record<string, string> = {};
  for (const v of currentDetail.variables) {
    const value = readVariableValue(v);
    values[v] = value;
    if (!value) missing.push(v);
    content = content.split(`__${v}__`).join(value);
  }
  // ⭐ 19/09/2026, demande explicite — sauvegarde les valeurs saisies pour préremplir la prochaine
  // fois (voir ScriptValues.ts), avant même de savoir si la génération va au bout (fire-and-forget).
  socket?.emit('outils:values:save', { id: currentDetail.id, values });

  if (missing.length > 0) {
    if (!confirm(`Ces variables sont vides : ${missing.join(', ')}. Télécharger quand même ?`)) {
      return;
    }
  }

  if (currentDetail.hasBundling) {
    requestBundle(content);
    return;
  }

  const blob = new Blob([content], { type: 'text/x-sh' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentDetail.filename;
  a.click();
  URL.revokeObjectURL(url);

  showGeneratedCommand();
}

function requestBundle(content: string): void {
  if (!socket || !currentDetail) return;
  const btn = $('btn-generate') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération de l\'archive...'; }
  socket.emit('outils:bundle:build', { id: currentDetail.id, content });
}

function onBundleResult(result: BundleResult): void {
  const btn = $('btn-generate') as HTMLButtonElement | null;
  if (btn) { btn.disabled = false; btn.textContent = '⬇️ Générer et télécharger'; }

  if (!result.success || !result.token) {
    showAlert(result.error || 'Échec de la génération de l\'archive.', 'error', 'list');
    return;
  }

  const a = document.createElement('a');
  a.href = `/api/apps/outils/download/${result.token}`;
  a.download = result.filename || 'script.sh';
  a.click();

  showGeneratedCommand();
}

/** ⭐ 20/09/2026 — .zip contenant le wrapper substitué + son yaml (+ dépendances @outils:bundle
 *  éventuelles) — toujours disponible, contrairement à l'archive auto-extractible (réservée aux
 *  scripts avec dépendances déclarées). Mêmes valeurs de variables que "Générer et télécharger". */
function generateZip(): void {
  if (!socket || !currentDetail) return;

  let content = currentDetail.content;
  for (const v of currentDetail.variables) {
    content = content.split(`__${v}__`).join(readVariableValue(v));
  }

  const btn = $('btn-generate-zip') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Génération du zip...'; }
  socket.emit('outils:zip:build', { id: currentDetail.id, content });
}

function onZipResult(result: ZipResult): void {
  const btn = $('btn-generate-zip') as HTMLButtonElement | null;
  if (btn) { btn.disabled = false; btn.textContent = '🗜️ Télécharger en .zip (script + yaml + wrapper)'; }

  if (!result.success || !result.token) {
    showAlert(result.error || 'Échec de la génération du zip.', 'error', 'list');
    return;
  }

  const a = document.createElement('a');
  a.href = `/api/apps/outils/download/${result.token}`;
  a.download = result.filename || 'script.zip';
  a.click();
}

function showGeneratedCommand(): void {
  if (!currentDetail) return;
  const commandBox = $('command-box');
  const commandText = $('command-text');
  if (commandText) {
    commandText.textContent = currentDetail.requiresSudo
      ? `sudo bash ${currentDetail.filename}`
      : `bash ${currentDetail.filename}`;
  }
  if (commandBox) commandBox.style.display = 'flex';
}

async function copyCommand(): Promise<void> {
  const commandText = $('command-text');
  const feedback = $('copy-feedback');
  if (!commandText?.textContent) return;
  try {
    await navigator.clipboard.writeText(commandText.textContent);
    if (feedback) {
      feedback.style.display = 'inline';
      setTimeout(() => { feedback.style.display = 'none'; }, 2000);
    }
  } catch (error) {
    console.error('[Outils UI] Échec de la copie presse-papier:', error);
  }
}

/** Dépose un fichier via la route générique POST /api/apps/outils/upload, tagué avec `batchId`
 *  (corrèle les 3 dépôts séparés côté serveur — voir OutilsService.handleUpload) et `role`. */
async function uploadPart(batchId: string, role: 'yaml' | 'wrapper' | 'engine' | 'zip', file: File): Promise<void> {
  const formData = new FormData();
  formData.append('batchId', batchId);
  formData.append('role', role);
  formData.append('file', file, file.name);
  const response = await fetch('/api/apps/outils/upload', { method: 'POST', body: formData });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${response.status}`);
  }
}

/**
 * ⭐ 20/09/2026 — 3 dépôts séparés (demande explicite, "pas un zip") : yaml + wrapper obligatoires,
 * moteur optionnel, chacun envoyé par un appel HTTP séparé mais corrélé par un même `batchId` —
 * le serveur finalise (écriture réelle + `outils:script:add:result`) dès que yaml+wrapper sont
 * tous les deux arrivés.
 */
async function submitAddScript(): Promise<void> {
  const yamlInput = $('add-yaml') as HTMLInputElement | null;
  const wrapperInput = $('add-wrapper') as HTMLInputElement | null;
  const engineInput = $('add-engine') as HTMLInputElement | null;
  const btn = $('btn-add-script') as HTMLButtonElement | null;

  const yamlFile = yamlInput?.files?.[0];
  const wrapperFile = wrapperInput?.files?.[0];
  const engineFile = engineInput?.files?.[0];

  if (!yamlFile || !wrapperFile) {
    showAlert('Le yaml et le wrapper (.sh) sont obligatoires.', 'error', 'add');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const batchId = crypto.randomUUID();
    await uploadPart(batchId, 'yaml', yamlFile);
    if (engineFile) await uploadPart(batchId, 'engine', engineFile);
    // Le wrapper en dernier : c'est lui qui déclenche la finalisation côté serveur une fois les
    // deux pièces obligatoires réunies (voir OutilsService.handleUpload).
    await uploadPart(batchId, 'wrapper', wrapperFile);
    // Résultat réel (ajout réussi ou non) relayé par outils:script:add:result (Socket.io) — ces
    // réponses HTTP ne sont que des accusés de réception, même convention que scriptsha/HAPLAN.
  } catch (error) {
    if (btn) btn.disabled = false;
    showAlert(`Échec du dépôt: ${error instanceof Error ? error.message : String(error)}`, 'error', 'add');
  }
}

/** ⭐ 20/09/2026, demande explicite — import d'un .zip précédemment exporté (voir generateZip()) :
 *  un seul dépôt, autonome (pas de batchId à corréler, tout arrive dans le même fichier). */
async function submitAddZip(): Promise<void> {
  const zipInput = $('add-zip') as HTMLInputElement | null;
  const btn = $('btn-add-zip') as HTMLButtonElement | null;
  const zipFile = zipInput?.files?.[0];

  if (!zipFile) {
    showAlert('Choisissez un fichier .zip à importer.', 'error', 'add');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    await uploadPart(crypto.randomUUID(), 'zip', zipFile);
  } catch (error) {
    if (btn) btn.disabled = false;
    showAlert(`Échec de l'import: ${error instanceof Error ? error.message : String(error)}`, 'error', 'add');
  }
}

function showMainContent(): void {
  const listCard = $('list-card');
  const addCard = $('add-card');
  if (listCard) listCard.style.display = 'block';
  if (addCard) addCard.style.display = 'block';
}

function hideLoading(): void {
  const loadingEl = $('loading');
  if (loadingEl) loadingEl.style.display = 'none';
}

function showAlert(message: string, type: 'success' | 'error', prefix: string): void {
  const successEl = $(`${prefix}-success`);
  const errorEl = $(`${prefix}-error`);
  [successEl, errorEl].forEach((el) => { if (el) el.style.display = 'none'; });
  const el = type === 'error' ? errorEl : successEl;
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

declare global {
  interface Window {
    outilsApp: { init: () => void };
  }
}

window.outilsApp = { init };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export {};
