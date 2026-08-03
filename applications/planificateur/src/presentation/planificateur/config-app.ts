/**
 * Page de gestion des macros et planifications — liste + activer/désactiver/supprimer.
 * La création reste 100% conversationnelle (via l'application ia) : pas de formulaire de saisie
 * JSON en v1 (specs planificateur §11).
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

interface PlanificationDefinition {
  name: string;
  active: boolean;
  phrase_originale: string;
  trigger: { type: string };
  missed?: boolean;
}

let socket: any | null = null;

function init(): void {
  const socketService = new SocketService();
  socket = socketService.connect();

  socket.on('planificateur:macros:list', (macros: MacroDefinition[]) => renderMacros(macros));
  socket.on('planificateur:planifications:list', (plans: PlanificationDefinition[]) => renderPlanifications(plans));
  socket.on('connect', () => requestLists());

  requestLists();
}

function requestLists(): void {
  socket.emit('planificateur:macros:list:get');
  socket.emit('planificateur:planifications:list:get');
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

function renderPlanifications(plans: PlanificationDefinition[]): void {
  const el = $('planifications-list');
  if (!el) return;

  if (plans.length === 0) {
    el.innerHTML = '<div class="empty">Aucune planification enregistrée.</div>';
    return;
  }

  el.innerHTML = plans.map((p) => `
    <div class="item-row">
      <div class="item-info">
        <div class="name">${escapeHtml(p.name)} <span class="status-badge ${p.active ? 'active' : 'inactive'}">${p.active ? 'active' : 'inactive'}</span>${p.missed ? ' <span class="status-badge missed">manqué</span>' : ''}</div>
        <div class="detail">"${escapeHtml(p.phrase_originale)}" — ${escapeHtml(p.trigger.type)}</div>
      </div>
      <div class="item-actions">
        ${p.active
          ? `<button class="btn btn-secondary" data-action="planification-desactiver" data-name="${escapeHtml(p.name)}">Désactiver</button>`
          : `<button class="btn btn-primary" data-action="planification-activer" data-name="${escapeHtml(p.name)}">Activer</button>`}
        <button class="btn btn-danger" data-action="planification-supprimer" data-name="${escapeHtml(p.name)}">Supprimer</button>
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

      switch (action) {
        case 'macro-supprimer': socket.emit('planificateur:macro:supprimer', { name }); break;
        case 'planification-activer': socket.emit('planificateur:planification:activer', { name }); break;
        case 'planification-desactiver': socket.emit('planificateur:planification:desactiver', { name }); break;
        case 'planification-supprimer': socket.emit('planificateur:planification:supprimer', { name }); break;
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
