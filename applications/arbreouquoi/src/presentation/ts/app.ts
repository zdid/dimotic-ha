/**
 * ArbreOuquoi Application - Client Socket.io
 * Visualisation du référentiel HA organisé par OÙ → QUOI → Entités
 * Ou par QUOI → OÙ → Entités (selon le mode)
 * Derniere modification: 2026-07-20 11:00:00 - Mise à jour pour les deux modes d'affichage
 */

import { ARBREOUQUOI_SOCKET_EVENTS } from './socket-events';
import { TreeNode, TreeNodeData } from './tree-node';

// Types pour le client
interface HaArea { area_id: string; name: string; picture?: string; }
interface HaDevice { id: string; name: string; }
// quoi_id/label, pas id/name/icon : forme réelle de HaQuoiDefinition (core) — icon n'existe pas
// côté serveur, toujours calculée côté client via getQuoiIcon(quoi_id).
interface HaQuoiDefinition { quoi_id: string; label: string; description?: string; }
interface HaStructuredEntity {
  entity_id: string;
  domain: string;
  device_class?: string;
  state?: string;
  attributes?: Record<string, unknown>;
  area?: HaArea;
  device?: HaDevice;
  quoi_ids: string[];
}

// Types pour OÙ-first
interface OuNode {
  id: string;
  name: string;
  level: 'grand_pere' | 'pere' | 'lieu' | 'lieu_precis';
  children: OuNode[];
  entities: HaStructuredEntity[];
  entityCount: number;
  parentId: string | null;
}

interface OuWithQuoiNode {
  ou: OuNode;
  children: QuoiGroup[];
  entityCount: number;
}

interface OuFirstTree {
  levels: OuWithQuoiNode[];
  unassigned: EntityInfo[];
  totalEntities: number;
  totalOuNodes: number;
  totalQuoiTypes: number;
}

// Types pour QUOI-first
interface QuiGroupWithOu {
  quoi: HaQuoiDefinition;
  entityCount: number;
  ouHierarchy: OuNode[];
  entitiesByOu: Record<string, HaStructuredEntity[]>;
}

interface QuoiFirstTree {
  quoiGroups: QuiGroupWithOu[];
  unassigned: EntityInfo[];
  totalEntities: number;
  totalQuoiTypes: number;
  totalOuNodes: number;
}

interface QuoiGroup {
  quoi: HaQuoiDefinition;
  entities: HaStructuredEntity[];
  count: number;
}

interface EntityInfo {
  entity: HaStructuredEntity;
  ouPath: string[];
  quoiIds: string[];
  device: HaDevice | null;
  area: HaArea | null;
}

interface QuoiCatalogWithCounts {
  quoi: HaQuoiDefinition;
  entityCount: number;
  ouPaths: string[];
}

// État global
let state = {
  tree: null as (OuFirstTree | QuoiFirstTree) | null,
  viewMode: 'ou-first' as 'ou-first' | 'quoi-first',
  catalog: [] as QuoiCatalogWithCounts[],
  isConnected: false,
  isLoading: true,
  error: null as string | null,
  filters: { showOnlyActive: true },
  displayConfig: {
    expandAll: false,
    showQuoiIcons: true
  }
};

// Connexion Socket.io unique, réutilisée depuis le core (window.app.socketService) au lieu
// d'en ouvrir une seconde — chaque app qui ouvrait sa propre connexion alimentait un bug de
// ModuleContainer (rejeu des événements persistants à chaque nouvelle connexion, cf TODO.md).
// window.app est garanti déjà initialisé : ce script n'est injecté qu'après un clic utilisateur
// dans la sidebar, bien après l'exécution du script principal du core au chargement de la page.
const socket = window.app.socketService;

// Rafraîchissement auto côté client uniquement (champ "auto-refresh-seconds" de la barre
// d'outils) — jamais persisté en config, purement local à cet onglet/cette session. 0 (défaut)
// = désactivé, seul le bouton "Rafraîchir" (ou un vrai changement HA via refreshOnHaUpdate côté
// serveur) déclenche alors une mise à jour.
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

function triggerRefresh(): void {
  socket.emit(ARBREOUQUOI_SOCKET_EVENTS.REFRESH);
  showLoading();
}

function setAutoRefresh(seconds: number): void {
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (seconds > 0) {
    autoRefreshTimer = setInterval(triggerRefresh, seconds * 1000);
  }
}

// Ce script est injecté par ModuleContainer.ts (core) bien après le chargement initial de la
// page — au clic sur l'onglet, pas au chargement du document — donc `document.readyState` est
// déjà 'complete' à ce moment-là : `document.addEventListener('DOMContentLoaded', ...)` seul ne
// se déclencherait jamais (l'événement a déjà eu lieu). Même pattern que
// nommage/config-app.ts.
//
// Par ailleurs, ModuleContainer encapsule tout le contenu injecté dans un Shadow DOM — le
// `document` global ne le traverse pas, `$(...)` y renverrait toujours
// `null`. ModuleContainer.ts expose son shadow root sur `window.__moduleContainerRoot` (voir
// connectedCallback()) ; `$()` ci-dessous interroge cette racine si elle existe, sinon
// `document` (utile en dehors de ce pipeline, ex: tests).
function moduleRoot(): ParentNode {
  return (window as any).__moduleContainerRoot || document;
}

function $(id: string): HTMLElement | null {
  return moduleRoot().querySelector(`#${id}`);
}

function initApp(): void {
  initEventListeners();
  initUI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function initEventListeners(): void {
  const handleConnected = () => {
    state.isConnected = true;
    state.isLoading = true;
    updateConnectionStatus('connected');
    showLoading();
    hideError();
    socket.emit(ARBREOUQUOI_SOCKET_EVENTS.TREE_GET);
    socket.emit(ARBREOUQUOI_SOCKET_EVENTS.CATALOG_GET);
  };

  socket.on('connect', handleConnected);
  // La connexion partagée est déjà établie par le core au moment où ce script s'exécute — un
  // 'connect' ne se redéclenchera qu'en cas de vraie reconnexion réseau. Il faut donc déclencher
  // nous-même la demande initiale de données.
  if (socket.isConnected()) {
    handleConnected();
  }

  socket.on('disconnect', () => {
    state.isConnected = false;
    updateConnectionStatus('disconnected');
    showError('Déconnecté. Reconnexion en cours...');
  });

  socket.on(ARBREOUQUOI_SOCKET_EVENTS.TREE_STRUCTURE, (payload: {
    tree: OuFirstTree | QuoiFirstTree;
    viewMode: 'ou-first' | 'quoi-first';
    catalog: QuoiCatalogWithCounts[];
    timestamp: string;
  }) => {
    state.tree = payload.tree;
    state.viewMode = payload.viewMode;
    state.catalog = payload.catalog;
    state.isLoading = false;
    state.error = null;
    updateLastUpdate(payload.timestamp);
    renderTree();
    renderQuoiCatalog();
    updateStats();
    updateViewModeButton();
    hideLoading();
    hideError();
  });

  socket.on(ARBREOUQUOI_SOCKET_EVENTS.QUOI_CATALOG, (catalog: QuoiCatalogWithCounts[]) => {
    state.catalog = catalog;
    renderQuoiCatalog();
  });

  socket.on(ARBREOUQUOI_SOCKET_EVENTS.STATS, (stats: {
    totalEntities: number;
    totalOuPaths: number;
    unassignedEntities: number;
    timestamp: string;
  }) => {
    // Même remarque que dans updateStats() : $() peut renvoyer null si un autre module est
    // maintenant affiché pendant qu'un événement pour celui-ci arrive encore en arrière-plan.
    const totalEntitiesEl = $('total-entities');
    if (totalEntitiesEl) totalEntitiesEl.textContent = stats.totalEntities.toString();
    const totalOuPathsEl = $('total-ou-paths');
    if (totalOuPathsEl) totalOuPathsEl.textContent = stats.totalOuPaths.toString();
    const unassignedEntitiesEl = $('unassigned-entities');
    if (unassignedEntitiesEl) unassignedEntitiesEl.textContent = stats.unassignedEntities.toString();
  });

  socket.on(ARBREOUQUOI_SOCKET_EVENTS.STATUS, (status: { status: string; message: string; timestamp: string }) => {
    updateConnectionStatus(status.status);
    if (status.status === 'error') showError(status.message);
  });

  socket.on(ARBREOUQUOI_SOCKET_EVENTS.ERROR, (error: { message: string }) => {
    showError(error.message);
  });

  socket.on(ARBREOUQUOI_SOCKET_EVENTS.ENTITY_DETAILS, (payload: {
    entity: HaStructuredEntity;
    ouPath: Array<{ name: string; level: 'grand_pere' | 'pere' | 'lieu' | 'lieu_precis' }>;
    area: HaArea | null;
    device: HaDevice | null;
    quiIds: string[];
    relatedEntities: EntityInfo[];
  }) => {
    renderEntityDetails(payload);
  });

  // Événements UI
  $('refresh-btn')?.addEventListener('click', () => {
    triggerRefresh();
  });

  $('auto-refresh-seconds')?.addEventListener('change', (e) => {
    const seconds = Number((e.target as HTMLInputElement).value) || 0;
    setAutoRefresh(seconds);
  });

  $('filter-active-only')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    state.filters.showOnlyActive = checked;
    socket.emit(ARBREOUQUOI_SOCKET_EVENTS.FILTER_SET, { showOnlyActive: checked });
  });

  $('expand-all-btn')?.addEventListener('click', () => {
    state.displayConfig.expandAll = true;
    renderTree();
  });

  $('collapse-all-btn')?.addEventListener('click', () => {
    state.displayConfig.expandAll = false;
    renderTree();
  });

  // Toggle mode OÙ-first / QUOI-first
  $('toggle-view-mode-btn')?.addEventListener('click', () => {
    const newMode = state.viewMode === 'ou-first' ? 'quoi-first' : 'ou-first';
    state.viewMode = newMode;
    updateViewModeButton();
    socket.emit(ARBREOUQUOI_SOCKET_EVENTS.CONFIG_SAVE, {
      display: { viewMode: newMode }
    });
    showLoading();
  });

  $('search-btn')?.addEventListener('click', () => {
    const query = ($('search-input') as HTMLInputElement)?.value || '';
    if (query.trim()) {
      socket.emit(ARBREOUQUOI_SOCKET_EVENTS.SEARCH, query);
      showLoading();
    }
  });

  $('search-input')?.addEventListener('keypress', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const query = (e.target as HTMLInputElement).value;
      if (query.trim()) {
        socket.emit(ARBREOUQUOI_SOCKET_EVENTS.SEARCH, query);
        showLoading();
      }
    }
  });

  $('close-details-btn')?.addEventListener('click', () => {
    hideDetailsPanel();
  });
}

function initUI(): void {
  hideLoading();
  hideError();
  hideDetailsPanel();
  updateConnectionStatus('connecting');
  updateViewModeButton();
}

function updateViewModeButton(): void {
  const btn = $('toggle-view-mode-btn') as HTMLButtonElement;
  if (btn) {
    btn.textContent = state.viewMode === 'ou-first'
      ? '🔀 Passer en mode QUOI → OÙ'
      : '🔀 Passer en mode OÙ → QUOI';
  }
}

function updateConnectionStatus(status: string): void {
  const statusItem = $('connection-status');
  const indicator = statusItem?.querySelector('.status-indicator');
  const text = statusItem?.querySelector('.status-text');
  if (!statusItem || !indicator || !text) return;
  
  const statuses: Record<string, { class: string; text: string }> = {
    connected: { class: 'connected', text: 'Connecté' },
    disconnected: { class: 'disconnected', text: 'Déconnecté' },
    connecting: { class: 'connecting', text: 'Connexion...' },
    error: { class: 'error', text: 'Erreur' }
  };
  const s = statuses[status] || statuses.connecting;
  indicator.className = `status-indicator ${s.class}`;
  text.textContent = s.text;
}

function updateLastUpdate(timestamp: string): void {
  const el = $('last-update');
  if (el) el.textContent = new Date(timestamp).toLocaleString('fr-FR');
}

function showLoading(): void {
  state.isLoading = true;
  $('loading-indicator')!.style.display = 'flex';
}

function hideLoading(): void {
  state.isLoading = false;
  $('loading-indicator')!.style.display = 'none';
}

function showError(message: string): void {
  state.error = message;
  // Pas de non-null assertion ici (contrairement à showLoading/hideLoading) : contrairement à
  // ces deux-là, showError est aussi appelé depuis le handler socket.io 'disconnect', qui peut se
  // déclencher après que le DOM du module ait déjà été démonté (ex: page entrée en bfcache lors
  // d'une navigation) — $() renvoie alors null, une assertion aurait fait planter le handler.
  const errorEl = $('error-message');
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.style.display = 'block';
  setTimeout(() => { if (state.error === message) hideError(); }, 5000);
}

function hideError(): void {
  state.error = null;
  const errorEl = $('error-message');
  if (errorEl) errorEl.style.display = 'none';
}

function renderTree(): void {
  const treeEl = $('tree');
  if (!treeEl || !state.tree) return;

  const nodes = state.viewMode === 'ou-first'
    ? normalizeOuFirstTree(state.tree as OuFirstTree, state.displayConfig.expandAll)
    : normalizeQuoiFirstTree(state.tree as QuoiFirstTree, state.displayConfig.expandAll);

  treeEl.innerHTML = '';
  nodes.forEach(n => {
    const el = document.createElement('tree-node') as TreeNode;
    treeEl.appendChild(el);
    el.setData(n);
  });
}

function toEntityInfo(e: HaStructuredEntity): EntityInfo {
  return { entity: e, ouPath: [], quoiIds: e.quoi_ids, device: e.device || null, area: e.area || null };
}

function unassignedNode(unassigned: EntityInfo[], expandAll: boolean): TreeNodeData | null {
  if (unassigned.length === 0) return null;
  return {
    id: 'unassigned', kind: 'unassigned', label: `📦 Non assignés (${unassigned.length})`,
    icon: '', count: unassigned.length, children: [], entities: unassigned, defaultOpen: expandAll
  };
}

function normalizeOuFirstTree(tree: OuFirstTree, expandAll: boolean): TreeNodeData[] {
  const result: TreeNodeData[] = [];
  const unassigned = unassignedNode(tree.unassigned, expandAll);
  if (unassigned) result.push(unassigned);

  const allQuoiIds = tree.levels.flatMap(l => l.children).flatMap(g => g.quoi);

  const normalizeOuWithQuoi = (node: OuWithQuoiNode): TreeNodeData => {
    const quoiChildren: TreeNodeData[] = node.children.map(qg => ({
      id: `quoi-${node.ou.id}-${qg.quoi.quoi_id}`, kind: 'quoi', label: escapeHtml(qg.quoi.label),
      icon: getQuoiIcon(qg.quoi.quoi_id), count: qg.count,
      children: [], entities: qg.entities.map(toEntityInfo), defaultOpen: expandAll
    }));
    const ouChildren: TreeNodeData[] = node.ou.children.map(child => {
      const childQuoiGroups = groupEntitiesByQuoi(child.entities, allQuoiIds);
      return normalizeOuWithQuoi({ ou: child, children: childQuoiGroups, entityCount: child.entityCount });
    });
    return {
      id: node.ou.id, kind: 'ou', label: escapeHtml(node.ou.name), icon: getOuIcon(node.ou.level),
      badge: `[${node.ou.level}]`, levelClass: `ou-level-${node.ou.level}`,
      count: node.entityCount, children: [...quoiChildren, ...ouChildren], entities: [], defaultOpen: expandAll
    };
  };

  for (const levelNode of tree.levels) result.push(normalizeOuWithQuoi(levelNode));
  return result;
}

function normalizeQuoiFirstTree(tree: QuoiFirstTree, expandAll: boolean): TreeNodeData[] {
  const result: TreeNodeData[] = [];
  const unassigned = unassignedNode(tree.unassigned, expandAll);
  if (unassigned) result.push(unassigned);

  const normalizeOuNodeForQuoi = (node: OuNode, entities: HaStructuredEntity[], group: QuiGroupWithOu): TreeNodeData => {
    const children = node.children.map(child => {
      const childEntities = group.entitiesByOu[child.id] || [];
      return normalizeOuNodeForQuoi(child, childEntities, group);
    });
    return {
      id: node.id, kind: 'ou', label: escapeHtml(node.name), icon: getOuIcon(node.level),
      badge: `[${node.level}]`, levelClass: `ou-level-${node.level}`,
      count: entities.length + node.children.reduce((sum, c) => sum + c.entityCount, 0),
      children, entities: entities.map(toEntityInfo), defaultOpen: expandAll
    };
  };

  for (const group of tree.quoiGroups) {
    const ouChildren: TreeNodeData[] = [];
    for (const ouNode of group.ouHierarchy) {
      const entities = group.entitiesByOu[ouNode.id] || [];
      if (entities.length === 0) continue;
      ouChildren.push(normalizeOuNodeForQuoi(ouNode, entities, group));
    }
    result.push({
      id: group.quoi.quoi_id, kind: 'quoi', label: escapeHtml(group.quoi.label),
      icon: getQuoiIcon(group.quoi.quoi_id), count: group.entityCount,
      children: ouChildren, entities: [], defaultOpen: expandAll
    });
  }
  return result;
}

// Helper pour regrouper les entités par QUOI
function groupEntitiesByQuoi(entities: HaStructuredEntity[], allQuoiIds: HaQuoiDefinition[]): QuoiGroup[] {
  const map = new Map<string, HaStructuredEntity[]>();
  for (const entity of entities) {
    for (const qi of entity.quoi_ids) {
      if (!map.has(qi)) map.set(qi, []);
      map.get(qi)!.push(entity);
    }
  }
  return Array.from(map.entries()).map(([qi, es]) => ({
    quoi: allQuoiIds.find(q => q.quoi_id === qi) || { quoi_id: qi, label: qi },
    entities: es,
    count: es.length
  })).sort((a, b) => b.count - a.count);
}

function renderEntity(entityInfo: EntityInfo): string {
  const entity = entityInfo.entity;
  const quoiIcons = entity.quoi_ids.map(id => getQuoiIcon(id)).join('');
  
  const domain = entity.domain || 'unknown';
  const stateValue = entity.state || 'N/A';
  const areaName = entityInfo.ouPath.length > 0 ? entityInfo.ouPath[entityInfo.ouPath.length - 1] : (entity.area?.name || 'N/A');
  
  return `
    <div class="entity-item"
         x-data="{ hover: false }"
         :class="{ highlight: hover }"
         @mouseenter="hover = true"
         @mouseleave="hover = false"
         @click="window.arbreouquoiShowDetails('${entity.entity_id}')">
      <span class="entity-icon">${quoiIcons}</span>
      <span class="entity-domain ${domain}">${domain}</span>
      <span class="entity-name">${escapeHtml(entity.attributes?.friendly_name as string || entity.entity_id)}</span>
      <span class="entity-state">${stateValue}</span>
      ${entity.device?.name ? `<span class="entity-device">[${entity.device.name}]</span>` : ''}
      ${areaName !== 'N/A' ? `<span class="entity-area">@${areaName}</span>` : ''}
    </div>
  `;
}

TreeNode.entityRenderer = (info: unknown) => renderEntity(info as EntityInfo);

function renderQuoiCatalog(): void {
  const el = $('quoi-catalog');
  if (!el) return;
  
  const html = `
    <h4>Légende QUOI (${state.catalog.length} types)</h4>
    <div class="quoi-icons">
      ${state.catalog.map(item => {
        const icon = getQuoiIcon(item.quoi.quoi_id);
        // Icône ❓ = pas d'entrée dans getQuoiIcon() : l'icône seule ne dit pas de quel quoi il
        // s'agit, contrairement aux autres — on affiche donc le nom à côté dans ce cas précis
        // (demande utilisateur, 08/08/2026), pour ne pas alourdir la légende quand l'icône
        // suffit déjà.
        const unknown = icon === '❓';
        return `
        <div class="quoi-catalog-item" title="${item.quoi.label} (${item.entityCount} entités)">
          <span class="quoi-catalog-icon">${icon}</span>
          ${unknown ? `<span class="quoi-catalog-name">${escapeHtml(item.quoi.label)}</span>` : ''}
          <span class="quoi-catalog-count">${item.entityCount}</span>
        </div>
      `;
      }).join('')}
    </div>
  `;
  el.innerHTML = html;
}

function updateStats(): void {
  if (!state.tree) return;
  const tree = state.tree;
  // $() peut renvoyer null si ce module n'est plus l'onglet affiché (le contenu de
  // ModuleContainer a été remplacé par un autre module) alors qu'un événement socket pour CE
  // module arrive encore en arrière-plan — pas une erreur, juste une mise à jour à ignorer.
  const totalEntitiesEl = $('total-entities');
  if (totalEntitiesEl) totalEntitiesEl.textContent = tree.totalEntities.toString();
  if ('totalOuNodes' in tree) {
    const totalOuPathsEl = $('total-ou-paths');
    if (totalOuPathsEl) totalOuPathsEl.textContent = (tree as OuFirstTree | QuoiFirstTree).totalOuNodes.toString();
  }
  const totalQuoiTypesEl = $('total-qui-types');
  if (totalQuoiTypesEl) totalQuoiTypesEl.textContent = tree.totalQuoiTypes.toString();
  const unassignedEntitiesEl = $('unassigned-entities');
  if (unassignedEntitiesEl) unassignedEntitiesEl.textContent = tree.unassigned.length.toString();
}

function showEntityDetails(entityId: string): void {
  socket.emit(ARBREOUQUOI_SOCKET_EVENTS.ENTITY_GET, entityId);
  const panel = $('details-panel')!;
  panel.style.display = 'block';
  $('details-content')!.innerHTML = '<div class="loading-small"><div class="spinner-small"></div><p>Chargement...</p></div>';
}

function renderEntityDetails(payload: {
  entity: HaStructuredEntity;
  ouPath: Array<{ name: string; level: 'grand_pere' | 'pere' | 'lieu' | 'lieu_precis' }>;
  area: HaArea | null;
  device: HaDevice | null;
  quiIds: string[];
  relatedEntities: EntityInfo[];
}): void {
  const contentEl = $('details-content');
  if (!contentEl) return;
  
  const e = payload.entity;
  let html = `
    <div class="details-header">
      <h2>${escapeHtml(e.attributes?.friendly_name as string || e.entity_id)}</h2>
      <div class="details-meta">
        <span class="meta-badge domain">${e.domain}</span>
        ${e.device_class ? `<span class="meta-badge device-class">${e.device_class}</span>` : ''}
        ${e.state ? `<span class="meta-badge state">État: ${e.state}</span>` : ''}
      </div>
    </div>
    
    <div class="details-section">
      <h3>📋 Informations de base</h3>
      <table class="details-table">
        <tr><td>ID Entité</td><td><code>${e.entity_id}</code></td></tr>
        <tr><td>Nom</td><td>${escapeHtml(e.attributes?.friendly_name as string || 'N/A')}</td></tr>
        <tr><td>Domaine</td><td>${e.domain}</td></tr>
        ${e.device_class ? `<tr><td>Classe Appareil</td><td>${e.device_class}</td></tr>` : ''}
        <tr><td>État</td><td>${e.state || 'N/A'}</td></tr>
      </table>
    </div>
  `;
  
  if (payload.ouPath.length > 0) {
    html += `
      <div class="details-section">
        <h3>📍 Hiérarchie OÙ</h3>
        <div class="ou-path-display">
          ${payload.ouPath.map(({ name, level }) => {
            return `<span class="ou-path-item"><span class="ou-path-icon">${getOuIcon(level)}</span> ${escapeHtml(name)} <span class="ou-path-level">[${level}]</span></span>`;
          }).join(' → ')}
        </div>
      </div>
    `;
  }
  
  if (payload.area) {
    html += `
      <div class="details-section">
        <h3>🏠 Area HA</h3>
        <table class="details-table">
          <tr><td>Nom</td><td>${payload.area.name}</td></tr>
          <tr><td>ID</td><td><code>${payload.area.area_id}</code></td></tr>
        </table>
      </div>
    `;
  }
  
  if (payload.device) {
    html += `
      <div class="details-section">
        <h3>📱 Appareil</h3>
        <table class="details-table">
          <tr><td>Nom</td><td>${payload.device.name}</td></tr>
          <tr><td>ID</td><td><code>${payload.device.id}</code></td></tr>
        </table>
      </div>
    `;
  }
  
  if (payload.quiIds.length > 0) {
    html += `
      <div class="details-section">
        <h3>🏷️ Classification QUOI</h3>
        <div class="quoi-tags">
          ${payload.quiIds.map(qi => {
            const q = state.catalog.find(c => c.quoi.quoi_id === qi)?.quoi;
            const icon = getQuoiIcon(qi);
            return `<span class="quoi-tag">${icon} ${q?.label || qi}</span>`;
          }).join('')}
        </div>
      </div>
    `;
  }
  
  if (payload.relatedEntities.length > 0) {
    html += `
      <div class="details-section">
        <h3>🔗 Entités associées (${payload.relatedEntities.length})</h3>
        <div class="related-entities">
          ${payload.relatedEntities.slice(0, 10).map(re => `
            <div class="related-entity" onclick="window.arbreouquoiShowDetails('${re.entity.entity_id}')">
              <span class="related-entity-name">${escapeHtml(re.entity.attributes?.friendly_name as string || re.entity.entity_id)}</span>
              <span class="related-entity-id">${re.entity.entity_id}</span>
            </div>
          `).join('')}
          ${payload.relatedEntities.length > 10 ? `<p class="related-more">+ ${payload.relatedEntities.length - 10} autres...</p>` : ''}
        </div>
      </div>
    `;
  }
  
  if (e.attributes) {
    html += `
      <div class="details-section">
        <h3>📊 Attributs</h3>
        <table class="details-table">
          ${Object.entries(e.attributes).map(([key, value]) => {
            if (key === 'friendly_name') return '';
            if (key === 'attributs_taxonomie') return ''; // Masquer la taxonomie (déjà affichée)
            return `<tr><td>${key}</td><td><pre>${JSON.stringify(value, null, 2)}</pre></td></tr>`;
          }).join('')}
        </table>
      </div>
    `;
  }
  
  contentEl.innerHTML = html;
}

function hideDetailsPanel(): void {
  $('details-panel')!.style.display = 'none';
}

function getOuIcon(level: string): string {
  const icons: Record<string, string> = {
    grand_pere: '🏠',
    pere: '🏢',
    lieu: '📍',
    lieu_precis: '🎯'
  };
  return icons[level] || '📁';
}

function getQuoiIcon(quoiId: string): string {
  const icons: Record<string, string> = {
    lumiere: '💡', temperature: '🌡️', humidite: '💧', interrupteur: '🔘',
    prise: '🔌', volet: '🪟', porte: '🚪', fenetre: '🪟',
    detecteur: '👁️', mouvement: '🏃', fumee: '💨', gaz: '⛽', eau: '💦',
    sonnette: '🔔', camera: '📹', alarme: '🚨', climatisation: '❄️', chauffage: '🔥',
    // Complété le 08/08/2026 — la liste d'origine ne couvrait qu'une petite partie du
    // vocabulaire QUOI réellement utilisé (repli sur ❓ pour la plupart des entités).
    thermostat: '🎛️', radiateur: '♨️', poele: '🔥', four: '🍞', plaques: '🍳',
    compteur: '🔢', barometre: '📊', pression: '📊',
    machine_a_laver: '🧺', lave_vaisselle: '🍽️',
    bouton: '🔲', telecommande: '🎮', infrarouge: '📡',
    scene: '🎬', scenes: '🎬', scenes_switch: '🎬',
    ventilateur: '🌀', vmc: '🌀', store: '🪟', rideau: '🪟', rideaux: '🪟',
    serrure: '🔒', portail: '🚧', arrosage: '🚿', aspirateur: '🧹',
    media: '📺', tele: '📺', television: '📺', chaudiere: '🔥',
    pompe_a_chaleur: '♨️', batterie: '🔋', pression_eau: '💦'
  };
  return icons[quoiId.toLowerCase()] || '❓';
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Pont global minimal restant : ouvrir le panneau de détails déclenche un socket.emit +
// un état asynchrone (réponse serveur), pas un simple état réactif local — pas remplacé par
// une directive Alpine pure. toggleSection/highlightEntity/unhighlightEntity ont disparu,
// remplacés par x-data/x-show/@click/@mouseenter/@mouseleave dans TreeNode (tree-node.ts)
// et renderEntity() ci-dessus.
(window as any).arbreouquoiShowDetails = showEntityDetails;
