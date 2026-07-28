/**
 * Script TypeScript pour la page de configuration EVOO7 (Données).
 *
 * Le paramétrage (connexion broker, bridge HA, commande globale) vit uniquement dans
 * "Paramètres Techniques → EVOO7" (formulaire générique du core) — plus de doublon ici, voir
 * TODO.md "EVOO7 : formulaire générique et page dédiée éditent les mêmes champs".
 */

// SocketService : URL réellement servie par le socle (core la compile déjà en JS navigateur
// et l'expose via son middleware /js/ts) — pas un chemin de fichier TypeScript, un import
// d'exécution résolu par le navigateur lui-même. Voir presentation/tsconfig.ui.json.
import { SocketService } from '/js/ts/services/SocketService.js';

// ============================================================================
// Types (miroir simplifié de domain/types.ts, pour l'UI uniquement)
// ============================================================================

interface Evoo7ValeurPossible {
  code: string;
  libelle: string;
}

interface Evoo7DataDefinition {
  id: string;
  description: string;
  min?: number;
  max?: number;
  valeursPossibles?: Evoo7ValeurPossible[];
  updatable: boolean;
  isConfigData: boolean;
  consultation: boolean;
  miseAJour: boolean;
  topicSensor: string;
  formatMessageSensor: string;
  taxonomieQuoi?: string;
  taxonomieLieuPrecis?: string;
  taxonomieLieu?: string;
  taxonomiePere?: string;
  taxonomieGrandPere?: string;
  deviceClass?: string;
  unitOfMeasurement?: string;
  forcedComponent?: string;
  payloadOn?: string;
  payloadOff?: string;
}

interface Evoo7ThermostatConfig {
  enabled: boolean;
  allowCooling: boolean;
}

/** Classes HA courantes pour EVOO7 (chauffage) + unité par défaut associée (modifiable ensuite). */
const DEVICE_CLASS_UNITS: Record<string, string> = {
  '': '',
  temperature: '°C',
  humidity: '%',
  pressure: 'bar',
  power: 'W',
  energy: 'kWh'
};
const DEVICE_CLASS_LABELS: Record<string, string> = {
  '': '(aucune)',
  temperature: 'Température',
  humidity: 'Humidité',
  pressure: 'Pression',
  power: 'Puissance',
  energy: 'Énergie'
};

// ============================================================================
// État
// ============================================================================

let socket: any | null = null;
let donnees: Evoo7DataDefinition[] = [];
let thermostat: Evoo7ThermostatConfig = { enabled: false, allowCooling: false };

/**
 * Dernier lieu de taxonomie saisi (lieu précis/lieu/père/grand-père) — préremplit les données pas
 * encore taxonomisées pour accélérer la saisie en série (la plupart des données EVOO7 partagent
 * le même lieu physique). Le "quoi" n'est volontairement jamais prérempli : il doit rester propre
 * à chaque donnée.
 */
interface LastTaxonomyLieu {
  lieuPrecis: string;
  lieu: string;
  pere: string;
  grandPere: string;
}
let lastTaxonomyLieu: LastTaxonomyLieu | null = null;

// ============================================================================
// Initialisation
// ============================================================================

function init(): void {
  const socketService = new SocketService();
  socket = socketService.connect();

  setupSocketListeners();
  setupUiListeners();

  socket.emit('evoo7:donnees:list:get');

  hideLoading();
}

function setupSocketListeners(): void {
  socket.on('evoo7:donnees:list', (data: { donnees: Evoo7DataDefinition[]; thermostat: Evoo7ThermostatConfig }) => {
    donnees = data.donnees;
    thermostat = data.thermostat;
    renderThermostat();
    // Amorce le préremplissage depuis ce qui est déjà persisté (ex: rechargement de page après
    // une première donnée taxonomisée lors d'une session précédente) — seulement tant qu'aucune
    // saisie n'a encore eu lieu dans CETTE session (voir saveRow, qui prend le relais ensuite).
    if (!lastTaxonomyLieu) {
      const dejaTaxonomisee = donnees.find((d) => d.taxonomieLieu);
      if (dejaTaxonomisee) {
        lastTaxonomyLieu = {
          lieuPrecis: dejaTaxonomisee.taxonomieLieuPrecis || '',
          lieu: dejaTaxonomisee.taxonomieLieu || '',
          pere: dejaTaxonomisee.taxonomiePere || '',
          grandPere: dejaTaxonomisee.taxonomieGrandPere || ''
        };
      }
    }
    renderDonnees();
  });

  socket.on('evoo7:error', (error: { message: string }) => showAlert(error.message, 'error'));

  // Réponse honnête à evoo7:donnee:save — jamais un succès affiché avant confirmation réelle du
  // serveur (voir TODO.md, même défaut corrigé pour le formulaire générique de config).
  socket.on('evoo7:donnee:save:response', (response: { id: string; success: boolean; error?: string }) => {
    if (response.success) showAlert(`Donnée "${response.id}" mise à jour`, 'success');
    // En cas d'échec, evoo7:error a déjà affiché le message détaillé — pas de double alerte.
  });

  socket.on('evoo7:thermostat:save:response', (response: { success: boolean; error?: string }) => {
    if (response.success) showAlert('Thermostat mis à jour', 'success');
  });
}

// ============================================================================
// Écouteurs UI
// ============================================================================

function setupUiListeners(): void {
  // Cases Thermostat : hors du tableau (pas de data-id/tr), sauvegarde immédiate à la coche —
  // même pattern que RFXCOM (rfxcom:hardware-protocol:toggle), pas de bouton séparé.
  document.getElementById('thermostat-enabled')?.addEventListener('change', () => saveThermostat());
  document.getElementById('thermostat-allow-cooling')?.addEventListener('change', () => saveThermostat());

  // Délégation d'événements pour les éléments générés dynamiquement (table Données)
  document.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest('tr');
    const id = target.closest('[data-id]')?.getAttribute('data-id');
    if (!id || !row) return;

    // Coche Consultation/Mise à jour : ne sauvegarde plus immédiatement (un seul bouton par
    // ligne désormais, voir saveRow) — juste faire apparaître/disparaître les champs Taxonomie et
    // Classe HA sans attendre un aller-retour serveur, pour pouvoir tout saisir puis sauvegarder
    // en un clic sur une donnée qu'on vient de sélectionner.
    if (target.classList.contains('consultation-check') || target.classList.contains('miseajour-check')) {
      refreshEditableCells(row, id);
    }

    // Préremplit l'unité avec la valeur par défaut de la classe choisie — reste modifiable
    // ensuite (ex: pression en mbar plutôt que bar).
    if (target.classList.contains('device-class-select')) {
      const unitInput = row.querySelector('.device-class-unit') as HTMLInputElement | null;
      const selected = (target as HTMLSelectElement).value;
      if (unitInput) unitInput.value = DEVICE_CLASS_UNITS[selected] ?? '';
    }

    // Affiche/masque les champs Payload ON/OFF selon le type forcé choisi.
    if (target.classList.contains('forced-component-select')) {
      const payloads = row.querySelector('.binary-sensor-payloads') as HTMLElement | null;
      if (payloads) payloads.style.display = (target as HTMLSelectElement).value === 'binary_sensor' ? '' : 'none';
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest('[data-action]')?.getAttribute('data-action');
    const id = target.closest('[data-id]')?.getAttribute('data-id');
    if (action === 'save-row' && id) saveRow(id);
  });
}

// ============================================================================
// Données
// ============================================================================

/** Miroir client de classification.ts: une énumération n'est jamais commandable (voir Evoo7Service). */
function isCommandable(d: Evoo7DataDefinition): boolean {
  const hasEnum = !!d.valeursPossibles && d.valeursPossibles.length > 0;
  return d.updatable && !hasEnum;
}

function renderConstraints(d: Evoo7DataDefinition): string {
  if (d.min !== undefined || d.max !== undefined) {
    return `min: ${d.min ?? '--'} / max: ${d.max ?? '--'}`;
  }
  if (d.valeursPossibles && d.valeursPossibles.length > 0) {
    return d.valeursPossibles.map((v) => escapeHtml(v.libelle)).join(', ');
  }
  return '--';
}

/** Taxonomie/classe HA éditables seulement pour les données réellement publiées vers HA. */
function isPublished(d: Evoo7DataDefinition): boolean {
  return d.consultation || d.miseAJour;
}

function renderTaxonomyCell(d: Evoo7DataDefinition, published: boolean): string {
  if (!published) {
    return '<span class="constraints">Cocher Consultation/Mise à jour pour saisir la taxonomie</span>';
  }

  // Donnée pas encore taxonomisée individuellement : préremplit lieu précis/lieu/père/grand-père
  // depuis la dernière saisie (la plupart des données EVOO7 partagent le même lieu physique) —
  // jamais le "quoi", propre à chaque donnée, laissé vide pour forcer une saisie consciente.
  const prefill = !d.taxonomieLieu && lastTaxonomyLieu ? lastTaxonomyLieu : null;
  const lieuPrecis = d.taxonomieLieuPrecis || prefill?.lieuPrecis || '';
  const lieu = d.taxonomieLieu || prefill?.lieu || '';
  const pere = d.taxonomiePere || prefill?.pere || '';
  const grandPere = d.taxonomieGrandPere || prefill?.grandPere || '';

  return `
    <input type="text" class="form-control taxo-quoi" placeholder="Quoi" value="${escapeHtml(d.taxonomieQuoi || '')}">
    <input type="text" class="form-control taxo-lieuprecis" placeholder="Lieu précis" value="${escapeHtml(lieuPrecis)}">
    <input type="text" class="form-control taxo-lieu" placeholder="Lieu" value="${escapeHtml(lieu)}">
    <input type="text" class="form-control taxo-pere" placeholder="Père" value="${escapeHtml(pere)}">
    <input type="text" class="form-control taxo-grandpere" placeholder="Grand-père" value="${escapeHtml(grandPere)}">
  `;
}

/**
 * Type HA forcé + Classe HA/Unité + bouton de sauvegarde de toute la ligne, empilés dans une
 * seule cellule (dans cet ordre : type forcé, payload ON/OFF si binary_sensor, classe/unité,
 * bouton) — regroupés volontairement pour rester dans le cadre visible du tableau, une colonne
 * séparée pour le type forcé se retrouvait hors champ (tableau plus large que l'écran). Visible
 * seulement pour une donnée sélectionnée (Consultation/Mise à jour cochée) ; cocher la case
 * rafraîchit cette cellule immédiatement côté client (voir refreshEditableCells), donc tout
 * apparaît dès la coche, avant même toute sauvegarde.
 */
function renderDeviceClassCell(d: Evoo7DataDefinition, published: boolean): string {
  if (!published) {
    return '<span class="constraints">--</span>';
  }
  const currentComponent = d.forcedComponent || '';
  const showPayloads = currentComponent === 'binary_sensor';
  const currentClass = d.deviceClass || '';
  const options = Object.keys(DEVICE_CLASS_UNITS)
    .map((key) => `<option value="${key}" ${key === currentClass ? 'selected' : ''}>${escapeHtml(DEVICE_CLASS_LABELS[key])}</option>`)
    .join('');
  return `
    <select class="form-control forced-component-select">
      <option value="" ${currentComponent === '' ? 'selected' : ''}>(auto)</option>
      <option value="binary_sensor" ${currentComponent === 'binary_sensor' ? 'selected' : ''}>binary_sensor</option>
    </select>
    <div class="binary-sensor-payloads" style="${showPayloads ? '' : 'display:none'}">
      <input type="text" class="form-control payload-on" placeholder="Payload ON (ex: on)" value="${escapeHtml(d.payloadOn || '')}">
      <input type="text" class="form-control payload-off" placeholder="Payload OFF (ex: off)" value="${escapeHtml(d.payloadOff || '')}">
    </div>
    <select class="form-control device-class-select">${options}</select>
    <input type="text" class="form-control device-class-unit" placeholder="Unité" value="${escapeHtml(d.unitOfMeasurement || '')}">
    <button class="btn btn-secondary" data-action="save-row">💾</button>
  `;
}

/**
 * Régénère juste les cellules Taxonomie/Classe HA d'une ligne quand Consultation/Mise à jour
 * est cochée ou décochée — sans re-render complet (perdrait les autres champs en cours de
 * saisie sur cette même ligne, voir setupUiListeners).
 */
function refreshEditableCells(row: Element, id: string): void {
  const d = donnees.find((x) => x.id === id);
  if (!d) return;

  const consultation = (row.querySelector('.consultation-check') as HTMLInputElement)?.checked ?? d.consultation;
  const miseAJourInput = row.querySelector('.miseajour-check') as HTMLInputElement | null;
  const miseAJour = miseAJourInput ? miseAJourInput.checked : d.miseAJour;
  const published = consultation || miseAJour;

  const taxoCell = row.querySelector('.taxo-cell');
  const deviceClassCell = row.querySelector('.device-class-cell');
  if (taxoCell) taxoCell.innerHTML = renderTaxonomyCell(d, published);
  if (deviceClassCell) deviceClassCell.innerHTML = renderDeviceClassCell(d, published);
}

function renderThermostat(): void {
  const enabledCheckbox = document.getElementById('thermostat-enabled') as HTMLInputElement | null;
  const allowCoolingCheckbox = document.getElementById('thermostat-allow-cooling') as HTMLInputElement | null;
  if (enabledCheckbox) enabledCheckbox.checked = thermostat.enabled;
  if (allowCoolingCheckbox) allowCoolingCheckbox.checked = thermostat.allowCooling;
}

function saveThermostat(): void {
  const enabledCheckbox = document.getElementById('thermostat-enabled') as HTMLInputElement | null;
  const allowCoolingCheckbox = document.getElementById('thermostat-allow-cooling') as HTMLInputElement | null;
  socket.emit('evoo7:thermostat:save', {
    enabled: enabledCheckbox?.checked ?? false,
    allowCooling: allowCoolingCheckbox?.checked ?? false
  });
}

function renderDonnees(): void {
  const body = document.getElementById('donnees-body');
  if (!body) return;

  body.innerHTML = donnees.map((d) => {
    const published = isPublished(d);
    return `
    <tr data-id="${escapeHtml(d.id)}">
      <td>
        <div class="mono">${escapeHtml(d.id)}</div>
        <div>${escapeHtml(d.description)}</div>
      </td>
      <td><span class="badge ${d.isConfigData ? 'config' : 'donnee'}">${d.isConfigData ? 'config' : 'donnée'}</span></td>
      <td class="constraints">${renderConstraints(d)}</td>
      <td><input type="checkbox" class="consultation-check" ${d.consultation ? 'checked' : ''}></td>
      <td>${isCommandable(d)
        ? `<input type="checkbox" class="miseajour-check" ${d.miseAJour ? 'checked' : ''}>`
        : '<span class="constraints">--</span>'}</td>
      <td class="topic-cell">
        <input type="text" class="form-control topic-sensor" value="${escapeHtml(d.topicSensor)}">
        <input type="text" class="form-control format-sensor" value="${escapeHtml(d.formatMessageSensor)}">
      </td>
      <td class="taxo-cell">${renderTaxonomyCell(d, published)}</td>
      <td class="taxo-cell device-class-cell">${renderDeviceClassCell(d, published)}</td>
    </tr>
  `;
  }).join('') || '<tr><td colspan="8">Aucune donnée</td></tr>';
}

/** Sauvegarde toute la ligne en un clic : sélection, topic/format, taxonomie et classe HA. */
function saveRow(id: string): void {
  const row = document.querySelector(`tr[data-id="${id}"]`);
  if (!row) return;

  const donnee = donnees.find((d) => d.id === id);
  if (!donnee) return;

  const consultation = (row.querySelector('.consultation-check') as HTMLInputElement).checked;
  const miseAJourInput = row.querySelector('.miseajour-check') as HTMLInputElement | null;
  const miseAJour = miseAJourInput ? miseAJourInput.checked : false;

  const topicSensor = (row.querySelector('.topic-sensor') as HTMLInputElement).value;
  const formatMessageSensor = (row.querySelector('.format-sensor') as HTMLInputElement).value;

  const taxoQuoiInput = row.querySelector('.taxo-quoi') as HTMLInputElement | null;
  const taxonomieQuoi = taxoQuoiInput?.value ?? donnee.taxonomieQuoi ?? '';
  const taxonomieLieuPrecis = (row.querySelector('.taxo-lieuprecis') as HTMLInputElement | null)?.value ?? donnee.taxonomieLieuPrecis ?? '';
  const taxonomieLieu = (row.querySelector('.taxo-lieu') as HTMLInputElement | null)?.value ?? donnee.taxonomieLieu ?? '';
  const taxonomiePere = (row.querySelector('.taxo-pere') as HTMLInputElement | null)?.value ?? donnee.taxonomiePere ?? '';
  const taxonomieGrandPere = (row.querySelector('.taxo-grandpere') as HTMLInputElement | null)?.value ?? donnee.taxonomieGrandPere ?? '';

  const deviceClass = (row.querySelector('.device-class-select') as HTMLSelectElement | null)?.value ?? donnee.deviceClass ?? '';
  const unitOfMeasurement = (row.querySelector('.device-class-unit') as HTMLInputElement | null)?.value ?? donnee.unitOfMeasurement ?? '';

  const forcedComponent = (row.querySelector('.forced-component-select') as HTMLSelectElement | null)?.value ?? donnee.forcedComponent ?? '';
  const payloadOn = (row.querySelector('.payload-on') as HTMLInputElement | null)?.value ?? donnee.payloadOn ?? '';
  const payloadOff = (row.querySelector('.payload-off') as HTMLInputElement | null)?.value ?? donnee.payloadOff ?? '';

  socket.emit('evoo7:donnee:save', {
    id, consultation, miseAJour, topicSensor, formatMessageSensor,
    taxonomieQuoi, taxonomieLieuPrecis, taxonomieLieu, taxonomiePere, taxonomieGrandPere,
    deviceClass, unitOfMeasurement, forcedComponent, payloadOn, payloadOff
  });
  // Confirmation affichée par le listener evoo7:donnee:save:response (voir setupSocketListeners)
  // une fois le serveur réellement passé — jamais optimiste.

  // Retenu tout de suite (pas d'attente du round-trip serveur) pour préremplir les prochaines
  // données non encore taxonomisées — voir renderTaxonomyCell.
  if (taxonomieLieu) {
    lastTaxonomyLieu = {
      lieuPrecis: taxonomieLieuPrecis,
      lieu: taxonomieLieu,
      pere: taxonomiePere,
      grandPere: taxonomieGrandPere
    };
  }
}

// ============================================================================
// Utilitaires
// ============================================================================

function showAlert(message: string, type: 'success' | 'error' | 'info'): void {
  const successEl = document.getElementById('success-alert');
  const errorEl = document.getElementById('error-alert');
  [successEl, errorEl].forEach((el) => { if (el) el.style.display = 'none'; });

  const el = type === 'error' ? errorEl : successEl;
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  }
}

function hideLoading(): void {
  const el = document.getElementById('loading');
  if (el) el.style.display = 'none';
}

// N'utilise PAS document.createElement + textContent/innerHTML : cette méthode n'échappe pas les
// guillemets (pas nécessaire en contenu texte), alors que ce helper sert aussi à insérer des
// valeurs dans des attributs value="..." (topic/format sensor notamment, qui contiennent du JSON
// bourré de guillemets) — un guillemet non échappé y referme l'attribut prématurément et tronque
// tout le reste, ce qui a corrompu formatMessageSensor à la sauvegarde (voir TODO.md).
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
