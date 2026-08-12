/**
 * Page de gestion des macros — liste + suppression.
 * La création reste 100% conversationnelle (via l'application ia) : pas de formulaire de saisie
 * JSON en v1 (specs planificateur §11). Les planifications se gèrent depuis le tableau de bord
 * (index.html) — cette page ne les affiche plus (doublon retiré, demande utilisateur 12/08/2026).
 */

import { SocketService } from '/js/ts/services/SocketService.js';

function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

interface MacroDefinition {
  name: string;
  steps: unknown[];
}

let socket: any | null = null;

function init(): void {
  const socketService = new SocketService();
  socket = socketService.connect();

  socket.on('planificateur:macros:list', (macros: MacroDefinition[]) => renderMacros(macros));
  socket.on('connect', () => requestLists());

  requestLists();
}

function requestLists(): void {
  socket.emit('planificateur:macros:list:get');
}

function renderMacros(macros: MacroDefinition[]): void {
  const el = $('macros-list');
  if (!el) return;

  if (macros.length === 0) {
    el.innerHTML = '<div class="empty">Aucune macro enregistrée.</div>';
    return;
  }

  el.innerHTML = macros.map((m) => `
    <div class="item-row">
      <div class="item-info">
        <div class="name">${escapeHtml(m.name)}</div>
        <div class="detail">${m.steps.length} étape(s)</div>
      </div>
      <div class="item-actions">
        <button class="btn btn-danger" data-action="macro-supprimer" data-name="${escapeHtml(m.name)}">Supprimer</button>
      </div>
    </div>
  `).join('');

  wireActions(el);
}

function wireActions(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const name = btn.dataset.name;
      if (!action || !name || !socket) return;

      if (action === 'macro-supprimer') {
        socket.emit('planificateur:macro:supprimer', { name });
      }
    });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
