/**
 * Bootstrap du tableau de bord HAPLAN — remplace App.ts/FloorplanManager.ts/MenuSystem.ts de
 * haplanserver par une orchestration minimale propre à ws-ha. Un seul FloorPlanContainer actif à
 * la fois (recréé au changement de plan), plutôt que le modèle multi-containers de l'original.
 *
 * Phase 2 (voir plan de portage) : sélecteur d'entité (taxonomie QUOI/OÙ, EntitySelector.ts porté
 * tel quel) + mode édition (glisser-déposer, déjà porté dans FloorPlanContainer/ObjectManager).
 * Phase 3 : création (upload REST, voir DataService.uploadFloorplan) et suppression de plan.
 */

import { DataService } from './services/DataService';
import { FloorPlanContainer } from './components/FloorPlanContainer';
import { EntitySelector } from './components/EntitySelector';

const dataService = new DataService();
let currentContainer: FloorPlanContainer | null = null;
let editMode = false;
// File d'attente : deux appels à showFloorplan() qui se chevauchent (ex: reconnexion Socket.io qui
// rejoue l'événement persistant haplan:floorplans:list pendant qu'un ajout d'entité vient d'en
// déclencher un nouveau) ne doivent jamais s'exécuter en parallèle. cleanup() vide entièrement
// #floorplan-container (this.container.innerHTML = '') : si un appel périmé l'exécute après qu'un
// appel plus récent y a déjà reconstruit son propre contenu, il efface ce contenu sous ses pieds —
// d'où la boucle de retry DOM observée dans EnhancedLightObject. Un simple jeton ne suffit pas
// (l'appel périmé doit quand même nettoyer), donc chaque appel attend la fin complet du précédent.
let showFloorplanQueue: Promise<void> = Promise.resolve();

const entitySelectorContainer = document.getElementById('entity-selector-container') as HTMLElement;
const entitySelector = new EntitySelector(entitySelectorContainer, (entity_id: string) => {
  addEntityToCurrentFloorplan(entity_id);
});

function populateFloorplanSelect(): void {
  const select = document.getElementById('floorplan-select') as HTMLSelectElement | null;
  if (!select) return;

  const floorplans = dataService.getAllFloorplans();
  const currentId = dataService.getCurrentFloorplanId();

  select.innerHTML = '';
  const ids = Object.keys(floorplans);
  if (ids.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'Aucun plan';
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  for (const id of ids) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = id;
    if (id === currentId) option.selected = true;
    select.appendChild(option);
  }

  select.addEventListener('change', () => showFloorplan(select.value));
}

function showFloorplan(floorplanId: string): Promise<void> {
  showFloorplanQueue = showFloorplanQueue.then(() => showFloorplanNow(floorplanId));
  return showFloorplanQueue;
}

async function showFloorplanNow(floorplanId: string): Promise<void> {
  const container = document.getElementById('floorplan-container');
  if (!container) return;

  dataService.setCurrentFloorplanId(floorplanId);

  if (currentContainer) {
    currentContainer.cleanup();
    currentContainer = null;
  }

  if (!floorplanId) {
    container.innerHTML = '<div class="haplan-empty">Aucun plan disponible</div>';
    return;
  }

  currentContainer = new FloorPlanContainer(container, dataService as any);
  await currentContainer.initialize();
  if (editMode) await currentContainer.enableEditMode();
  currentContainer.updateEntitySelector(entitySelector as any);
}

function addEntityToCurrentFloorplan(entity_id: string): void {
  if (!currentContainer) return;
  const state = dataService.getState(entity_id) ?? { state: 'unknown', attributes: {} };
  currentContainer.createObjectFromConfig({ entity_id, position: { x: 0.5, y: 0.5 }, state });
  currentContainer.updateEntitySelector(entitySelector as any);
}

function setupEditModeToggle(): void {
  const btn = document.getElementById('btn-edit-mode') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    editMode = !editMode;
    btn.classList.toggle('active', editMode);
    if (!currentContainer) return;
    if (editMode) await currentContainer.enableEditMode();
    else await currentContainer.disableEditMode();
  });
}

function setupEntityPickerToggle(): void {
  const btn = document.getElementById('btn-add-entity') as HTMLButtonElement | null;
  const panel = document.getElementById('entity-picker-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    panel.classList.toggle('active');
  });
}

function setupNewFloorplanPanel(): void {
  const btn = document.getElementById('btn-new-floorplan') as HTMLButtonElement | null;
  const panel = document.getElementById('new-floorplan-panel');
  const form = document.getElementById('new-floorplan-form') as HTMLFormElement | null;
  const nameInput = document.getElementById('new-floorplan-name') as HTMLInputElement | null;
  const fileInput = document.getElementById('new-floorplan-file') as HTMLInputElement | null;
  if (!btn || !panel || !form || !nameInput || !fileInput) return;

  btn.addEventListener('click', () => panel.classList.toggle('active'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files?.[0];
    if (!file || !nameInput.value.trim()) return;

    try {
      await dataService.uploadFloorplan(file, nameInput.value.trim());
      form.reset();
      panel.classList.remove('active');
    } catch (error) {
      console.error('[dashboard-app] Échec de création du plan:', error);
      alert(error instanceof Error ? error.message : 'Échec de création du plan');
    }
  });
}

function setupDeleteFloorplanButton(): void {
  const btn = document.getElementById('btn-delete-floorplan') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const floorplanId = dataService.getCurrentFloorplanId();
    if (!floorplanId) return;
    if (!confirm(`Supprimer le plan "${floorplanId}" ? Cette action est irréversible.`)) return;
    await dataService.deleteFloorplan(floorplanId);
  });
}

function updateConnectionStatus(): void {
  const status = document.getElementById('haplan-connection-status');
  if (status) {
    status.textContent = dataService.isConnected() ? '🟢 Connecté' : '🔴 Déconnecté';
  }
}

dataService.onTaxonomyTree((areas) => entitySelector.setData(areas));

dataService.onFloorplansReady(async () => {
  // Le plan actuellement affiché a pu être supprimé entre-temps (Phase 3) — retomber sur le
  // premier plan disponible plutôt que d'essayer de recharger un plan qui n'existe plus.
  let currentId = dataService.getCurrentFloorplanId();
  if (!currentId || !dataService.getFloorplan(currentId)) {
    currentId = Object.keys(dataService.getAllFloorplans())[0] ?? '';
    dataService.setCurrentFloorplanId(currentId);
  }

  populateFloorplanSelect();
  await showFloorplan(currentId);
  updateConnectionStatus();
});

setupEditModeToggle();
setupEntityPickerToggle();
setupNewFloorplanPanel();
setupDeleteFloorplanButton();
setInterval(updateConnectionStatus, 3000);
