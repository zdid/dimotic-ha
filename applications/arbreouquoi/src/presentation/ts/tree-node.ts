/**
 * Composant récursif <tree-node> pour l'arbre OÙ/QUOI.
 * Chaque instance a son propre Shadow DOM (comme ModuleContainer.ts du core) et initialise
 * Alpine manuellement (Alpine.initTree) — le scan d'Alpine ne traverse jamais une frontière
 * Shadow DOM (alpinejs-implementation_specs_v1.0.md §3.4). Les enfants sont d'autres instances
 * de <tree-node>, créées par la même classe : la récursion vient de la composition de Web
 * Components, Alpine n'a pas de primitive de composant récursif dédiée (§3.5) — pattern validé
 * dans la démonstration interactive de la session précédente.
 */

export interface TreeNodeData {
  id: string;
  kind: 'ou' | 'quoi' | 'unassigned';
  label: string;
  icon: string;
  badge?: string;
  levelClass?: string;
  count: number;
  children: TreeNodeData[];
  // Entités feuilles à afficher directement sous ce nœud — forme opaque pour ce composant,
  // rendue par TreeNode.entityRenderer, injecté par app.ts (seul à connaître state.catalog/
  // displayConfig nécessaires au rendu réel d'une entité).
  entities: unknown[];
  defaultOpen: boolean;
}

export class TreeNode extends HTMLElement {
  static entityRenderer: (info: unknown) => string = () => '';

  /** Nœuds ouverts / fermés par l'utilisateur, par chemin complet : l'arbre est reconstruit à chaque envoi du serveur
   *  (changement d'état dans HA, au plus toutes les 5 s) — sans cette mémoire, tout se repliait tout seul. Remis à zéro
   *  quand l'utilisateur change de vue, de recherche ou clique « tout déplier / replier ». */
  static readonly openState = new Map<string, boolean>();

  private node: TreeNodeData | null = null;
  private key = '';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  setData(node: TreeNodeData, parentKey = ''): void {
    this.node = node;
    this.key = `${parentKey}/${node.kind}:${node.id}`;
    this.render();
  }

  private render(): void {
    const node = this.node;
    if (!node || !this.shadowRoot) return;

    const hasContent = node.children.length > 0 || node.entities.length > 0;
    const entitiesHtml = node.entities.map(e => TreeNode.entityRenderer(e)).join('');

    let outerClass: string;
    let headerClass: string;
    let contentClass: string;
    let nameSpan: string;
    let countSpan: string;

    if (node.kind === 'ou') {
      outerClass = `ou-section ${node.levelClass || ''}`;
      headerClass = 'ou-header';
      contentClass = 'ou-content';
      nameSpan = `<span class="ou-icon">${node.icon}</span><span class="ou-name">${node.label}</span><span class="ou-level-badge">${node.badge || ''}</span>`;
      countSpan = `<span class="entity-count">(${node.count})</span>`;
    } else if (node.kind === 'quoi') {
      outerClass = 'quoi-group';
      headerClass = 'quoi-header';
      contentClass = 'quoi-entities';
      nameSpan = `<span class="quoi-icon">${node.icon}</span><span class="quoi-name">${node.label}</span>`;
      countSpan = `<span class="quoi-count">(${node.count})</span>`;
    } else {
      outerClass = 'tree-section unassigned-section';
      headerClass = 'section-header';
      contentClass = 'section-content';
      nameSpan = `<span class="section-title">${node.label}</span>`;
      countSpan = '';
    }

    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="/applications/arbreouquoi/presentation/styles/arbreouquoi.css">
      <div class="${outerClass}" data-key="${this.key.replace(/"/g, '&quot;')}" x-data="{ open: ${(TreeNode.openState.get(this.key) ?? node.defaultOpen) ? 'true' : 'false'} }">
        <div class="${headerClass}" ${hasContent ? '@click="open = !open; window.__arbreOuvert.set($el.parentElement.dataset.key, open)"' : ''}>
          <span class="toggle-icon" x-text="open ? '▼' : '▶'">▶</span>
          ${nameSpan}
          ${countSpan}
        </div>
        ${hasContent ? `<div class="${contentClass}" x-show="open">${entitiesHtml}<div class="tree-node-children"></div></div>` : ''}
      </div>
    `;

    window.Alpine?.initTree(this.shadowRoot);

    if (node.children.length > 0) {
      const childrenEl = this.shadowRoot.querySelector('.tree-node-children');
      node.children.forEach(childData => {
        const child = document.createElement('tree-node') as TreeNode; // récursion : même balise
        childrenEl?.appendChild(child);
        child.setData(childData, this.key);
      });
    }
  }
}

(window as unknown as { __arbreOuvert: Map<string, boolean> }).__arbreOuvert = TreeNode.openState; // lu par les expressions Alpine des nœuds
customElements.define('tree-node', TreeNode);
