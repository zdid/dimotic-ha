/**
 * Affichage SUPERVISION sur la page d'accueil (fonctionnelles-supervision_specs §6) — script chargé
 * UNE fois par le core (HomeView.ts), qui appelle `window.supervisionAccueil.init(slot)` à chaque
 * visite de l'accueil avec le conteneur où accueil.html vient d'être inséré. Toute la logique est
 * côté serveur (SupervisionService) : ici, rendu de `supervision:state` et envoi de la sélection.
 */

interface SupApp { id: string; name: string; icon: string; state?: string; selected: boolean; announced: boolean }
interface SupBackupLine { level: string; text: string; date?: string }
interface SupMachine {
  machineId: string; label?: string; local: boolean; selected: boolean; inGossip: boolean;
  address?: string; addresses?: string[]; webPort?: number; runningInDocker?: boolean;
  presence: 'online' | 'lost' | 'unknown'; publishedAt?: string; stale: boolean | null;
  apps: SupApp[];
  backup?: { level: string; target?: string; reason?: string; lines?: SupBackupLine[] };
}
interface SupState {
  localMachineId: string;
  selection: { machines: Record<string, { label?: string; apps: string[] }> } | null;
  machines: SupMachine[];
  backups: { fetchedAt?: string; pending: boolean; error?: string };
}

(() => {
  const w = window as unknown as {
    app: { socketService: { getSocket(): { on(e: string, cb: (d: any) => void): void; emit(e: string, d?: unknown): void } } };
    supervisionAccueil?: { init: (slot: HTMLElement) => void };
  };

  let slot: HTMLElement | null = null;
  let state: SupState | null = null;
  let listening = false;

  const STATE_LABELS: Record<string, string> = {
    running: 'en marche', 'in-process': 'en marche', starting: 'démarrage', restarting: 'redémarrage',
    crashed: 'plantée', stopped: 'arrêtée'
  };

  function esc(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  }

  function fmtDate(iso?: string): string {
    if (!iso) return '?';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function socket() {
    return w.app.socketService.getSocket();
  }

  function appBadge(app: SupApp, machineSelected: boolean): string {
    if (!app.announced) return '<span class="sup-badge sup-error">plus annoncée</span>';
    if (!app.state) return '<span class="sup-badge">état inconnu</span>';
    const label = STATE_LABELS[app.state] ?? app.state;
    const cls = app.state === 'running' || app.state === 'in-process' ? 'sup-ok'
      : app.state === 'crashed' || app.state === 'stopped' ? (machineSelected && app.selected ? 'sup-error' : 'sup-warn') : 'sup-warn';
    return `<span class="sup-badge ${cls}">${esc(label)}</span>`;
  }

  function renderBackup(m: SupMachine): string {
    if (!m.selected) return '';
    if (!state) return '';
    const b = m.backup;
    if (!b) {
      const why = state.backups.error ? `indisponibles : ${state.backups.error}` : state.backups.pending ? 'lecture en cours…' : 'pas encore lues';
      return `<div class="sup-backup">💾 Sauvegardes ${esc(why)}</div>`;
    }
    if (b.level === 'unconfigured') return `<div class="sup-backup">💾 <span class="sup-badge">sauvegarde non configurée</span> <span class="sup-meta">${esc(b.reason)}</span></div>`;
    const labels: Record<string, string> = { ok: 'OK', warn: 'à surveiller', error: 'en erreur', none: 'aucune sauvegarde' };
    const lines = (b.lines ?? []).map((l) =>
      `<li class="sup-line-${esc(l.level)}">${esc(l.text).replace('{date}', esc(fmtDate(l.date)))}</li>`).join('');
    return `<div class="sup-backup">💾 Sauvegardes (${esc(b.target)}) <span class="sup-badge sup-${esc(b.level)}">${esc(labels[b.level] ?? b.level)}</span><ul>${lines}</ul></div>`;
  }

  function renderMachine(m: SupMachine): string {
    const presence = m.presence === 'online' ? '<span class="sup-badge sup-ok">en ligne</span>'
      : m.presence === 'lost' ? '<span class="sup-badge sup-error">perdue</span>'
      : '<span class="sup-badge">présence inconnue</span>';
    const meta = [
      m.addresses && m.addresses.length ? m.addresses.map(esc).join(' / ') : m.address ? esc(m.address) : 'adresse inconnue',
      m.runningInDocker === undefined ? '' : m.runningInDocker ? 'Docker' : 'hôte',
      m.local ? 'cette machine' : ''
    ].filter(Boolean).join(' · ');
    const announce = !m.inGossip ? '<span class="sup-badge sup-error">absente du gossip</span>'
      : m.publishedAt ? `<span class="sup-meta">annonce ${esc(fmtDate(m.publishedAt))}</span>${m.stale ? ' <span class="sup-badge sup-warn">périmée</span>' : ''}`
      : '';
    const apps = m.apps.map((a) => {
      const label = `${esc(a.icon)} ${esc(a.name)}`;
      const link = m.address && m.webPort && a.announced
        ? `<a href="http://${esc(m.address)}:${esc(m.webPort)}/" target="_blank" rel="noopener">${label}</a>` : label;
      const box = m.selected
        ? `<input type="checkbox" data-sup-app="${esc(m.machineId)}" value="${esc(a.id)}"${a.selected ? ' checked' : ''} title="Application supervisée">` : '';
      return `<li>${box}${link} ${appBadge(a, m.selected)}</li>`;
    }).join('');
    return `
      <div class="sup-machine${m.selected ? '' : ' sup-off'}">
        <div class="sup-mhead">
          <input type="checkbox" data-sup-machine="${esc(m.machineId)}"${m.selected ? ' checked' : ''} title="Machine supervisée">
          <strong>${esc(m.machineId)}</strong>${m.label ? ` <span>(${esc(m.label)})</span>` : ''}
          <span class="sup-meta">${meta}</span> ${presence} ${announce}
        </div>
        <ul class="sup-apps">${apps || '<li class="sup-meta">Aucune application annoncée</li>'}</ul>
        ${renderBackup(m)}
      </div>`;
  }

  function render(): void {
    if (!slot || !state || !slot.isConnected) return;
    const selected = state.machines.filter((m) => m.selected);
    const others = state.machines.filter((m) => !m.selected);
    const selEl = slot.querySelector('[data-sup-selected]');
    const othEl = slot.querySelector('[data-sup-others]');
    const othWrap = slot.querySelector<HTMLElement>('[data-sup-others-wrap]');
    const othTitle = slot.querySelector('[data-sup-others-title]');
    const backupsEl = slot.querySelector('[data-sup-backups-state]');
    if (selEl) selEl.innerHTML = selected.length ? selected.map(renderMachine).join('')
      : '<p class="sup-meta">Aucune machine supervisée : cochez-en une ci-dessous.</p>';
    if (othEl) othEl.innerHTML = others.map(renderMachine).join('');
    if (othWrap) {
      othWrap.style.display = others.length ? '' : 'none';
      if (!selected.length) (othWrap as HTMLDetailsElement).open = true;
    }
    if (othTitle) othTitle.textContent = `Autres machines (${others.length})`;
    if (backupsEl) {
      const b = state.backups;
      backupsEl.textContent = b.pending ? 'Lecture des sauvegardes…'
        : b.error ? `Sauvegardes indisponibles : ${b.error}`
        : b.fetchedAt ? `Sauvegardes lues à ${fmtDate(b.fetchedAt)}` : '';
    }
  }

  /** Sélection ENTIÈRE reconstruite depuis les cases (spec §4 : remplacée à chaque modification). */
  function sendSelection(): void {
    if (!slot || !state) return;
    const machines: Record<string, { label?: string; apps: string[] }> = {};
    slot.querySelectorAll<HTMLInputElement>('[data-sup-machine]').forEach((box) => {
      if (!box.checked) return;
      const id = box.dataset.supMachine!;
      const previous = state!.machines.find((m) => m.machineId === id);
      const apps = previous?.selected
        ? [...slot!.querySelectorAll<HTMLInputElement>('[data-sup-app]')]
          .filter((b) => b.dataset.supApp === id && b.checked).map((b) => b.value)
        // Machine qui vient d'être cochée : ses applications annoncées sont cochées avec elle.
        : (previous?.apps ?? []).filter((a) => a.announced).map((a) => a.id);
      machines[id] = { ...(previous?.label ? { label: previous.label } : {}), apps };
    });
    socket().emit('supervision:selection:set', { machines });
  }

  function init(target: HTMLElement): void {
    slot = target;
    if (!listening) {
      listening = true;
      socket().on('supervision:state', (data: SupState) => { state = data; render(); });
    }
    target.addEventListener('change', (ev) => {
      const el = ev.target as HTMLElement;
      if (el.matches('[data-sup-machine], [data-sup-app]')) sendSelection();
    });
    target.querySelector('[data-sup-refresh]')?.addEventListener('click', () => socket().emit('supervision:backups:refresh'));
    render();
    socket().emit('supervision:state:get');
    // Rafraîchissement à l'ouverture de la page d'accueil (spec §5).
    socket().emit('supervision:backups:refresh');
  }

  w.supervisionAccueil = { init };
})();
