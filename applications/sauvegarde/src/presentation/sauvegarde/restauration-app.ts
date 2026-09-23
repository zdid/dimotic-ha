/**
 * Assistant de restauration — écrans ①-④ (⭐ 23/09/2026, décisions de conception du même jour,
 * voir TODO.md « DÉCISION restauration » et spec sauvegarde §6ter). Page autonome (comme le tableau
 * de bord HAPLAN), sa propre connexion Socket.io. Lecture seule : liste les sauvegardes présentes
 * sur Nextcloud, lit le manifeste choisi, compare avec l'espace libre et l'IP de la machine de
 * destination (IP saisie, SSH root — ⭐ 23/09/2026, pas forcément celle qui fait tourner dimotic-ha).
 * ⭐ 23/09/2026 (soir) — écrans ⑤/⑥ : lancement de l'étape 1 (script RestoreScript.ts, détaché sur la
 * destination), progression relue dans restore-status.json, étape 2 (démarrage) après validation.
 *
 * Le mot de passe Nextcloud est saisi ici et envoyé à chaque requête, jamais conservé (décision 3).
 */

import { SocketService } from '/js/ts/services/SocketService.js';

interface BackupEntry {
  site: string;
  machine: string;
  cadence: string;
  parent: string;
  date: string;
  archiveSize: number;
  hasManifest: boolean;
}

interface ManifestItem {
  name: string;
  size?: number;
}

interface DestinationProbe {
  host: string;
  reachable: boolean;
  error?: string;
  hostname?: string;
  freeBytes?: number;
  docker?: boolean;
  compose?: boolean;
  curl?: boolean;
  tar?: boolean;
}

interface ManifestResult {
  requestId: string;
  success: boolean;
  error?: string;
  items?: ManifestItem[];
  sourceIp?: string;
  destination?: DestinationProbe;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let socket: any;
let backups: BackupEntry[] = [];
let manifest: ManifestResult | null = null;
let selectedBackup: BackupEntry | null = null;
let pendingRequestId = '';
let pendingProbeId = '';
let pendingStartId = '';

interface RestoreStatus {
  phase: string;
  state: 'running' | 'failed' | 'phase1-done' | 'done';
  step: string;
  message: string;
  updatedAt: string;
  source: string;
  backupRoot: string;
  log: string;
  items: Record<string, string>;
}
let publicKey = '';

function newRequestId(): string {
  pendingRequestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return pendingRequestId;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function setMsg(id: string, text: string, kind: 'error' | 'ok' | 'warn' | '' = ''): void {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${kind}`;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function credentials() {
  return {
    serverUrl: $<HTMLInputElement>('nc-url').value.trim(),
    user: $<HTMLInputElement>('nc-user').value.trim(),
    rootPath: $<HTMLInputElement>('nc-root').value.trim(),
    password: $<HTMLInputElement>('nc-password').value
  };
}

function fillSelect(id: string, values: Array<{ value: string; label: string }>): void {
  const select = $<HTMLSelectElement>(id);
  select.innerHTML = values.map((v) => `<option value="${escapeHtml(v.value)}">${escapeHtml(v.label)}</option>`).join('');
}

// ---------------------------------------------------------------- ① Connexion

function connect(): void {
  const c = credentials();
  if (!c.serverUrl || !c.user || !c.password || !$<HTMLInputElement>('dest-host').value.trim()) {
    setMsg('connect-msg', 'URL, utilisateur, mot de passe et machine de destination sont requis.', 'error');
    return;
  }
  $<HTMLButtonElement>('btn-connect').disabled = true;
  setMsg('connect-msg', 'Lecture des sauvegardes sur Nextcloud…');
  ['step-source', 'step-content', 'step-checks'].forEach((id) => ($(id).hidden = true));
  socket.emit('sauvegarde:restore:list', { requestId: newRequestId(), credentials: c });
}

function onListResult(data: { requestId: string; success: boolean; error?: string; backups?: BackupEntry[] }): void {
  if (data.requestId !== pendingRequestId) return;
  $<HTMLButtonElement>('btn-connect').disabled = false;
  if (!data.success) {
    setMsg('connect-msg', data.error || 'Échec du listage.', 'error');
    return;
  }
  backups = data.backups || [];
  if (backups.length === 0) {
    setMsg('connect-msg', 'Connexion réussie, mais aucune sauvegarde trouvée sous ce sous-dossier.', 'warn');
    return;
  }
  setMsg('connect-msg', `Connexion réussie — ${backups.length} sauvegarde(s) trouvée(s).`, 'ok');
  const sites = Array.from(new Set(backups.map((b) => b.site))).sort();
  fillSelect('src-site', sites.map((s) => ({ value: s, label: s })));
  $('step-source').hidden = false;
  onSiteChange();
}

// ---------------------------------------------------------------- ② Source

function onSiteChange(): void {
  const site = $<HTMLSelectElement>('src-site').value;
  const machines = Array.from(new Set(backups.filter((b) => b.site === site).map((b) => b.machine))).sort();
  fillSelect('src-machine', machines.map((m) => ({ value: m, label: m })));
  onMachineChange();
}

function backupKey(b: BackupEntry): string {
  return [b.cadence, b.parent, b.date].join('|');
}

function onMachineChange(): void {
  const site = $<HTMLSelectElement>('src-site').value;
  const machine = $<HTMLSelectElement>('src-machine').value;
  // Décision 7 : journalier et hebdomadaire mélangés, triés par date décroissante.
  const list = backups.filter((b) => b.site === site && b.machine === machine);
  fillSelect('src-date', list.map((b) => ({
    value: backupKey(b),
    label: `${b.date} · ${b.cadence} · ${b.parent} (${formatBytes(b.archiveSize)} compressé)${b.hasManifest ? '' : ' — sans manifeste'}`
  })));
  onDateChange();
}

function onDateChange(): void {
  const site = $<HTMLSelectElement>('src-site').value;
  const machine = $<HTMLSelectElement>('src-machine').value;
  const key = $<HTMLSelectElement>('src-date').value;
  selectedBackup = backups.find((b) => b.site === site && b.machine === machine && backupKey(b) === key) || null;
  manifest = null;
  $('step-content').hidden = true;
  $('step-checks').hidden = true;
  if (!selectedBackup) return;
  if (!selectedBackup.hasManifest) {
    setMsg('source-msg', 'Cette sauvegarde n\'a pas de manifeste : contenu inconnu, restauration par élément impossible.', 'error');
    return;
  }
  setMsg('source-msg', 'Lecture du manifeste…');
  const { site: s, machine: m, cadence, parent, date } = selectedBackup;
  socket.emit('sauvegarde:restore:manifest', {
    requestId: newRequestId(),
    credentials: credentials(),
    destinationHost: $<HTMLInputElement>('dest-host').value.trim(),
    backup: { site: s, machine: m, cadence, parent, date }
  });
}

// ---------------------------------------------------------------- ③ Contenu

function onManifestResult(data: ManifestResult): void {
  if (data.requestId !== pendingRequestId) return;
  if (!data.success) {
    setMsg('source-msg', data.error || 'Échec de lecture du manifeste.', 'error');
    return;
  }
  setMsg('source-msg', '');
  manifest = data;
  const items = data.items || [];
  const sizesKnown = items.every((i) => i.size !== undefined);
  $('items').innerHTML = `
    <li class="all"><input type="checkbox" id="item-all" checked> <label for="item-all" style="display:inline;margin:0">Tout</label></li>
    ${items.map((item, index) => `
      <li><input type="checkbox" class="item" id="item-${index}" data-index="${index}" checked>
        <label for="item-${index}" style="display:inline;margin:0;color:inherit">${escapeHtml(item.name)}</label>
        <span class="size">${item.size !== undefined ? formatBytes(item.size) : 'taille inconnue'}</span></li>`).join('')}`;
  $<HTMLInputElement>('item-all').addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    document.querySelectorAll<HTMLInputElement>('input.item').forEach((cb) => (cb.checked = checked));
    updateTotals();
  });
  document.querySelectorAll<HTMLInputElement>('input.item').forEach((cb) => cb.addEventListener('change', () => {
    const all = Array.from(document.querySelectorAll<HTMLInputElement>('input.item'));
    const allBox = $<HTMLInputElement>('item-all');
    allBox.checked = all.every((c) => c.checked);
    allBox.indeterminate = !allBox.checked && all.some((c) => c.checked);
    updateTotals();
  }));
  if (!sizesKnown) {
    setMsg('source-msg', 'Manifeste antérieur au 23/09/2026 : tailles décompressées inconnues, elles seront lues dans l\'archive après téléchargement.', 'warn');
  }
  $('step-content').hidden = false;
  $('step-checks').hidden = false;
  updateTotals();
  renderChecks();
}

function selectedItems(): ManifestItem[] {
  const items = manifest?.items || [];
  return Array.from(document.querySelectorAll<HTMLInputElement>('input.item:checked'))
    .map((cb) => items[Number(cb.dataset.index)])
    .filter(Boolean);
}

function updateTotals(): void {
  if (!manifest || !selectedBackup) return;
  const chosen = selectedItems();
  const unpacked = chosen.reduce((sum, i) => sum + (i.size ?? 0), 0);
  const sizesKnown = chosen.every((i) => i.size !== undefined);
  // Décision 14 : l'archive est téléchargée PUIS extraite sur la machine de destination — il faut la place des deux.
  const needed = selectedBackup.archiveSize + unpacked;
  let html = `${chosen.length} élément(s) sélectionné(s) — décompressé : <strong>${sizesKnown ? formatBytes(unpacked) : 'inconnu'}</strong>, `
    + `archive à télécharger : <strong>${formatBytes(selectedBackup.archiveSize)}</strong>.<br>`;
  const dest = manifest.destination;
  if (!dest || dest.freeBytes === undefined) {
    html += `<span class="msg warn">Espace libre de la destination inconnu${dest?.error ? ` (${escapeHtml(dest.error)})` : ''}.</span>`;
  } else {
    const enough = needed <= dest.freeBytes;
    html += `Espace libre sur ${escapeHtml(dest.host)} : <strong>${formatBytes(dest.freeBytes)}</strong> — `
      + (sizesKnown
        ? (enough ? '<span class="msg ok">suffisant</span>' : `<span class="msg error">insuffisant (besoin ≈ ${formatBytes(needed)})</span>`)
        : '<span class="msg warn">vérification complète impossible sans les tailles</span>');
  }
  $('totals').innerHTML = html;
  updateStep1Button();
}

/** Bouton étape 1 : manifeste lu, destination joignable, ≥ 1 élément, place non insuffisante, case cochée. */
function updateStep1Button(): void {
  const dest = manifest?.destination;
  const chosen = selectedItems();
  const known = chosen.every((i) => i.size !== undefined);
  const needed = (selectedBackup?.archiveSize ?? 0) + chosen.reduce((sum, i) => sum + (i.size ?? 0), 0);
  const spaceKo = Boolean(dest && dest.freeBytes !== undefined && known && needed > dest.freeBytes);
  const ready = Boolean(manifest && dest?.reachable && chosen.length > 0 && !spaceKo);
  $<HTMLButtonElement>('btn-step1').disabled = !(ready && $<HTMLInputElement>('confirm-step1').checked);
  if (dest) {
    $('confirm-step1-text').textContent = `Les ${chosen.length} élément(s) coché(s) seront arrêtés puis remplacés sur ${dest.host}`
      + ` (${dest.hostname || '?'}) ; l'existant est déplacé dans /${selectedBackup?.parent || 'docker'}-backup-<date>.`;
  }
}

// ---------------------------------------------------------------- ⑤/⑥ Restauration

function startStep1(): void {
  if (!manifest || !selectedBackup) return;
  const chosen = selectedItems();
  const known = chosen.every((i) => i.size !== undefined);
  const { site, machine, cadence, parent, date, archiveSize } = selectedBackup;
  pendingStartId = `start-${Date.now()}`;
  $<HTMLButtonElement>('btn-step1').disabled = true;
  setMsg('step1-msg', 'Dépôt du script et lancement…');
  socket.emit('sauvegarde:restore:start', {
    requestId: pendingStartId,
    credentials: credentials(),
    destinationHost: $<HTMLInputElement>('dest-host').value.trim(),
    backup: { site, machine, cadence, parent, date },
    items: chosen.map((i) => i.name),
    archiveSize,
    neededBytes: known ? chosen.reduce((sum, i) => sum + (i.size ?? 0), 0) : 0
  });
}

function onStartResult(data: { requestId: string; success: boolean; error?: string; host?: string }): void {
  if (data.requestId !== pendingStartId) return;
  if (!data.success) {
    setMsg('step1-msg', data.error || 'Échec du lancement.', 'error');
    updateStep1Button();
    return;
  }
  setMsg('step1-msg', 'Étape 1 lancée — suivre la progression ci-dessous.', 'ok');
  $<HTMLInputElement>('confirm-step1').checked = false;
}

function startStep2(): void {
  pendingStartId = `start2-${Date.now()}`;
  $<HTMLButtonElement>('btn-step2').disabled = true;
  setMsg('step2-msg', 'Lancement de l\'étape 2…');
  socket.emit('sauvegarde:restore:start2', { requestId: pendingStartId, destinationHost: $<HTMLInputElement>('dest-host').value.trim() });
}

function onStart2Result(data: { requestId: string; success: boolean; error?: string }): void {
  if (data.requestId !== pendingStartId) return;
  if (!data.success) {
    setMsg('step2-msg', data.error || 'Échec du lancement de l\'étape 2.', 'error');
    $<HTMLButtonElement>('btn-step2').disabled = !$<HTMLInputElement>('confirm-step2').checked;
    return;
  }
  setMsg('step2-msg', 'Étape 2 lancée — si dimotic-ha est restauré sur cette machine, la page se reconnectera à la fin.', 'ok');
  $<HTMLInputElement>('confirm-step2').checked = false;
}

const STATE_LABELS: Record<string, [string, string]> = {
  running: ['⏳ En cours', 'state-running'],
  failed: ['❌ Échec', 'state-failed'],
  'phase1-done': ['✅ Étape 1 terminée — en attente de validation', 'state-ok'],
  done: ['✅ Restauration terminée', 'state-ok']
};

function onRestoreStatus(data: { host: string; status: RestoreStatus | null }): void {
  if (data.host !== $<HTMLInputElement>('dest-host').value.trim()) return;
  const st = data.status;
  if (!st) {
    $('step-progress').hidden = true;
    $('step-start').hidden = true;
    return;
  }
  const [label, cls] = STATE_LABELS[st.state] || [st.state, ''];
  $('progress-host').textContent = `${data.host} · ${st.source}`;
  $('progress-state').innerHTML = `<div class="${cls}"><strong>${escapeHtml(label)}</strong> — ${st.phase === 'phase2' ? 'étape 2' : 'étape 1'}, `
    + `${escapeHtml(st.step)} : ${escapeHtml(st.message)}</div>`;
  $('progress-items').innerHTML = Object.entries(st.items || {})
    .map(([name, state]) => `<li>${escapeHtml(name)}<span class="size">${escapeHtml(state)}</span></li>`).join('');
  $('progress-meta').innerHTML = `Existant sauvegardé dans <code>${escapeHtml(st.backupRoot)}</code> · journal <code>${escapeHtml(st.log)}</code>`
    + ` · mis à jour ${escapeHtml(new Date(st.updatedAt).toLocaleTimeString())}`;
  $('step-progress').hidden = false;
  const waiting = st.phase === 'phase1' && st.state === 'phase1-done';
  $('step-start').hidden = !(waiting || st.phase === 'phase2');
  $<HTMLButtonElement>('btn-step2').disabled = !(waiting && $<HTMLInputElement>('confirm-step2').checked);
  // Pendant qu'une restauration tourne sur cette destination, pas de second lancement.
  if (st.state === 'running') $<HTMLButtonElement>('btn-step1').disabled = true;
}

function requestStatus(): void {
  const host = $<HTMLInputElement>('dest-host').value.trim();
  if (host) socket.emit('sauvegarde:restore:status:get', { destinationHost: host });
}

// ---------------------------------------------------------------- ④ Vérifications

function renderChecks(): void {
  if (!manifest || !selectedBackup) return;
  const destIp = manifest.destination?.host || '?';
  const sourceIp = manifest.sourceIp;
  let html: string;
  if (!sourceIp) {
    html = `<div class="notice">⚠️ Adresse IP de <strong>${escapeHtml(selectedBackup.machine)}</strong> inconnue (machine absente de la
      configuration Sauvegarde) — vérifier que la destination (${escapeHtml(destIp)}) reprendra bien l'IP de la source.</div>`;
  } else if (sourceIp !== destIp) {
    // Décision 5 : avertissement non bloquant.
    html = `<div class="notice">⚠️ La destination est en <strong>${escapeHtml(destIp)}</strong>, la source
      <strong>${escapeHtml(selectedBackup.machine)}</strong> était en <strong>${escapeHtml(sourceIp)}</strong>.
      Décision retenue : la machine restaurée reprend l'IP de la source (réservation DHCP) — aucune adresse
      n'est réécrite dans les fichiers restaurés.</div>`;
  } else {
    html = `<div class="notice info">✅ La destination a déjà l'adresse de la source (${escapeHtml(sourceIp)}).</div>`;
  }
  $('checks').innerHTML = html;
  $('dest-checks').innerHTML = manifest.destination ? probeHtml(manifest.destination) : '';
}

/**
 * Contrôles de la destination (⭐ 23/09/2026) — SSH root bloquant ; docker/compose/curl/tar
 * absents NON bloquants : l'étape 1 les installera (get.docker.com, comme prepare-sd-card.sh).
 */
function probeHtml(p: DestinationProbe): string {
  if (!p.reachable) {
    return `<div class="notice">❌ ${escapeHtml(p.error || 'Destination injoignable.')}</div>`;
  }
  const line = (ok: boolean | undefined, label: string, missing: string) =>
    `<li>${ok ? '✅' : '🛠️'} ${label}${ok ? '' : ` — <span class="msg warn">${missing}</span>`}</li>`;
  return `<ul class="checks">
    <li>✅ SSH root@${escapeHtml(p.host)} (${escapeHtml(p.hostname || '?')})</li>
    ${line(p.docker, 'Docker', 'absent : sera installé par l\'étape 1 (get.docker.com, accès internet requis)')}
    ${line(p.compose, 'docker compose', 'absent : sera installé avec Docker')}
    ${line(p.curl, 'curl', 'absent : sera installé par l\'étape 1 (apt)')}
    ${line(p.tar, 'tar', 'absent : sera installé par l\'étape 1 (apt)')}
    <li>${p.freeBytes !== undefined ? '✅' : '⚠️'} Espace libre : ${p.freeBytes !== undefined ? formatBytes(p.freeBytes) : 'inconnu'}</li>
  </ul>`;
}

// ---------------------------------------------------------------- Prérequis SSH / test destination

function renderPrereq(): void {
  const host = $<HTMLInputElement>('dest-host').value.trim() || '<IP>';
  const key = publicKey || '<clé publique introuvable>';
  $<HTMLTextAreaElement>('cmd-authorize').value =
    `mkdir -p /root/.ssh && chmod 700 /root/.ssh && echo '${key}' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`;
  $<HTMLTextAreaElement>('cmd-copyid').value = `ssh-copy-id -i data/core/ssh/id_ed25519.pub root@${host}`;
}

function copyField(id: string): void {
  const field = $<HTMLTextAreaElement>(id);
  field.select();
  // navigator.clipboard n'existe qu'en contexte sécurisé (https ou localhost) — en http sur l'IP
  // LAN, repli sur execCommand (texte déjà sélectionné, copiable à la main sinon).
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(field.value).catch(() => document.execCommand('copy'));
  } else {
    document.execCommand('copy');
  }
}

function probe(): void {
  const host = $<HTMLInputElement>('dest-host').value.trim();
  if (!host) {
    setMsg('connect-msg', 'Renseigner la machine de destination.', 'error');
    return;
  }
  pendingProbeId = `probe-${Date.now()}`;
  $('probe-result').innerHTML = '<div class="msg">Contrôle de la destination…</div>';
  socket.emit('sauvegarde:restore:probe', { requestId: pendingProbeId, destinationHost: host });
}

function onProbeResult(data: { requestId: string; probe: DestinationProbe }): void {
  if (data.requestId !== pendingProbeId) return;
  $('probe-result').innerHTML = probeHtml(data.probe);
  if (!data.probe.reachable) ($('prereq') as HTMLDetailsElement).open = true;
  // Bug live 23/09 : un « Tester » réussi après un ssh-copy-id ne mettait à jour que l'écran ① —
  // ③/④ gardaient le contrôle fait à la lecture du manifeste (clé encore refusée à ce moment-là).
  if (manifest && manifest.destination?.host === data.probe.host) {
    manifest.destination = data.probe;
    updateTotals();
    renderChecks();
  }
}

// ---------------------------------------------------------------- Initialisation

function init(): void {
  socket = new SocketService().connect();

  socket.on('connect', () => socket.emit('sauvegarde:restore:context:get', { requestId: 'context' }));
  socket.on('sauvegarde:restore:context', (data: { requestId?: string; nextcloud?: { serverUrl?: string; user?: string; rootPath?: string }; localIp?: string; publicKey?: string }) => {
    if (data.requestId !== 'context') return;
    $('local-ip').textContent = data.localIp || 'IP inconnue';
    // Préremplissage seulement si les champs sont encore vides (ne pas écraser une saisie en cours).
    const fill = (id: string, value?: string) => {
      const input = $<HTMLInputElement>(id);
      if (!input.value && value) input.value = value;
    };
    fill('nc-url', data.nextcloud?.serverUrl);
    fill('nc-user', data.nextcloud?.user);
    fill('nc-root', data.nextcloud?.rootPath);
    // ⭐ 23/09/2026, demande explicite : destination NON préremplie (l'IP de cette machine est
    // simplement rappelée dans le libellé du champ) — éviter de restaurer ici par mégarde.
    publicKey = data.publicKey || '';
    renderPrereq();
    // Rechargement / reconnexion (ex. dimotic-ha relancé depuis /docker-temp) : reprendre l'affichage.
    requestStatus();
  });
  socket.on('sauvegarde:restore:list:result', onListResult);
  socket.on('sauvegarde:restore:manifest:result', onManifestResult);
  socket.on('sauvegarde:restore:probe:result', onProbeResult);
  socket.on('sauvegarde:restore:start:result', onStartResult);
  socket.on('sauvegarde:restore:start2:result', onStart2Result);
  socket.on('sauvegarde:restore:status', onRestoreStatus);
  $('confirm-step1').addEventListener('change', updateStep1Button);
  $('btn-step1').addEventListener('click', startStep1);
  $('confirm-step2').addEventListener('change', () => {
    $<HTMLButtonElement>('btn-step2').disabled = !$<HTMLInputElement>('confirm-step2').checked;
  });
  $('btn-step2').addEventListener('click', startStep2);
  $('dest-host').addEventListener('change', requestStatus);
  $('btn-probe').addEventListener('click', probe);
  $('dest-host').addEventListener('input', renderPrereq);
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) =>
    btn.addEventListener('click', () => copyField(btn.dataset.copy!)));

  $('btn-connect').addEventListener('click', connect);
  $('nc-password').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') connect(); });
  $('src-site').addEventListener('change', onSiteChange);
  $('src-machine').addEventListener('change', onMachineChange);
  $('src-date').addEventListener('change', onDateChange);
  // Changer de destination relit l'espace libre et l'avertissement d'IP pour la sauvegarde choisie.
  $('dest-host').addEventListener('change', () => { if (selectedBackup?.hasManifest) onDateChange(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export {};
