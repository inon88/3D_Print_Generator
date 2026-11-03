import * as THREE from './node_modules/three/build/three.module.js';
import { OrbitControls } from './node_modules/three/examples/jsm/controls/OrbitControls.js';
import { ThreeMFLoader } from './node_modules/three/examples/jsm/loaders/3MFLoader.js';
import { TransformControls } from './node_modules/three/examples/jsm/controls/TransformControls.js';
import {
  AXES, APP_LIMITS, TRANSFORM_GROUP, transformOwners, appTransformParameters, appTransformFromValues,
  transformMatrix, transformPoint, toColumnMajor, isIdentityTransform, itemTarget
} from './transform.cjs';
import { NESTED_TREE_ICONS, isFontParameterName } from './parameters.cjs';
import { rasterToSvg } from './raster-to-svg.cjs';
import { recolorLayer, mergeLayers, removeLayer } from './svg-layers.cjs';
import { prepareHeightmap, encodeGrayPng } from './heightmap.cjs';

const $ = selector => document.querySelector(selector);
const ui = {
  appShell: $('.app-shell'),
  appBrandName: $('#appBrandName'),
  toolSelect: $('#toolSelect'),
  toolCount: $('#toolCount'),
  toolMeta: $('#toolMeta'),
  deleteToolButton: $('#deleteToolButton'),
  librarySection: $('.library-section'),
  modeLithophane: $('#modeLithophane'),
  modeTools: $('#modeTools'),
  parameterList: $('#parameterList'),
  parameterCount: $('#parameterCount'),
  parameterHint: $('#parameterHint'),
  resetParamsButton: $('#resetParamsButton'),
  addParameterButton: $('#addParameterButton'),
  presetSelect: $('#presetSelect'),
  savePresetButton: $('#savePresetButton'),
  deletePresetButton: $('#deletePresetButton'),
  settingsShortcut: $('#settingsShortcut'),
  breadcrumbTool: $('#breadcrumbTool'),
  breadcrumbCategory: $('#breadcrumbCategory'),
  engineStatus: $('#engineStatus'),
  exportButton: $('#exportButton'),
  renderStatus: $('#renderStatus'),
  renderDot: $('#renderDot'),
  renderButton: $('#renderButton'),
  gridButton: $('#gridButton'),
  plateLayout: $('#plateLayout'),
  viewport: $('#viewport'),
  canvas: $('#previewCanvas'),
  emptyState: $('#emptyState'),
  emptyTitle: $('#emptyTitle'),
  emptyMessage: $('#emptyMessage'),
  emptyActions: $('#emptyActions'),
  viewportNotice: $('#viewportNotice'),
  meshSize: $('#meshSize'),
  triangleCount: $('#triangleCount'),
  renderTime: $('#renderTime'),
  statusDot: $('#statusDot'),
  statusMessage: $('#statusMessage'),
  exportFolderStatus: $('#exportFolderStatus'),
  appVersion: $('#appVersion'),
  modalLayer: $('#modalLayer'),
  modal: $('#modal'),
  toastRegion: $('#toastRegion'),
  transformTools: $('#transformTools'),
  transformDivider: $('#transformDivider'),
  activeObjectChip: $('#activeObjectChip'),
  activeObjectName: $('#activeObjectName'),
  transformHud: $('#transformHud'),
  viewHelp: $('#viewHelp')
};

const DEFAULT_APP_TITLE = 'BonaStudio';
const PRESET_STORAGE_PREFIX = 'formforge:presets:';

const state = {
  tools: [],
  activeToolId: '',
  lastScadToolId: '',   // shown in the (disabled) dropdown while the Lithophane mode is active
  values: {},
  baselineValues: {},
  dirty: false,
  settings: null,
  version: '',
  platform: '',
  openscadAvailable: false,
  localFonts: [],
  renderRevision: 0,
  renderTimer: null,
  rendering: false,
  mesh: null,
  meshFramed: false,
  grid: null,
  // Parameter accordion: the open group per tool id ('' = all closed; missing = first group).
  openParameterGroups: {},
  // Viewport transform: bounds of the untransformed mesh, the active (selected) object, gizmo mode,
  // and the running drag/shortcut session.
  meshBounds: null,
  selected: false,
  // Items announced by the last preview, and the id of the active one ('' = the whole model is active).
  items: [],
  activeItemId: '',
  // Plates the tool reported for the last preview (echo("formforge-plates", n)); null = not a multi-plate tool.
  plates: null,
  transformMode: 'translate',
  transformSession: null,
  ownersCache: { tool: null, parameters: null, owners: null }
};

const scene = new THREE.Scene();
scene.background = new THREE.Color('#fafcfb');
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 10000);
camera.up.set(0, 0, 1);
camera.position.set(115, -150, 115);
const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
scene.add(new THREE.HemisphereLight(0xf6fff9, 0x87998e, 2.4));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
keyLight.position.set(-80, -100, 160);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xd5ffea, 1.1);
fillLight.position.set(100, 50, 70);
scene.add(fillLight);

// Build plate grid: 256 × 256 mm with 10 mm cells measured from the centre, plus
// the plate border at ±128 mm (256 / 10 is not whole, so GridHelper cannot draw it).
function createPlateGrid(size = 256, cell = 10, mainColor = 0xc7d6ce, cellColor = 0xe4ece7) {
  const half = size / 2;
  const positions = [];
  const colors = [];
  const main = new THREE.Color(mainColor);
  const minor = new THREE.Color(cellColor);
  const offsets = [];
  for (let offset = 0; offset < half - 1e-6; offset += cell) offsets.push(offset, ...(offset ? [-offset] : []));
  offsets.push(-half, half);
  for (const offset of offsets) {
    const color = offset === 0 || Math.abs(offset) === half ? main : minor;
    positions.push(-half, offset, 0, half, offset, 0, offset, -half, 0, offset, half, 0);
    for (let index = 0; index < 4; index += 1) colors.push(color.r, color.g, color.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
}

// Build plates: columns × rows of 256 mm plates, 12 mm apart. Plate 1 is centered on the origin (where models
// are placed); further columns go to +X and rows to −Y, so a tool can put a part on plate n at a 268 mm pitch.
const PLATE_SIZE = 256;
const PLATE_PITCH = PLATE_SIZE + 12;
const PLATE_LAYOUTS = ['1x1', '2x1', '3x1', '4x1', '1x2', '2x2', '3x2', '4x2', '2x3', '3x3', '4x3', '4x4'];

const AUTO_PLATES_MAX = 8;

// The saved choice: 'auto' or 'CxR'.
function plateSetting() {
  const layout = state.settings?.plateLayout;
  return layout === 'auto' || /^[1-4]x[1-4]$/.test(layout || '') ? layout : 'auto';
}

// Auto: enough columns (+X) and rows (−Y) of plates to cover the model as it sits in the viewport.
// Plates only grow away from plate 1, matching where tools put their extra plates.
function autoPlateLayout() {
  if (!state.mesh) return '1x1';
  const bounds = new THREE.Box3().setFromObject(state.mesh, true);
  if (bounds.isEmpty()) return '1x1';
  const half = PLATE_SIZE / 2 + 0.5;
  const count = extent => Math.min(AUTO_PLATES_MAX, Math.max(1, Math.ceil((extent - half) / PLATE_PITCH) + 1));
  return `${count(bounds.max.x)}x${count(-bounds.min.y)}`;
}

// The layout actually drawn ('CxR').
function plateLayout() {
  const setting = plateSetting();
  return setting === 'auto' ? autoPlateLayout() : setting;
}

function plateCountLabel(layout) {
  const [columns, rows] = layout.split('x').map(Number);
  const count = columns * rows;
  return count === 1 ? '1 plate' : `${count} plates · ${columns} × ${rows}`;
}

function createPlates(layout) {
  const [columns, rows] = layout.split('x').map(Number);
  const plates = new THREE.Group();
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const plate = createPlateGrid(PLATE_SIZE);
      plate.position.set(column * PLATE_PITCH, -row * PLATE_PITCH, 0);
      plates.add(plate);
    }
  }
  plates.position.z = -0.03;
  return plates;
}

function stylePlates() {
  const isDark = document.body.dataset.theme === 'dark';
  state.grid?.children.forEach(plate => {
    plate.material.color.set(isDark ? '#3d4b44' : '#c7d6ce');
    plate.material.depthWrite = false;
    plate.material.transparent = isDark;
    plate.material.opacity = isDark ? 0.8 : 1;
  });
}

function updatePlates() {
  const layout = plateLayout();
  if (ui.plateLayout) {
    const auto = ui.plateLayout.querySelector('option[value="auto"]');
    if (auto) auto.textContent = `Auto · ${plateCountLabel(plateSetting() === 'auto' ? layout : autoPlateLayout())}`;
    ui.plateLayout.value = plateSetting();
  }
  if (state.grid?.userData.layout === layout) return;
  const visible = state.grid ? state.grid.visible : true;
  if (state.grid) {
    scene.remove(state.grid);
    state.grid.traverse(object => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
  }
  state.grid = createPlates(layout);
  state.grid.userData.layout = layout;
  state.grid.visible = visible;
  scene.add(state.grid);
  stylePlates();
}

updatePlates();
const axes = new THREE.AxesHelper(55);
axes.material.depthTest = false;
axes.renderOrder = 2;
scene.add(axes);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;
controls.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.ROTATE,
  RIGHT: THREE.MOUSE.PAN
};
controls.target.set(0, 0, 15);
controls.update();
renderer.setClearColor('#fafcfb');

// The gizmo drives an invisible proxy at the model's pivot; the model matrix is derived from it.
const transformProxy = new THREE.Object3D();
scene.add(transformProxy);
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSpace('world');
const gizmoHelper = gizmo.getHelper();
scene.add(gizmoHelper);
// Active-object outline: the model's own bounds, following its rotation and scale.
const selectionBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: 0x078965, depthTest: false, transparent: true, opacity: 0.9 })
);
selectionBox.matrixAutoUpdate = false;
selectionBox.renderOrder = 3;
selectionBox.visible = false;
scene.add(selectionBox);
const outlinePosition = new THREE.Vector3();
const outlineSize = new THREE.Vector3();
const outlineMatrix = new THREE.Matrix4();
// Movable items (echo("formforge-item", …) in the tool): a second proxy at the active item's center, and its
// footprint drawn as a rectangle that follows the proxy while it is dragged.
const itemProxy = new THREE.Object3D();
scene.add(itemProxy);
const itemOutline = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => new THREE.Vector3(x, y, 0))),
  new THREE.LineBasicMaterial({ color: 0xf97316, depthTest: false, transparent: true, opacity: 0.95 })
);
itemOutline.matrixAutoUpdate = false;
itemOutline.renderOrder = 3;
itemOutline.visible = false;
scene.add(itemOutline);

function updateItemOutline() {
  const item = activeItem();
  if (!item || !state.mesh) return;
  const meshScale = new THREE.Vector3();
  state.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), meshScale);
  outlineSize.set(item.size[0] * meshScale.x * itemProxy.scale.x + 1, item.size[1] * meshScale.y * itemProxy.scale.y + 1, 1);
  itemOutline.matrix.compose(itemProxy.position, itemProxy.quaternion, outlineSize);
  itemOutline.matrixWorldNeedsUpdate = true;
}

function updateSelectionOutline() {
  const { min, max } = state.meshBounds;
  outlinePosition.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  outlineSize.set(Math.max(max[0] - min[0], 0.01), Math.max(max[1] - min[1], 0.01), Math.max(max[2] - min[2], 0.01));
  outlineMatrix.compose(outlinePosition, new THREE.Quaternion(), outlineSize);
  selectionBox.matrix.multiplyMatrices(state.mesh.matrix, outlineMatrix);
  selectionBox.matrixWorldNeedsUpdate = true;
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (selectionBox.visible && state.mesh && state.meshBounds) updateSelectionOutline();
  if (itemOutline.visible) updateItemOutline();
  renderer.render(scene, camera);
}
animate();

function resizeViewport() {
  const bounds = ui.viewport.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  renderer.setSize(bounds.width, bounds.height, false);
  camera.aspect = bounds.width / bounds.height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resizeViewport).observe(ui.viewport);
window.addEventListener('resize', resizeViewport);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function activeTool() {
  return state.tools.find(tool => tool.id === state.activeToolId) || null;
}

// The Lithophane generator (JavaScript, no OpenSCAD) has its own mode above the tool dropdown;
// the dropdown lists only the SCAD tools and is disabled while the generator is active.
const isGeneratorTool = tool => tool?.kind === 'generator';
const scadTools = () => state.tools.filter(tool => !isGeneratorTool(tool));
const generatorTool = () => state.tools.find(isGeneratorTool) || null;

function updateModeSwitch() {
  const generatorActive = isGeneratorTool(activeTool());
  ui.modeLithophane.setAttribute('aria-checked', String(generatorActive));
  ui.modeTools.setAttribute('aria-checked', String(!generatorActive));
  ui.modeLithophane.disabled = !generatorTool();
  ui.librarySection.classList.toggle('is-generator', generatorActive);
  ui.toolSelect.disabled = generatorActive || !scadTools().length;
}

function chooseMode(mode) {
  if (mode === 'lithophane') {
    const generator = generatorTool();
    if (generator && !isGeneratorTool(activeTool())) switchTool(generator.id);
  } else if (isGeneratorTool(activeTool())) {
    const tools = scadTools();
    const next = tools.find(tool => tool.id === state.lastScadToolId) || tools[0];
    if (next) switchTool(next.id);
    else {
      updateModeSwitch();
      openAddToolModal();
    }
  }
}

function defaultValues(tool) {
  // Clone so editing nested values never mutates the manifest defaults used by "Restore default values".
  return structuredClone(Object.fromEntries(toolParameters(tool).map(parameter => [parameter.name, parameter.default])));
}

// --- Viewport transform: parameters --------------------------------------------------------------------------

function transformEnabled() {
  return state.settings?.transformEnabled !== false;
}

function ownersFor(tool) {
  const cache = state.ownersCache;
  if (cache.tool !== tool || cache.parameters !== tool?.parameters) {
    cache.tool = tool;
    cache.parameters = tool?.parameters;
    cache.owners = transformOwners(tool?.parameters || []);
  }
  return cache.owners;
}

// Tool parameters plus the automatic Transform parameters for channels the tool does not own.
// The Transform values always exist (presets keep them); the feature setting only hides and ignores them.
function toolParameters(tool) {
  if (!tool) return [];
  return [...(tool.parameters || []), ...appTransformParameters(ownersFor(tool))];
}

function findParameter(tool, name) {
  return toolParameters(tool).find(parameter => parameter.name === name) || null;
}

// Move channels owned by the tool keep the tool's coordinate on that axis instead of centering it.
function keptAxes(tool) {
  if (!tool || !transformEnabled()) return [false, false, false];
  return ownersFor(tool).move.map(owner => owner.source === 'tool');
}

function keepOnPlateActive(tool = activeTool()) {
  return state.settings?.keepOnPlate !== false && !keptAxes(tool)[2];
}

function visibleTransformParameters(tool) {
  if (!tool || !transformEnabled()) return [];
  const lockZ = keepOnPlateActive(tool);
  return appTransformParameters(ownersFor(tool)).filter(parameter => !(lockZ && parameter.name === 'formforge_move_z'));
}

// The app-owned transform currently applied to the preview (and sent with export).
function currentAppTransform(tool = activeTool()) {
  const neutral = { move: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] };
  if (!tool || !transformEnabled()) return neutral;
  const transform = appTransformFromValues(state.values, ownersFor(tool));
  if (keepOnPlateActive(tool)) transform.move[2] = 0;
  return transform;
}

function exportTransformPayload(tool) {
  if (!transformEnabled()) return null;
  const transform = currentAppTransform(tool);
  if (isIdentityTransform(transform)) return null;
  return { ...transform, keepOnPlate: keepOnPlateActive(tool), keepAxes: keptAxes(tool) };
}

function withAvailableFont(tool, values) {
  const normalized = { ...values };
  for (const parameter of tool?.parameters || []) {
    if (parameter.type !== 'string' || !isFontParameterName(parameter.name) || !state.localFonts.length) continue;
    if (!state.localFonts.some(font => font.name === normalized[parameter.name])) normalized[parameter.name] = state.localFonts[0].name;
  }
  const nestedTreeParameter = tool?.parameters?.find(parameter => parameter.type === 'nested-tree');
  if (nestedTreeParameter && Array.isArray(normalized[nestedTreeParameter.name])) {
    const fallback = normalized.font_name || state.localFonts[0]?.name || '';
    const normalizeNodes = nodes => nodes.forEach(node => {
      if (!state.localFonts.some(font => font.name === node.font)) node.font = fallback;
      if (!/^#[\da-f]{6}$/i.test(node.color || '')) node.color = '#111827';
      normalizeNodes(Array.isArray(node.children) ? node.children : []);
    });
    normalizeNodes(normalized[nestedTreeParameter.name]);
  }
  return normalized;
}

function isMac() {
  return state.platform === 'darwin';
}

function shortcutLabel(key) {
  return `${isMac() ? '⌘' : 'Ctrl'}+${key}`;
}

function presetStorageKey(tool) {
  return `${PRESET_STORAGE_PREFIX}${tool.id}`;
}

function getPresetList() {
  const tool = activeTool();
  if (!tool) return [];
  try {
    const value = localStorage.getItem(presetStorageKey(tool));
    return value ? JSON.parse(value) : [];
  } catch (error) {
    console.error('Could not read presets:', error);
    return [];
  }
}

function writePresetList(presets) {
  localStorage.setItem(presetStorageKey(activeTool()), JSON.stringify(presets));
}

function renderPresetSelect(selectedId = '') {
  const presets = getPresetList();
  ui.presetSelect.innerHTML = `<option value="">Default values</option>${presets.map(preset =>
    `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`
  ).join('')}`;
  ui.presetSelect.value = presets.some(preset => preset.id === selectedId) ? selectedId : '';
  ui.deletePresetButton.hidden = !ui.presetSelect.value;
}

function toolSourceLabel(tool) {
  if (tool.kind === 'generator') return 'Built-in generator';
  if (tool.sourceUrl) return 'Imported from URL';
  if (String(tool.entry || '').startsWith('project')) return 'Project folder';
  if (tool.category === 'Example') return 'Example tool';
  return 'SCAD file';
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function refreshToolSelect() {
  const previous = state.activeToolId;
  const nameCounts = new Map();
  state.tools.forEach(tool => nameCounts.set(tool.name, (nameCounts.get(tool.name) || 0) + 1));
  const nameIndexes = new Map();
  const tools = scadTools();
  ui.toolSelect.innerHTML = tools.length
    ? tools.map(tool => {
      const index = (nameIndexes.get(tool.name) || 0) + 1;
      nameIndexes.set(tool.name, index);
      const label = nameCounts.get(tool.name) > 1 ? `${tool.name} (${index})` : tool.name;
      return `<option value="${escapeHtml(tool.id)}">${escapeHtml(label)}</option>`;
    }).join('')
    : '<option value="">No tools yet</option>';
  ui.toolCount.textContent = String(tools.length);
  const shown = tools.some(tool => tool.id === previous) ? previous : state.lastScadToolId;
  if (tools.some(tool => tool.id === shown)) ui.toolSelect.value = shown;
  updateModeSwitch();
}

function setEmptyState(title, message, actions = [], busy = false) {
  ui.emptyState.hidden = false;
  ui.emptyState.classList.toggle('is-busy', busy);
  ui.emptyTitle.textContent = title;
  ui.emptyMessage.textContent = message;
  ui.emptyActions.innerHTML = actions.map(action =>
    `<button class="button ${action.primary ? 'button-primary' : 'button-secondary'} button-compact" type="button" data-empty-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`
  ).join('');
}

// ipcRenderer.invoke prefixes main-process errors with "Error invoking remote method '…': Error: ".
function cleanErrorMessage(message) {
  return String(message || 'Something went wrong.').replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '');
}

function splitErrorMessage(message) {
  const text = cleanErrorMessage(message);
  const marker = text.search(/\n\s*\n?OpenSCAD output:\n/);
  if (marker < 0) return { summary: text, details: '' };
  return { summary: text.slice(0, marker).trim(), details: text.slice(marker).replace(/^\s*OpenSCAD output:\n/, '').trim() };
}

function showNotice(title, message) {
  const { summary, details } = splitErrorMessage(message);
  ui.viewportNotice.innerHTML = `<div class="notice-head"><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(summary)}</p></div>
      <button class="icon-button small-icon-button" type="button" data-dismiss-notice aria-label="Dismiss"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
    ${details ? `<details class="error-details"><summary>OpenSCAD output</summary><pre>${escapeHtml(details)}</pre></details>` : ''}`;
  ui.viewportNotice.hidden = false;
}

function hideNotice() {
  ui.viewportNotice.hidden = true;
  ui.viewportNotice.replaceChildren();
}

function setStatus(message, isError = false) {
  ui.statusMessage.textContent = message;
  ui.statusDot.classList.toggle('is-error', isError);
}

function clearMesh() {
  if (!state.mesh) return;
  scene.remove(state.mesh);
  state.mesh.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
    else object.material.dispose();
  });
  state.mesh = null;
  state.meshBounds = null;
  state.items = [];
  state.plates = null;
  updatePlates();
  ui.triangleCount.textContent = '—';
  ui.meshSize.textContent = '—';
  ui.renderTime.textContent = '—';
}

// kind: idle | pending | rendering | ready | error
function setRenderState(status, kind = 'ready') {
  ui.renderStatus.textContent = status;
  for (const name of ['idle', 'pending', 'rendering', 'error']) ui.renderDot.classList.toggle(`is-${name}`, kind === name);
}

// Icons the tool draws for nested Icon elements (marker icons=…), else the built-in set.
function nestedIcons() {
  const icons = activeTool()?.parameters?.find(parameter => parameter.type === 'nested-tree')?.icons;
  return icons?.length ? icons : NESTED_TREE_ICONS;
}
const nestedColors = [
  { name: 'Black', value: '#111827' }, { name: 'White', value: '#ffffff' },
  { name: 'Red', value: '#ef4444' }, { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' }, { name: 'Green', value: '#22c55e' },
  { name: 'Teal', value: '#14b8a6' }, { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#8b5cf6' }, { name: 'Pink', value: '#ec4899' }
];

function nestedNodeMarkup(node, path, depth, listPath, siblingCount, maxDepth) {
  const type = ['Text', 'SVG', 'Icon'].includes(node.type) ? node.type : 'Text';
  const pathAttr = escapeHtml(path);
  const nodeColor = /^#[\da-f]{6}$/i.test(node.color || '') ? node.color : '#111827';
  const field = (key, label, value, min, max, step = 1) => `<label class="nested-field"><span>${label}</span><input type="number" data-tree-path="${pathAttr}" data-tree-key="${key}" value="${escapeHtml(value ?? 0)}" min="${min}" max="${max}" step="${step}"></label>`;
  const positionSlider = (key, label, value, min = -128, max = 128, unit = 'mm') => `<label class="nested-position-slider"><span>${label} <output data-tree-value="${key}" data-tree-path="${pathAttr}" data-tree-unit="${unit}">${Number(value ?? 0).toFixed(1)} ${unit}</output></span><input type="range" data-tree-path="${pathAttr}" data-tree-key="${key}" value="${escapeHtml(value ?? 0)}" min="${min}" max="${max}" step="0.5" aria-label="${label}"></label>`;
  const fontOptions = state.localFonts.length
    ? state.localFonts.map(font => `<option value="${escapeHtml(font.name)}" ${font.name === node.font ? 'selected' : ''}>${escapeHtml(font.family + (font.style && font.style !== 'Regular' ? ' — ' + font.style : ''))}</option>`).join('')
    : `<option value="${escapeHtml(node.font || '')}" selected>${escapeHtml(node.font || 'No local fonts found')}</option>`;
  const typeControls = type === 'Text'
    ? `<label class="nested-field"><span>Text</span><input type="text" data-tree-path="${pathAttr}" data-tree-key="text" value="${escapeHtml(node.text || '')}"></label>
       <label class="nested-field"><span>Font</span><select data-tree-path="${pathAttr}" data-tree-key="font">${fontOptions}</select></label>
       ${field('size', 'Text size (mm)', node.size, 1, 210)} ${field('bold', 'Text bold (mm)', node.bold, 0, 8, 0.1)}`
    : type === 'Icon'
      ? `<label class="nested-field"><span>Icon</span><select data-tree-path="${pathAttr}" data-tree-key="icon">${nestedIcons().map(icon => `<option ${node.icon === icon ? 'selected' : ''}>${icon}</option>`).join('')}</select></label>
         ${field('size', 'Icon size (mm)', node.size, 1, 210)} ${field('bold', 'Icon bold (mm)', node.bold, 0, 8, 0.1)}`
      : `<div class="nested-svg-row"><span>SVG</span><span class="nested-svg-name">${escapeHtml(node.svgPath ? node.svgPath.split(/[\\/]/).pop() : 'No SVG selected')}</span>
           <button class="button button-secondary nested-small-button" type="button" data-tree-action="pick-svg" data-tree-path="${pathAttr}">Choose SVG</button>
         </div>${field('size', 'SVG size (mm)', node.size, 1, 210)} ${field('bold', 'SVG bold (mm)', node.bold, 0, 8, 0.1)}`;
  const children = Array.isArray(node.children) ? node.children : [];
  return `<article class="nested-node" data-depth="${depth}">
    <div class="nested-node-heading"><strong>Element ${path.split('.').map(part => Number(part) + 1).join(' › ')}</strong>
      <div class="nested-node-tools">
        <div class="nested-color-picker">
          <button class="nested-color-trigger" type="button" data-tree-action="toggle-color" aria-label="Choose color for element" title="Choose element color"><span class="nested-color-indicator" style="background-color:${nodeColor}"></span></button>
          <div class="nested-color-menu" hidden>${nestedColors.map(color => `<button class="nested-color-swatch" type="button" data-tree-action="set-color" data-tree-path="${pathAttr}" data-color="${color.value}" aria-label="${color.name}" title="${color.name}" aria-pressed="${color.value === nodeColor}"><span style="background-color:${color.value}"></span></button>`).join('')}</div>
        </div>
        ${siblingCount > 1 || depth > 1 ? `<button class="nested-remove" type="button" data-tree-action="remove" data-tree-path="${pathAttr}" data-tree-list="${escapeHtml(listPath)}" aria-label="Remove element">Remove</button>` : ''}
      </div>
    </div>
    <label class="nested-field"><span>Type</span><select data-tree-path="${pathAttr}" data-tree-key="type">${['Text', 'SVG', 'Icon'].map(option => `<option ${type === option ? 'selected' : ''}>${option}</option>`).join('')}</select></label>
    <div class="nested-type-fields">${typeControls}</div>
    <div class="nested-grid nested-position-controls">${field('thickness', 'Thickness (mm)', node.thickness, 0.4, 20, 0.2)} ${positionSlider('x', 'X position', node.x)} ${positionSlider('y', 'Y position', node.y)} ${positionSlider('rotation', 'Rotation', node.rotation ?? 0, -180, 180, '°')}</div>
    <div class="nested-grid nested-position-grid">
      <label class="nested-field"><span>Z placement</span><select data-tree-path="${pathAttr}" data-tree-key="placement"><option ${node.placement === 'Above' ? 'selected' : ''}>Above</option><option ${node.placement === 'Inset' ? 'selected' : ''}>Inset</option></select></label>
      ${field('overlap', 'Inset depth (mm)', node.overlap, 0, 20, 0.2)}
    </div>
    <div class="nested-actions">
      ${depth < maxDepth ? `<button class="button button-secondary nested-small-button" type="button" data-tree-action="add-child" data-tree-path="${pathAttr}">+ Add nested element</button>` : '<span class="nested-depth-note">Maximum depth reached</span>'}
      <button class="button button-secondary nested-small-button" type="button" data-tree-action="add-sibling" data-tree-list="${escapeHtml(listPath)}">+ Add element at this level</button>
    </div>
    ${children.length ? `<div class="nested-children"><h4>Nested elements</h4>${children.map((child, index) => nestedNodeMarkup(child, `${path}.${index}`, depth + 1, `${path}.children`, children.length, maxDepth)).join('')}</div>` : ''}
  </article>`;
}

function nestedTreeMarkup(parameter, tree) {
  const layers = Array.isArray(tree) ? tree : [];
  return `<div class="nested-tree-editor" data-nested-tree="${escapeHtml(parameter.name)}">
    <p class="parameter-description">Add text, SVG, or icons in a hierarchy. X/Y values and rotation are relative to the parent. When the tool supports it, click an element in the viewport and press G, R, or S. Maximum depth: ${Number(parameter.maxDepth) || 4}.</p>
    ${layers.map((node, index) => nestedNodeMarkup(node, String(index), 1, '', layers.length, Number(parameter.maxDepth) || 4)).join('')}
    <button class="button button-primary nested-add-root" type="button" data-tree-action="add-root">+ Add element</button>
  </div>`;
}

function parameterMarkup(parameter, value) {
  const name = escapeHtml(parameter.name);
  const label = escapeHtml(parameter.label || parameter.name);
  const description = parameter.description ? `<p class="parameter-description">${escapeHtml(parameter.description)}</p>` : '';
  if (parameter.type === 'nested-tree') return nestedTreeMarkup(parameter, value);
  if (parameter.type === 'boolean') {
    return `<div class="parameter-control">
      <div class="toggle-row"><div><div class="parameter-label">${label}</div>${description}</div>
        <input class="toggle" type="checkbox" data-param="${name}" ${value ? 'checked' : ''} aria-label="${label}">
      </div>
    </div>`;
  }
  if (parameter.options?.length) {
    const options = parameter.options.map((option, index) => ({
      value: option && typeof option === 'object' ? option.value : option,
      label: parameter.optionLabels?.[index] ?? (option && typeof option === 'object' ? option.label : option)
    }));
    return `<div class="parameter-control">
      <div class="parameter-label-row"><label class="parameter-label" for="param-${name}">${label}</label></div>
      <select id="param-${name}" class="parameter-select" data-param="${name}">
        ${options.map(option => `<option ${String(option.value) === String(value) ? 'selected' : ''} value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}
      </select>${description}
    </div>`;
  }
  if (parameter.type === 'number' && Number.isFinite(Number(parameter.min)) && Number.isFinite(Number(parameter.max))) {
    const step = Number(parameter.step) > 0 ? Number(parameter.step) : 1;
    return `<div class="parameter-control">
      <div class="parameter-label-row">
        <label class="parameter-label" for="range-${name}">${label}</label>
        <input class="parameter-value" type="number" data-param="${name}" value="${escapeHtml(value)}" step="${step}" min="${parameter.min}" max="${parameter.max}" aria-label="${label} value">
      </div>
      <div class="range-row"><span class="range-bound">${escapeHtml(parameter.min)}</span>
        <input id="range-${name}" type="range" data-param="${name}" value="${escapeHtml(value)}" min="${parameter.min}" max="${parameter.max}" step="${step}" aria-label="${label} slider">
        <span class="range-bound">${escapeHtml(parameter.max)}</span>
      </div>${description}
    </div>`;
  }
  const displayValue = Array.isArray(value) ? value.join(', ') : value;
  if (parameter.type === 'string' && isFontParameterName(parameter.name)) {
    const selectedName = String(value ?? '');
    const fonts = state.localFonts;
    const options = fonts.length
      ? fonts.map(font => '<option value="' + escapeHtml(font.name) + '" style="font-family:&quot;' + escapeHtml(font.family) + '&quot;" ' + (font.name === selectedName ? 'selected' : '') + '>' + escapeHtml(font.family + (font.style && font.style !== 'Regular' ? ' — ' + font.style : '')) + ' · AaBb 123</option>').join('')
      : '<option value="' + escapeHtml(selectedName) + '" selected>No local fonts found</option>';
    const selectedFont = fonts.find(font => font.name === selectedName);
    const previewStyle = selectedFont ? 'font-family:&quot;' + escapeHtml(selectedFont.family) + '&quot;' : '';
    return '<div class="parameter-control font-control">' +
      '<div class="parameter-label-row"><label class="parameter-label" for="param-' + name + '">' + label + '</label></div>' +
      '<select id="param-' + name + '" class="parameter-select font-select" data-param="' + name + '" ' + (!fonts.length ? 'disabled' : '') + '>' + options + '</select>' +
      '<div class="font-preview" data-font-preview="' + name + '" style="' + previewStyle + '">AaBbCc 123 · Preview</div>' +
      '<p class="parameter-description">Choose a font installed on this device. The preview uses the selected font.</p>' +
    '</div>';
  }
  if (parameter.name === 'relief_image_file' || parameter.name === LITHOPHANE_IMAGE_PARAMETER) {
    const hint = parameter.name === LITHOPHANE_IMAGE_PARAMETER
      ? 'PNG, JPG, or WebP. Dark areas become thick, light areas thin: adjust levels and contrast in the next step.'
      : 'PNG, JPG, or WebP. Brightness becomes height: adjust levels and contrast in the next step.';
    return `<div class="parameter-control">
      <div class="parameter-label-row"><label class="parameter-label" for="param-${name}">${label}</label></div>
      <div class="file-picker-row">
        <input id="param-${name}" class="parameter-text" type="text" data-param="${name}" value="${escapeHtml(displayValue ?? '')}">
        <button class="file-picker-button" type="button" data-file-picker="relief" data-param="${name}">Choose image</button>
      </div>
      <p class="parameter-description">${hint}</p>
    </div>`;
  }
  if (parameter.name === 'icon_left_file' || parameter.name === 'icon_right_file') {
    return `<div class="parameter-control">
      <div class="parameter-label-row"><label class="parameter-label" for="param-${name}">${label}</label></div>
      <div class="file-picker-row">
        <input id="param-${name}" class="parameter-text" type="text" data-param="${name}" value="${escapeHtml(displayValue ?? '')}">
        <button class="file-picker-button" type="button" data-file-picker="icon" data-param="${name}">Choose image</button>
        <button class="file-picker-button" type="button" data-icon-library data-param="${name}">Icon library</button>
      </div>
      <p class="parameter-description">SVG is used directly. PNG, JPG, and WebP are traced into color layers or converted to a silhouette. Icon library lists the SVG packs in your icon folder.</p>
    </div>`;
  }
  return `<div class="parameter-control">
    <div class="parameter-label-row"><label class="parameter-label" for="param-${name}">${label}</label></div>
    <input id="param-${name}" class="parameter-text" type="${parameter.type === 'number' ? 'number' : 'text'}" data-param="${name}" value="${escapeHtml(displayValue ?? '')}">
    ${description}
  </div>`;
}

// Silhouettes keep the original 192 px limit; color tracing reads more pixels at higher detail.
const SILHOUETTE_MAX_SIDE = 192;
const TRACE_MAX_SIDE = { low: 1024, medium: 1600, high: 2048 };

// Decodes a PNG/JPG/WebP into RGBA pixels, scaled down so the longest side is at most maxSide.
async function decodeRasterFile(file, maxSide) {
  const bytes = new Uint8Array(file.data);
  const blob = new Blob([bytes], { type: file.extension === '.png' ? 'image/png'
    : file.extension === '.webp' ? 'image/webp' : 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not read the selected image.');
    context.drawImage(image, 0, 0, width, height);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function rasterFileToSvg(file) {
  const { width, height, data } = await decodeRasterFile(file, SILHOUETTE_MAX_SIDE);
  return rasterToSvg(width, height, data);
}

// A tool opts into color layers by declaring "<name>_colors" next to "<name>_file"
// (e.g. icon_left_colors); it receives the traced colors as "#RRGGBB,#RRGGBB".
function colorsParameterFor(tool, parameterName) {
  const name = parameterName.replace(/_file$/, '_colors');
  return tool.parameters?.find(parameter => parameter.name === name && parameter.type === 'string') ? name : null;
}

async function saveImageParameter(tool, parameterName, svg, colors) {
  const saved = await window.formforge.saveIconAsset(tool.id, parameterName, svg);
  updateParameter(parameterName, saved.reference, null);
  const colorsParameter = colorsParameterFor(tool, parameterName);
  if (colorsParameter) updateParameter(colorsParameter, colors.join(','), null);
}

async function handleParameterFilePicker(button) {
  const kind = button.dataset.filePicker;
  const parameterName = button.dataset.param;
  const tool = activeTool();
  if (tool && kind === 'relief' && (parameterName === 'relief_image_file' || parameterName === LITHOPHANE_IMAGE_PARAMETER)) {
    const file = await window.formforge.chooseParameterFile('relief');
    if (file) openReliefModal(tool, parameterName, file);
    return;
  }
  if (!tool || kind !== 'icon' || !['icon_left_file', 'icon_right_file'].includes(parameterName)) return;
  const file = await window.formforge.chooseParameterFile(kind);
  if (!file) return;
  if (file.extension === '.svg') {
    await saveImageParameter(tool, parameterName, new TextDecoder().decode(new Uint8Array(file.data)), []);
    toast('Icon image added to this tool.');
    return;
  }
  openImageConversionModal(tool, parameterName, file);
}

// Object URLs of the open conversion modal; released when the next one opens or a result is used.
let conversionUrls = [];
function releaseConversionUrls() {
  conversionUrls.forEach(url => URL.revokeObjectURL(url));
  conversionUrls = [];
}

// Vector Magic-style conversion: pick colors and detail, compare the traced result with the
// original, edit the palette (recolor, merge, remove), then use the result.
function openImageConversionModal(tool, parameterName, file) {
  releaseConversionUrls();
  const supportsColors = Boolean(colorsParameterFor(tool, parameterName));
  let mode = supportsColors ? 'color' : 'silhouette';
  let current = null;            // { svg, colors, areas } for color mode, { svg } for silhouette
  let revision = 0;
  let retraceTimer = 0;
  const decoded = new Map();
  const imageType = file.extension === '.png' ? 'image/png' : file.extension === '.webp' ? 'image/webp' : 'image/jpeg';
  const originalUrl = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: imageType }));
  conversionUrls.push(originalUrl);
  const colorOptions = ['<option value="0" selected>Auto</option>',
    ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(count => `<option value="${count}">${count} colors</option>`)].join('');

  openModal('Convert image', `${file.fileName} · compare the result, adjust it, then use it`, `
    <div class="choice-grid choice-grid-2">
      <button class="choice-card" data-convert="color" type="button"><span class="choice-type">Color</span><strong>Color layers</strong><small>Each color becomes its own part. Best for logos, stickers, and flat artwork.</small></button>
      <button class="choice-card" data-convert="silhouette" type="button"><span class="choice-type">Mono</span><strong>Silhouette</strong><small>One solid shape from the dark or opaque parts of the image.</small></button>
    </div>
    <div id="traceOptions" class="trace-options">
      <label class="modal-field"><span>Colors</span><select id="traceColors" class="modal-select">${colorOptions}</select></label>
      <label class="modal-field"><span>Detail</span><select id="traceDetail" class="modal-select"><option value="low">Low · smoothest</option><option value="medium" selected>Medium</option><option value="high">High · finest</option></select></label>
      <label class="trace-toggle"><input id="traceRemoveBackground" class="toggle" type="checkbox" checked><span>Remove background</span></label>
    </div>
    <div class="trace-compare">
      <figure><div class="trace-frame"><img src="${originalUrl}" alt="Original image"></div><figcaption>Original</figcaption></figure>
      <figure><div class="trace-frame"><img id="traceResult" alt="Converted result"><div id="traceBusy" class="trace-busy">Converting…</div></div><figcaption id="traceCaption">Result</figcaption></figure>
    </div>
    <div id="tracePalette" class="trace-palette"></div>
    ${supportsColors ? '' : '<div class="modal-note">This tool uses a single color, so color layers are combined into one shape.</div>'}
    <div id="convertError"></div>
    <div class="modal-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button id="confirmConvert" class="button button-primary" type="button" disabled>Use result</button></div>`, 'modal-trace');

  const showResult = () => {
    const image = $('#traceResult');
    if (!current) { image.removeAttribute('src'); return; }
    const url = URL.createObjectURL(new Blob([current.svg], { type: 'image/svg+xml' }));
    conversionUrls.push(url);
    image.src = url;
    $('#traceCaption').textContent = mode === 'color'
      ? `Result · ${current.colors.length} color${current.colors.length === 1 ? '' : 's'}`
      : 'Result · silhouette';
    renderPalette();
  };

  const renderPalette = () => {
    const palette = $('#tracePalette');
    if (mode !== 'color' || !current) { palette.innerHTML = ''; return; }
    palette.innerHTML = current.colors.map((hex, index) => {
      const others = current.colors.map((other, target) => target === index ? ''
        : `<option value="${target}">Merge into ${escapeHtml(other)}</option>`).join('');
      return `<div class="trace-swatch">
        <input type="color" value="${hex.toLowerCase()}" data-recolor="${index}" aria-label="Color ${index + 1}">
        <span class="trace-swatch-hex">${escapeHtml(hex)}</span>
        <span class="trace-swatch-area">${Math.max(0.1, Math.round(current.areas[index] * 1000) / 10)}%</span>
        ${current.colors.length > 1 ? `<select class="modal-select trace-merge" data-merge="${index}" aria-label="Merge color ${index + 1}"><option value="">Merge…</option>${others}</select>
        <button class="button button-secondary button-compact" type="button" data-remove="${index}">Remove</button>` : ''}
      </div>`;
    }).join('');
  };

  const setBusy = busy => {
    $('#traceBusy').hidden = !busy;
    $('#confirmConvert').disabled = busy || !current;
  };

  const convert = async () => {
    const mine = ++revision;
    $('#convertError').innerHTML = '';
    setBusy(true);
    try {
      let next;
      if (mode === 'color') {
        const detail = $('#traceDetail').value;
        if (!decoded.has(detail)) decoded.set(detail, await decodeRasterFile(file, TRACE_MAX_SIDE[detail]));
        const { width, height, data } = decoded.get(detail);
        next = await window.formforge.traceImage(new Uint8Array(data.buffer), width, height, {
          maxColors: Number($('#traceColors').value),
          removeBackground: $('#traceRemoveBackground').checked,
          detail
        });
      } else {
        next = { svg: await rasterFileToSvg(file) };
      }
      if (mine !== revision) return;
      current = next;
      showResult();
    } catch (error) {
      if (mine !== revision) return;
      current = null;
      showResult();
      showModalError('convertError', error.message || 'Could not convert the selected image.');
    } finally {
      if (mine === revision) setBusy(false);
    }
  };

  const syncMode = () => {
    ui.modal.querySelectorAll('[data-convert]').forEach(option => option.classList.toggle('is-selected', option.dataset.convert === mode));
    $('#traceOptions').hidden = mode !== 'color';
  };
  ui.modal.querySelectorAll('[data-convert]').forEach(option => option.addEventListener('click', () => {
    if (mode === option.dataset.convert) return;
    mode = option.dataset.convert;
    current = null;
    syncMode();
    convert();
  }));
  // Option changes re-trace shortly after the last change.
  ui.modal.querySelectorAll('#traceColors, #traceDetail, #traceRemoveBackground').forEach(control => control.addEventListener('change', () => {
    clearTimeout(retraceTimer);
    retraceTimer = setTimeout(convert, 250);
  }));

  const editPalette = edit => {
    try {
      current = edit(current);
      showResult();
    } catch (error) {
      showModalError('convertError', error.message);
    }
  };
  $('#tracePalette').addEventListener('change', event => {
    const target = event.target;
    if (target.dataset.recolor !== undefined) editPalette(layers => recolorLayer(layers.svg, layers.areas, Number(target.dataset.recolor), target.value));
    else if (target.dataset.merge !== undefined && target.value !== '') editPalette(layers => mergeLayers(layers.svg, layers.areas, Number(target.dataset.merge), Number(target.value)));
  });
  $('#tracePalette').addEventListener('click', event => {
    const button = event.target.closest('[data-remove]');
    if (button) editPalette(layers => removeLayer(layers.svg, layers.areas, Number(button.dataset.remove)));
  });

  $('#confirmConvert').addEventListener('click', async () => {
    if (!current) return;
    const button = $('#confirmConvert');
    button.disabled = true;
    try {
      await saveImageParameter(tool, parameterName, current.svg, mode === 'color' ? current.colors : []);
      toast(mode === 'color'
        ? `Image converted into ${current.colors.length} color layer${current.colors.length === 1 ? '' : 's'}.`
        : 'Icon image added to this tool.');
      closeModal();
      releaseConversionUrls();
    } catch (error) {
      button.disabled = false;
      showModalError('convertError', error.message || 'Could not use the converted image.');
    }
  });

  syncMode();
  convert();
}

// Relief (filament painting): brightness → height map PNG for surface(). Resolution is the
// longest side in pixels; OpenSCAD renders one point per pixel.
const RELIEF_SIDES = { low: 160, medium: 260, high: 360, max: 600 };
// The lithophane generator builds its own mesh, so it takes more pixels than surface().
const LITHOPHANE_IMAGE_PARAMETER = 'lithophane_image_file';
const LITHOPHANE_SIDES = { low: 600, medium: 800, high: 1000, max: 1200 };

function openReliefModal(tool, parameterName, file) {
  releaseConversionUrls();
  const imageType = file.extension === '.png' ? 'image/png' : file.extension === '.webp' ? 'image/webp' : 'image/jpeg';
  const originalUrl = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: imageType }));
  conversionUrls.push(originalUrl);
  const decoded = new Map();
  let current = null;
  let revision = 0;
  const lithophane = parameterName === LITHOPHANE_IMAGE_PARAMETER;
  const sides = lithophane ? LITHOPHANE_SIDES : RELIEF_SIDES;
  const resolutionOptions = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['max', 'Maximum']]
    .map(([value, name]) => `<option value="${value}"${value === (lithophane ? 'high' : 'medium') ? ' selected' : ''}>${name} · ${sides[value]} px</option>`).join('');
  const note = lithophane
    ? 'The preview shows the picture as it looks lit from behind: dark areas print thick. Print in white PLA with 100 % infill, standing upright, at 0.1–0.12 mm layers.'
    : 'Higher resolution shows finer detail but renders more slowly. For filament painting, print with thin layers (0.08 mm) and light filaments on top of dark ones.';
  openModal(lithophane ? 'Prepare lithophane image' : 'Prepare relief', `${file.fileName} · ${lithophane ? 'dark areas become thick, light areas thin' : 'bright areas become high, dark areas stay low'}`, `
    <div class="trace-options relief-options">
      <label class="modal-field"><span>Resolution</span><select id="reliefResolution" class="modal-select">${resolutionOptions}</select></label>
      <label class="modal-field"><span>Mid tones</span><select id="reliefGamma" class="modal-select"><option value="0.6">Much brighter</option><option value="0.8">Brighter</option><option value="1" selected>Neutral</option><option value="1.25">Darker</option><option value="1.6">Much darker</option></select></label>
      <label class="trace-toggle"><input id="reliefLevels" class="toggle" type="checkbox" checked><span>Auto levels</span></label>
      <label class="trace-toggle"><input id="reliefInvert" class="toggle" type="checkbox"><span>Invert</span></label>
    </div>
    <div class="trace-compare">
      <figure><div class="trace-frame"><img src="${originalUrl}" alt="Original image"></div><figcaption>Original</figcaption></figure>
      <figure><div class="trace-frame"><img id="reliefResult" alt="Height map"></div><figcaption id="reliefCaption">Height map</figcaption></figure>
    </div>
    <div class="modal-note">${note}</div>
    <div id="reliefError"></div>
    <div class="modal-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button id="confirmRelief" class="button button-primary" type="button" disabled>Use image</button></div>`, 'modal-trace');

  const update = async () => {
    const mine = ++revision;
    $('#reliefError').innerHTML = '';
    try {
      const side = sides[$('#reliefResolution').value];
      if (!decoded.has(side)) decoded.set(side, await decodeRasterFile(file, side));
      const { width, height, data } = decoded.get(side);
      const map = prepareHeightmap(data, width, height, {
        autoLevels: $('#reliefLevels').checked,
        gamma: Number($('#reliefGamma').value),
        invert: $('#reliefInvert').checked
      });
      if (mine !== revision) return;
      // Show the map as an image (gray in all three channels).
      const canvas = document.createElement('canvas');
      canvas.width = map.width;
      canvas.height = map.height;
      const context = canvas.getContext('2d');
      const image = context.createImageData(map.width, map.height);
      map.gray.forEach((value, index) => image.data.set([value, value, value, 255], index * 4));
      context.putImageData(image, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (mine !== revision) return;
      const url = URL.createObjectURL(blob);
      conversionUrls.push(url);
      $('#reliefResult').src = url;
      $('#reliefCaption').textContent = `${lithophane ? 'Lithophane' : 'Height map'} · ${map.width - 2} × ${map.height - 2} px`;
      current = map;
      $('#confirmRelief').disabled = false;
    } catch (error) {
      if (mine !== revision) return;
      current = null;
      $('#confirmRelief').disabled = true;
      showModalError('reliefError', error.message || 'Could not read the selected image.');
    }
  };
  ui.modal.querySelectorAll('#reliefResolution, #reliefGamma, #reliefLevels, #reliefInvert').forEach(control => control.addEventListener('change', update));
  $('#confirmRelief').addEventListener('click', async () => {
    if (!current) return;
    const button = $('#confirmRelief');
    button.disabled = true;
    try {
      const saved = await window.formforge.saveHeightmapAsset(tool.id, parameterName, encodeGrayPng(current));
      updateParameter(parameterName, saved.reference, null);
      closeModal();
      releaseConversionUrls();
      toast(lithophane ? 'Lithophane image added.' : 'Relief image added to this tool.');
    } catch (error) {
      button.disabled = false;
      showModalError('reliefError', error.message || 'Could not save the relief image.');
    }
  });
  update();
}

// Icon library: SVG packs from the icon folder (see icon-library.cjs), searchable, shown as a grid.
const ICON_PAGE_SIZE = 120;
let iconLibraryUrls = [];
function releaseIconLibraryUrls() {
  iconLibraryUrls.forEach(url => URL.revokeObjectURL(url));
  iconLibraryUrls = [];
}

function packLabel(name) {
  return name === '' ? 'Loose icons' : name;
}

async function openIconLibraryModal(tool, parameterName) {
  if (!['icon_left_file', 'icon_right_file'].includes(parameterName)) return;
  releaseIconLibraryUrls();
  openModal('Icon library', 'Choose an icon from the SVG packs in your icon folder.', `
    <div class="icon-library-controls">
      <select id="iconPack" class="modal-select" aria-label="Icon pack"></select>
      <input id="iconSearch" class="modal-input" type="search" placeholder="Search icons" autocomplete="off">
    </div>
    <div id="iconStatus" class="icon-library-status">Loading icons…</div>
    <div id="iconGrid" class="icon-grid" role="listbox" aria-label="Icons"></div>
    <div id="iconMore" class="icon-library-more" hidden><button class="button button-secondary button-compact" type="button">Show more</button></div>
    <div id="iconError"></div>
    <div class="modal-actions"><button id="openIconFolder" class="button button-secondary" type="button">Open icon folder</button><button id="refreshIcons" class="button button-secondary" type="button">Refresh</button><button class="button button-primary" type="button" data-close>Done</button></div>`, 'modal-icons');

  let index = { packs: [], icons: [] };
  let matches = [];
  let shown = 0;
  let pageRevision = 0;

  const filter = () => {
    const pack = $('#iconPack').value;
    const terms = $('#iconSearch').value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    matches = index.icons.filter(icon => (pack === '*' || icon.pack === pack)
      && terms.every(term => icon.name.toLocaleLowerCase().includes(term) || icon.path.toLocaleLowerCase().includes(term)));
    shown = 0;
    releaseIconLibraryUrls();
    $('#iconGrid').innerHTML = '';
    showPage();
  };

  const showPage = async () => {
    const revision = ++pageRevision;
    const page = matches.slice(shown, shown + ICON_PAGE_SIZE);
    shown += page.length;
    const total = index.icons.length;
    $('#iconStatus').textContent = !total
      ? 'No icon packs yet. Open the icon folder and copy icon packs into it (one folder of SVG files per pack), then refresh.'
      : `${matches.length.toLocaleString()} of ${total.toLocaleString()} icons${index.truncated ? ' (the first 50,000 are listed)' : ''}`;
    $('#iconMore').hidden = shown >= matches.length;
    if (!page.length) return;
    const texts = await window.formforge.readIcons(page.map(({ pack, path }) => ({ pack, path })));
    if (revision !== pageRevision) return;
    const grid = $('#iconGrid');
    page.forEach((icon, offset) => {
      const text = texts[offset];
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'icon-cell';
      cell.title = `${icon.name} · ${packLabel(icon.pack)}/${icon.path}`;
      cell.disabled = !text;
      if (text) {
        const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
        iconLibraryUrls.push(url);
        cell.innerHTML = `<img src="${url}" alt=""><span>${escapeHtml(icon.name)}</span>`;
        cell.addEventListener('click', () => chooseIcon(icon));
      } else cell.innerHTML = `<span>${escapeHtml(icon.name)}</span>`;
      grid.append(cell);
    });
  };

  const chooseIcon = async icon => {
    try {
      const svg = await window.formforge.readIcon(icon.pack, icon.path);
      await saveImageParameter(tool, parameterName, svg, []);
      closeModal();
      releaseIconLibraryUrls();
      toast(`Icon "${icon.name}" added to this tool.`);
    } catch (error) {
      showModalError('iconError', error.message || 'Could not use that icon.');
    }
  };

  const load = async () => {
    try {
      index = await window.formforge.iconIndex();
      const current = $('#iconPack').value || '*';
      $('#iconPack').innerHTML = `<option value="*">All packs (${index.icons.length.toLocaleString()})</option>`
        + index.packs.map(pack => `<option value="${escapeHtml(pack.name)}">${escapeHtml(packLabel(pack.name))} (${pack.count.toLocaleString()})</option>`).join('');
      $('#iconPack').value = [...$('#iconPack').options].some(option => option.value === current) ? current : '*';
      filter();
    } catch (error) {
      $('#iconStatus').textContent = '';
      showModalError('iconError', error.message || 'Could not read the icon folder.');
    }
  };

  let searchTimer = 0;
  $('#iconSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(filter, 150); });
  $('#iconPack').addEventListener('change', filter);
  $('#iconMore button').addEventListener('click', showPage);
  $('#refreshIcons').addEventListener('click', load);
  $('#openIconFolder').addEventListener('click', async () => {
    try { await window.formforge.openIconFolder(); } catch (error) { showModalError('iconError', error.message); }
  });
  $('#iconSearch').focus();
  load();
}

function renderParameters() {
  const tool = activeTool();
  ui.breadcrumbTool.textContent = tool?.name || 'No tool selected';
  ui.breadcrumbCategory.hidden = !tool;
  ui.breadcrumbCategory.textContent = tool ? toolSourceLabel(tool) : '';
  ui.toolMeta.textContent = tool ? [toolSourceLabel(tool), formatDate(tool.createdAt) && `added ${formatDate(tool.createdAt)}`].filter(Boolean).join(' · ') : '';
  for (const control of [ui.addParameterButton, ui.resetParamsButton, ui.savePresetButton, ui.presetSelect, ui.deleteToolButton, ui.exportButton, ui.renderButton]) {
    control.disabled = !tool;
  }
  // The built-in generator cannot be deleted and has a fixed set of parameters.
  if (isGeneratorTool(tool)) {
    ui.deleteToolButton.disabled = true;
    ui.addParameterButton.disabled = true;
  }
  ui.deleteToolButton.title = isGeneratorTool(tool) ? 'The built-in Lithophane generator cannot be deleted' : 'Delete tool';
  if (!tool) {
    ui.parameterCount.textContent = '0';
    ui.parameterList.innerHTML = '<div class="empty-parameters">Add a tool to start adjusting parameters. A tool is one OpenSCAD model — a single <b>.scad</b> file, a project folder, or a link.</div>';
    renderPresetSelect();
    updateParameterHint();
    return;
  }
  const parameters = tool.parameters || [];
  const transformParameters = visibleTransformParameters(tool);
  ui.parameterCount.textContent = String(parameters.length + transformParameters.length);
  const groups = new Map();
  for (const parameter of parameters) {
    const group = parameter.group || 'Parameters';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(parameter);
  }
  const onlyDefaultGroup = groups.size === 1 && groups.has('Parameters');
  // Accordion: one group open at a time, remembered per tool; the first group opens by default.
  const groupNames = [...(onlyDefaultGroup ? [] : groups.keys()), ...(transformEnabled() ? [TRANSFORM_GROUP] : [])];
  const remembered = state.openParameterGroups[tool.id];
  const openGroup = remembered === '' || groupNames.includes(remembered) ? remembered : groupNames[0] || '';
  ui.parameterList.innerHTML = onlyDefaultGroup
    ? parameters.map(parameter => parameterMarkup(parameter, state.values[parameter.name] ?? parameter.default)).join('')
    : groups.size
    ? [...groups.entries()].map(([group, groupParameters]) => `<details class="parameter-group" data-group="${escapeHtml(group)}" ${group === openGroup ? 'open' : ''}>
        <summary class="group-title"><span>${escapeHtml(group)}<span class="group-count">${groupParameters.length}</span></span></summary>
        ${groupParameters.map(parameter => parameterMarkup(parameter, state.values[parameter.name] ?? parameter.default)).join('')}
      </details>`).join('')
    : '<div class="empty-parameters">No parameters were detected in this SCAD file. Use <b>Add custom parameter</b> for a variable the model reads but the parser did not pick up.</div>';
  if (transformEnabled()) ui.parameterList.insertAdjacentHTML('beforeend', transformGroupMarkup(tool, transformParameters, openGroup !== TRANSFORM_GROUP));
  updateParameterHint();
}

// Opening a parameter group closes the others and remembers it for the active tool.
// 'toggle' does not bubble, so it is caught in the capture phase.
function handleParameterGroupToggle(event) {
  const group = event.target;
  if (!(group instanceof HTMLDetailsElement) || !group.classList.contains('parameter-group')) return;
  const toolId = state.activeToolId;
  if (group.open) {
    for (const other of ui.parameterList.querySelectorAll('details.parameter-group[open]')) {
      if (other !== group) other.open = false;
    }
    if (toolId) state.openParameterGroups[toolId] = group.dataset.group;
    group.querySelector('summary')?.scrollIntoView({ block: 'nearest' });
  } else if (toolId && state.openParameterGroups[toolId] === group.dataset.group
    && !ui.parameterList.querySelector('details.parameter-group[open]')) {
    state.openParameterGroups[toolId] = '';
  }
}

const TRANSFORM_KIND_LABELS = { move: 'Move', rotate: 'Rotate', scale: 'Scale' };

// The automatic Transform group: app-owned channels as sliders, plus a note for channels the tool controls.
function transformGroupMarkup(tool, parameters, collapsed) {
  const owners = ownersFor(tool);
  const toolOwned = [];
  for (const [kind, list] of Object.entries(owners)) {
    list.forEach((owner, index) => {
      if (owner.source !== 'tool') return;
      const label = findParameter(tool, owner.name)?.label || owner.name;
      toolOwned.push(owner.uniform ? `${TRANSFORM_KIND_LABELS[kind]} → ${label}` : `${TRANSFORM_KIND_LABELS[kind]} ${AXES[index].toUpperCase()} → ${label}`);
    });
  }
  const notes = [...new Set(toolOwned)];
  if (!parameters.length && !notes.length) return '';
  const description = [
    'Edit here or in the viewport: click the model, then drag the gizmo or press G, R, or S.',
    notes.length ? `Uses this tool's parameters for ${notes.join(', ')}.` : '',
    keepOnPlateActive(tool) ? 'Keep on plate is on, so the model always rests on Z = 0.' : ''
  ].filter(Boolean).join(' ');
  return `<details class="parameter-group" data-group="${escapeHtml(TRANSFORM_GROUP)}" ${collapsed ? '' : 'open'}>
    <summary class="group-title"><span>${escapeHtml(TRANSFORM_GROUP)}<span class="group-count">${parameters.length}</span></span></summary>
    <div class="transform-group-actions"><p class="parameter-description">${escapeHtml(description)}</p>
      <button class="button button-secondary button-compact" type="button" data-transform-reset>Reset</button></div>
    ${parameters.map(parameter => parameterMarkup(parameter, state.values[parameter.name] ?? parameter.default)).join('')}
  </details>`;
}

function updateParameterHint() {
  const tool = activeTool();
  ui.parameterHint.classList.toggle('is-dirty', Boolean(tool && state.dirty));
  if (!tool) ui.parameterHint.textContent = 'Select a tool to get started';
  else if (state.dirty) ui.parameterHint.textContent = state.settings?.autoPreview ? 'Modified · preview updates automatically' : 'Modified · press Render preview to update';
  else ui.parameterHint.textContent = ui.presetSelect.value ? 'Preset values' : 'Default values';
}

function resolvedTheme() {
  const theme = state.settings?.theme || 'light';
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const isDark = resolvedTheme() === 'dark';
  document.body.dataset.theme = isDark ? 'dark' : 'light';
  const background = isDark ? '#1d2622' : '#fafcfb';
  scene.background.set(background);
  renderer.setClearColor(background);
  stylePlates();
  selectionBox.material.color.set(getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#078965');
  updateSelectionVisuals();
}

function exportFolderName() {
  return state.settings?.exportDirectory?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Desktop';
}

function updateAppStatus() {
  ui.engineStatus.classList.toggle('is-ready', state.openscadAvailable);
  ui.engineStatus.innerHTML = `<span></span> ${state.openscadAvailable ? 'Render engine ready' : 'Render engine missing'}`;
  ui.engineStatus.title = state.openscadAvailable
    ? 'Bundled OpenSCAD WebAssembly engine'
    : 'Rebuild the app while connected to the internet to bundle the OpenSCAD engine.';
  ui.exportFolderStatus.textContent = `Export folder: ${exportFolderName()}`;
  ui.exportFolderStatus.title = state.settings?.exportDirectory || 'Desktop';
  const appTitle = state.settings?.appTitle || DEFAULT_APP_TITLE;
  document.title = appTitle;
  ui.appBrandName.textContent = appTitle;
  ui.appVersion.textContent = state.version ? `${DEFAULT_APP_TITLE} ${state.version}` : DEFAULT_APP_TITLE;
  ui.settingsShortcut.textContent = shortcutLabel(',');
  applyTheme();
}

function valuesAreDirty(tool) {
  const initial = state.baselineValues || defaultValues(tool);
  return Object.keys(state.values).some(key => JSON.stringify(initial[key]) !== JSON.stringify(state.values[key]));
}

// render = false for viewport-transform values: the preview applies them directly, OpenSCAD never sees them.
function markValuesChanged(render = true) {
  state.dirty = valuesAreDirty(activeTool());
  updateParameterHint();
  if (!render) return;
  if (state.settings?.autoPreview) queuePreview();
  else if (state.dirty) setRenderState('Changes not previewed', 'pending');
}

function applyValues(tool, values) {
  state.values = withAvailableFont(tool, values);
  state.baselineValues = structuredClone(state.values);
  state.dirty = false;
  renderParameters();
}

// Generator tools (lithophane) build their mesh in JavaScript and do not need OpenSCAD.
function canRender(tool) {
  return state.openscadAvailable || tool?.kind === 'generator';
}

function showIdleEmptyState(tool) {
  if (!state.tools.length) {
    setEmptyState('Add your first tool', 'Each tool is an OpenSCAD model with adjustable parameters. Import a .scad file, a project folder, or a direct link.', [{ id: 'add-tool', label: 'Add tool', primary: true }]);
  } else if (!tool) {
    setEmptyState('No tool selected', 'Choose a tool from the library.');
  } else if (!canRender(tool)) {
    setEmptyState('Render engine missing', 'The bundled OpenSCAD WebAssembly engine was not found. Rebuild the app while connected to the internet.');
  } else {
    setEmptyState('Ready to preview', `Render ${tool.name} to see the model.`, [{ id: 'render', label: 'Render preview', primary: true }]);
  }
}

function resetPreview(tool) {
  state.renderRevision++;
  state.rendering = false;
  clearTimeout(state.renderTimer);
  cancelTransformSession();
  clearMesh();
  setSelected(false);
  hideNotice();
  ui.viewport.classList.remove('is-busy');
  state.meshFramed = false;
  controls.target.set(0, 0, 15);
  camera.position.set(115, -150, 115);
  controls.update();
  setRenderState(tool ? 'Not rendered' : 'Ready', 'idle');
  showIdleEmptyState(tool);
}

function finishRender(revision) {
  if (revision !== state.renderRevision) return;
  state.rendering = false;
  ui.viewport.classList.remove('is-busy');
  ui.renderButton.disabled = !activeTool();
}

async function generatePreview() {
  const tool = activeTool();
  if (!tool) {
    toast('Select or add a tool first.', true);
    return;
  }
  if (!canRender(tool)) {
    setRenderState('Engine missing', 'error');
    showIdleEmptyState(tool);
    return;
  }

  clearTimeout(state.renderTimer);
  const revision = ++state.renderRevision;
  const toolId = tool.id;
  const startedAt = performance.now();
  state.rendering = true;
  hideNotice();
  // Keep the previous mesh visible while the new one renders; only show the busy state when there is nothing to look at.
  if (state.mesh) ui.viewport.classList.add('is-busy');
  else setEmptyState('Rendering…', 'OpenSCAD is calculating the model geometry.', [], true);
  setRenderState('Rendering…', 'rendering');
  setStatus(`Rendering ${tool.name}…`);
  try {
    const result = await window.formforge.render(tool.id, { ...state.values });
    if (revision !== state.renderRevision || toolId !== state.activeToolId) return;
    const bytes = result.mesh?.data ? Uint8Array.from(result.mesh.data) : new Uint8Array(result.mesh);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const model = new ThreeMFLoader().parse(data);
    const meshes = [];
    model.traverse(object => {
      if (object.isMesh) meshes.push(object);
    });
    if (!meshes.some(mesh => mesh.geometry.attributes.position?.count)) {
      throw new Error('The model produced no geometry. Check the parameter values and make sure the SCAD file generates a 3D object.');
    }
    cancelTransformSession();
    clearMesh();
    state.mesh = model;
    state.items = Array.isArray(result.items) ? result.items : [];
    state.plates = Number.isInteger(result.plates) ? result.plates : null;
    if (state.activeItemId && !activeItem()) state.activeItemId = '';
    scene.add(model);
    placeOnPlate(model);
    applyModelTransform();
    updateSelectionVisuals();
    if (!state.meshFramed) {
      focusObject();
      state.meshFramed = true;
    }
    ui.emptyState.hidden = true;
    const triangles = meshes.reduce((sum, mesh) => sum + (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3, 0);
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    updateMeshSize();
    ui.triangleCount.textContent = `${Math.round(triangles).toLocaleString()} triangles`;
    ui.renderTime.textContent = `Rendered in ${seconds} s`;
    setRenderState('Up to date');
    setStatus(`Preview updated · ${tool.name}`);
  } catch (error) {
    if (revision !== state.renderRevision || toolId !== state.activeToolId) return;
    setRenderState('Render failed', 'error');
    setStatus('Render failed · see the message in the preview', true);
    if (!state.mesh) setEmptyState('Could not render this model', 'Fix the issue shown above, then render again.', [{ id: 'render', label: 'Try again' }]);
    showNotice(state.mesh ? 'Render failed · showing the last successful preview' : 'Render failed', error.message || 'OpenSCAD could not render this model.');
  } finally {
    finishRender(revision);
  }
}

function queuePreview() {
  if (!state.settings?.autoPreview || !activeTool() || !canRender(activeTool())) return;
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(generatePreview, state.settings.previewDelay || 700);
  setRenderState('Waiting for changes…', 'pending');
}

// Records the untransformed bounds; applyModelTransform() then centers the model on the plate in X/Y and rests it
// on Z = 0 (matching how it will be printed), plus any viewport transform.
function placeOnPlate(model) {
  model.position.set(0, 0, 0);
  model.matrixAutoUpdate = false;
  model.matrix.identity();
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true);
  state.meshBounds = { min: bounds.min.toArray(), max: bounds.max.toArray() };
}

function updateMeshSize() {
  if (!state.mesh) return;
  const size = new THREE.Box3().setFromObject(state.mesh, true).getSize(new THREE.Vector3());
  ui.meshSize.textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`;
}

// --- Viewport transform: preview ----------------------------------------------------------------------------

function setModelMatrix(rowMajor) {
  state.mesh.matrix.fromArray(toColumnMajor(rowMajor));
  state.mesh.updateMatrixWorld(true);
}

function boundsCenter() {
  const { min, max } = state.meshBounds;
  return AXES.map((_, index) => (min[index] + max[index]) / 2);
}

// Matrix for a transform, resting on the plate when Keep on plate applies (same steps as export).
function settledMatrix(transform, tool = activeTool()) {
  const keep = keptAxes(tool);
  let dropZ = 0;
  if (keepOnPlateActive(tool)) {
    setModelMatrix(transformMatrix(state.meshBounds, { ...transform, move: [0, 0, 0] }, keep));
    dropZ = -new THREE.Box3().setFromObject(state.mesh, true).min.z;
  }
  return transformMatrix(state.meshBounds, transform, keep, dropZ);
}

function applyModelTransform() {
  if (!state.mesh || !state.meshBounds) return;
  const transform = currentAppTransform();
  const matrix = settledMatrix(transform);
  setModelMatrix(matrix);
  // Proxy = pivot (bounds center) in plate space, with the same rotation and scale.
  transformProxy.position.fromArray(transformPoint(matrix, ...boundsCenter()));
  transformProxy.quaternion.setFromEuler(new THREE.Euler(...transform.rotate.map(THREE.MathUtils.degToRad), 'ZYX'));
  transformProxy.scale.fromArray(transform.scale);
  transformProxy.updateMatrixWorld(true);
  placeItemProxy();
  updateMeshSize();
  updatePlates();
}

// --- Movable items -------------------------------------------------------------------------------------------

function activeItem() {
  return state.activeItemId ? state.items.find(item => item.id === state.activeItemId) || null : null;
}

// Puts the item proxy on the active item's center, turned by the item's rotation, in plate space.
function placeItemProxy() {
  const item = activeItem();
  if (!item || !state.mesh) return;
  const meshQuaternion = new THREE.Quaternion();
  state.mesh.matrixWorld.decompose(new THREE.Vector3(), meshQuaternion, new THREE.Vector3());
  itemProxy.position.fromArray(item.center).applyMatrix4(state.mesh.matrixWorld);
  itemProxy.quaternion.copy(meshQuaternion).multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_VECTORS.z, THREE.MathUtils.degToRad(item.rotation)));
  itemProxy.scale.set(1, 1, 1);
  itemProxy.updateMatrixWorld(true);
}

// The smallest item whose footprint contains a point on the model (plate space), or null.
function itemAt(worldPoint) {
  if (!state.items.length || !state.mesh) return null;
  const local = worldPoint.clone().applyMatrix4(state.mesh.matrixWorld.clone().invert());
  const tool = activeTool();
  let best = null;
  for (const item of state.items) {
    if (!itemTarget(item.id, toolParameters(tool))) continue;
    const radians = THREE.MathUtils.degToRad(-item.rotation);
    const dx = local.x - item.center[0];
    const dy = local.y - item.center[1];
    const u = dx * Math.cos(radians) - dy * Math.sin(radians);
    const v = dx * Math.sin(radians) + dy * Math.cos(radians);
    // Items lie on a surface: ignore hits far below their top (e.g. the side of the body under them).
    if (Math.abs(u) > item.size[0] / 2 + 1 || Math.abs(v) > item.size[1] / 2 + 1 || local.z < item.center[2] - 8) continue;
    if (!best || item.size[0] * item.size[1] < best.size[0] * best.size[1]) best = item;
  }
  return best;
}

function itemLabel(item) {
  const [prefix, path] = item.id.split(':');
  if (path !== undefined) return `Element ${path.split('.').map(part => Number(part) + 1).join(' › ')}`;
  return prefix.replace(/_/g, ' ').replace(/^./, character => character.toUpperCase());
}

// Sum of the ancestors' rotation for a nested element (children are placed in their parent's frame).
function nestedParentRotation(tree, path) {
  let rotation = 0;
  let list = tree;
  for (const index of path.slice(0, -1)) {
    const node = list?.[index];
    rotation += Number(node?.rotation) || 0;
    list = node?.children;
  }
  return rotation;
}

// Writes a finished item drag into the item's parameters (or nested element) and renders again.
function commitItemTransform(session) {
  const tool = activeTool();
  const item = activeItem();
  const target = item && tool ? itemTarget(item.id, toolParameters(tool)) : null;
  if (!target || !state.mesh) return;
  const inverse = state.mesh.matrixWorld.clone().invert();
  const start = session.startPosition.clone().applyMatrix4(inverse);
  const end = itemProxy.position.clone().applyMatrix4(inverse);
  const delta = [end.x - start.x, end.y - start.y];
  const turn = new THREE.Euler().setFromQuaternion(itemProxy.quaternion.clone().multiply(session.startQuaternion.clone().invert()), 'ZYX');
  const angle = THREE.MathUtils.radToDeg(turn.z);
  const ratios = [itemProxy.scale.x / session.startScale.x, itemProxy.scale.y / session.startScale.y];
  const factor = Math.abs(Math.log(ratios[0])) >= Math.abs(Math.log(ratios[1])) ? ratios[0] : ratios[1];
  const moved = Math.hypot(...delta) > 1e-3;
  const turned = Math.abs(angle) > 1e-3;
  const scaled = Math.abs(Math.log(factor)) > 1e-4;
  if (!moved && !turned && !scaled) return;
  const changed = [];
  if (target.kind === 'parameters') {
    const write = (name, compute) => {
      const parameter = name ? findParameter(tool, name) : null;
      if (!parameter) return;
      state.values[name] = clampToParameter(parameter, compute(Number(state.values[name] ?? parameter.default)));
      changed.push(name);
    };
    if (moved) {
      write(target.x, value => value + delta[0]);
      write(target.y, value => value + delta[1]);
    }
    if (turned) write(target.rotate, value => wrapDegrees(value + angle));
    if (scaled) write(target.size, value => value * factor);
    syncParameterInputs(changed);
    if (!changed.length) return;
    markValuesChanged(true);
    setStatus(`Updated ${changed.map(name => findParameter(tool, name)?.label || name).join(', ')}`);
    return;
  }
  const tree = structuredClone(state.values[target.tree]);
  let node = null;
  let list = tree;
  for (const index of target.path) {
    node = list?.[index];
    list = node?.children;
  }
  if (!node) return;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, roundTo(value, 0.1)));
  if (moved) {
    // Plate-space delta → the parent's (rotated) frame.
    const radians = THREE.MathUtils.degToRad(-nestedParentRotation(tree, target.path));
    node.x = clamp(Number(node.x) + delta[0] * Math.cos(radians) - delta[1] * Math.sin(radians), -128, 128);
    node.y = clamp(Number(node.y) + delta[0] * Math.sin(radians) + delta[1] * Math.cos(radians), -128, 128);
  }
  if (turned) node.rotation = clamp(wrapDegrees((Number(node.rotation) || 0) + angle), -180, 180);
  if (scaled) node.size = clamp(Number(node.size) * factor, 1, 210);
  state.values[target.tree] = tree;
  renderParameters();
  markValuesChanged(true);
  setStatus(`Updated ${itemLabel(item)}`);
}

// While dragging, the model follows the proxy directly: M = T(pivot) · R · S · T(−center).
function previewProxy() {
  if (!state.mesh || !state.meshBounds || state.transformSession?.item) return;
  const [cx, cy, cz] = boundsCenter();
  const matrix = new THREE.Matrix4().compose(transformProxy.position, transformProxy.quaternion, transformProxy.scale)
    .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, -cz));
  state.mesh.matrix.copy(matrix);
  state.mesh.updateMatrixWorld(true);
}

const MODE_LABELS = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' };
const SHORTCUT_MODES = { g: 'translate', r: 'rotate', s: 'scale' };

function roundTo(value, step) {
  const decimals = Math.max(0, (String(step).split('.')[1] || '').length);
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

function wrapDegrees(value) {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}

function clampToParameter(parameter, value) {
  let next = value;
  if (Number(parameter.step) > 0) next = roundTo(next, Number(parameter.step));
  if (Number.isFinite(Number(parameter.min))) next = Math.max(Number(parameter.min), next);
  if (Number.isFinite(Number(parameter.max))) next = Math.min(Number(parameter.max), next);
  return next;
}

// Reads the proxy back into { move, rotate, scale } in the same plate space as currentAppTransform().
function transformFromProxy() {
  const tool = activeTool();
  const euler = new THREE.Euler().setFromQuaternion(transformProxy.quaternion, 'ZYX');
  const rotate = [euler.x, euler.y, euler.z].map(radians => wrapDegrees(THREE.MathUtils.radToDeg(radians)));
  const scale = transformProxy.scale.toArray().map(value => Math.max(0.01, Math.abs(value)));
  const settled = settledMatrix({ move: [0, 0, 0], rotate, scale }, tool);
  const pivot = transformPoint(settled, ...boundsCenter());
  const move = transformProxy.position.toArray().map((value, index) => value - pivot[index]);
  if (keepOnPlateActive(tool)) move[2] = 0;
  return { move, rotate, scale };
}

// Writes a finished drag into parameters: app channels into the Transform group (no render needed),
// tool channels into the tool's own parameters as a delta (re-render).
function commitTransform(start, next) {
  const tool = activeTool();
  if (!tool) return;
  const owners = ownersFor(tool);
  const changedTool = new Map();
  for (const kind of ['move', 'rotate', 'scale']) {
    owners[kind].forEach((owner, index) => {
      const before = start[kind][index];
      const after = next[kind][index];
      if (owner.source === 'app') {
        const limits = APP_LIMITS[kind];
        const value = kind === 'scale' ? after * 100 : after;
        state.values[owner.name] = Math.min(limits.max, Math.max(limits.min, roundTo(value, kind === 'move' ? 0.01 : 0.1)));
        return;
      }
      const changed = kind === 'scale' ? Math.abs(Math.log(after / before)) > 1e-4 : Math.abs(after - before) > 1e-4;
      if (!changed) return;
      const parameter = findParameter(tool, owner.name);
      if (!parameter) return;
      // A uniform tool scale follows the axis that changed the most.
      if (owner.uniform && changedTool.has(owner.name) && Math.abs(Math.log(changedTool.get(owner.name).ratio)) >= Math.abs(Math.log(after / before))) return;
      const current = Number(state.values[owner.name] ?? parameter.default);
      const value = kind === 'scale' ? current * (after / before) : current + (after - before);
      changedTool.set(owner.name, { parameter, value: clampToParameter(parameter, value), ratio: after / before });
    });
  }
  for (const [name, { value }] of changedTool) state.values[name] = value;
  syncParameterInputs([...toolParameters(tool).filter(parameter => parameter.appTransform).map(parameter => parameter.name), ...changedTool.keys()]);
  if (changedTool.size) {
    // The model keeps the dragged pose until OpenSCAD returns the re-rendered mesh.
    previewProxy();
    markValuesChanged(true);
    setStatus(`Updated ${[...changedTool.values()].map(item => item.parameter.label || item.parameter.name).join(', ')}`);
  } else {
    applyModelTransform();
    markValuesChanged(false);
  }
}

function syncParameterInputs(names) {
  for (const name of names) {
    const value = state.values[name];
    document.querySelectorAll(`[data-param="${CSS.escape(name)}"]`).forEach(input => {
      if (input.type !== 'checkbox') input.value = String(value);
      input.setAttribute('aria-invalid', 'false');
    });
  }
}

function resetTransform() {
  const tool = activeTool();
  if (!tool) return;
  const names = appTransformParameters(ownersFor(tool)).map(parameter => {
    state.values[parameter.name] = parameter.default;
    return parameter.name;
  });
  syncParameterInputs(names);
  applyModelTransform();
  markValuesChanged(false);
}

// --- Viewport transform: active object, gizmo, shortcuts -----------------------------------------------------

function canTransform() {
  return transformEnabled() && Boolean(state.mesh && state.meshBounds && activeTool());
}

// itemId: '' selects the whole model, otherwise one of state.items.
function setSelected(selected, itemId = '') {
  if (state.transformSession && (state.activeItemId !== itemId || !selected)) cancelTransformSession();
  state.selected = Boolean(selected) && canTransform();
  state.activeItemId = state.selected ? itemId : '';
  placeItemProxy();
  updateSelectionVisuals();
}

function updateSelectionVisuals() {
  const enabled = transformEnabled();
  const active = state.selected && canTransform();
  if (!active && state.transformSession) cancelTransformSession();
  const item = active ? activeItem() : null;
  selectionBox.visible = active && !item;
  itemOutline.visible = Boolean(item);
  const proxy = item ? itemProxy : transformProxy;
  const showGizmo = active && state.settings?.transformGizmo !== false && state.transformSession?.kind !== 'modal';
  if (showGizmo && gizmo.object !== proxy) gizmo.attach(proxy);
  else if (!showGizmo && gizmo.object) gizmo.detach();
  gizmo.enabled = showGizmo;
  gizmo.setMode(state.transformMode);
  gizmo.setSize(Number(state.settings?.gizmoSize) || 1);
  // Items stay on their surface and turn about Z only; with Keep on plate, model Z moves are locked unless
  // the tool owns Move Z.
  gizmo.showX = !(item && state.transformMode === 'rotate');
  gizmo.showY = !(item && state.transformMode === 'rotate');
  gizmo.showZ = item ? state.transformMode === 'rotate' : !(state.transformMode === 'translate' && keepOnPlateActive());
  ui.activeObjectChip.hidden = !active;
  ui.activeObjectName.textContent = item ? itemLabel(item) : activeTool()?.name || '';
  ui.transformTools.hidden = !enabled;
  ui.transformDivider.hidden = !enabled;
  ui.transformTools.querySelectorAll('[data-transform-mode]').forEach(button => {
    const selected = button.dataset.transformMode === state.transformMode;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = !canTransform();
  });
  const shortcuts = enabled && state.settings?.transformShortcuts !== false;
  ui.gridButton.title = shortcuts ? 'Show grid (Shift+G)' : 'Show grid (G)';
  ui.viewHelp.innerHTML = enabled
    ? '<kbd>Click</kbd> Select <kbd>Middle drag</kbd> Orbit <kbd>Shift + middle drag</kbd> Pan <kbd>Scroll</kbd> Zoom' + (shortcuts ? ' <kbd>G R S</kbd> Transform' : '')
    : '<kbd>Middle drag</kbd> Orbit <kbd>Shift + middle drag</kbd> Pan <kbd>Scroll</kbd> Zoom';
}

function setTransformMode(mode) {
  if (!MODE_LABELS[mode]) return;
  state.transformMode = mode;
  updateSelectionVisuals();
}

function applySnapping(active) {
  const settings = state.settings || {};
  gizmo.setTranslationSnap(active ? Number(settings.snapMove) || 1 : null);
  gizmo.setRotationSnap(active ? THREE.MathUtils.degToRad(Number(settings.snapRotate) || 15) : null);
  gizmo.setScaleSnap(active ? (Number(settings.snapScale) || 10) / 100 : null);
}

function beginTransformSession(kind, mode) {
  const tool = activeTool();
  const item = Boolean(activeItem());
  const proxy = item ? itemProxy : transformProxy;
  state.transformSession = {
    kind,
    mode,
    item,
    proxy,
    axis: null,
    numeric: '',
    startTransform: currentAppTransform(tool),
    startPosition: proxy.position.clone(),
    startQuaternion: proxy.quaternion.clone(),
    startScale: proxy.scale.clone(),
    startPointer: { ...lastPointer },
    lastAngle: null,
    angle: 0
  };
}

function restoreProxyStart(session) {
  session.proxy.position.copy(session.startPosition);
  session.proxy.quaternion.copy(session.startQuaternion);
  session.proxy.scale.copy(session.startScale);
}

function finishTransformSession() {
  const session = state.transformSession;
  if (!session) return;
  state.transformSession = null;
  ui.transformHud.hidden = true;
  controls.enabled = true;
  // An item keeps its dragged outline until OpenSCAD returns the re-rendered mesh.
  if (session.item) commitItemTransform(session);
  else commitTransform(session.startTransform, transformFromProxy());
  updateSelectionVisuals();
}

function cancelTransformSession() {
  const session = state.transformSession;
  if (!session) return;
  state.transformSession = null;
  ui.transformHud.hidden = true;
  controls.enabled = true;
  restoreProxyStart(session);
  if (state.mesh && !session.item) applyModelTransform();
  updateSelectionVisuals();
}

gizmo.addEventListener('dragging-changed', event => {
  controls.enabled = !event.value;
  if (event.value) beginTransformSession('gizmo', gizmo.mode);
  else if (state.transformSession?.kind === 'gizmo') finishTransformSession();
});
gizmo.addEventListener('objectChange', () => {
  if (state.transformSession?.kind === 'gizmo') previewProxy();
});

// Pointer tracking for selection and shortcut (modal) transforms.
const lastPointer = { x: 0, y: 0, inside: false };
const raycaster = new THREE.Raycaster();

function pointerNdc(point) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((point.x - rect.left) / rect.width) * 2 - 1, -((point.y - rect.top) / rect.height) * 2 + 1);
}

function toScreen(position) {
  const rect = renderer.domElement.getBoundingClientRect();
  const projected = position.clone().project(camera);
  return { x: rect.left + (projected.x + 1) / 2 * rect.width, y: rect.top + (1 - projected.y) / 2 * rect.height };
}

// The nearest model surface point under the pointer (plate space), or null.
function pickModel(point) {
  if (!state.mesh) return null;
  raycaster.setFromCamera(pointerNdc(point), camera);
  return raycaster.intersectObject(state.mesh, true)[0]?.point || null;
}

const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

function startShortcutTransform(mode) {
  if (!canTransform()) return;
  setTransformMode(mode);
  setSelected(true, state.activeItemId);
  if (state.settings?.transformShortcutMode === 'gizmo') return;
  if (state.transformSession) cancelTransformSession();
  if (!lastPointer.inside) {
    const rect = renderer.domElement.getBoundingClientRect();
    Object.assign(lastPointer, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }
  beginTransformSession('modal', mode);
  controls.enabled = false;
  updateSelectionVisuals();
  updateModalTransform(false);
}

function intersectDragPlane(point, origin, normal) {
  raycaster.setFromCamera(pointerNdc(point), camera);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
  return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
}

function updateModalTransform(snap) {
  const session = state.transformSession;
  if (!session || session.kind !== 'modal') return;
  restoreProxyStart(session);
  const settings = state.settings || {};
  const numeric = session.numeric !== '' && session.numeric !== '-' ? Number(session.numeric) : null;
  const proxy = session.proxy;
  // Items move on their surface, turn about Z, and scale uniformly.
  if (session.item && (session.mode === 'rotate' ? session.axis !== 'z' : session.axis === 'z' || session.mode === 'scale')) session.axis = null;
  const zLocked = session.item || keepOnPlateActive();
  const axisVector = session.axis ? AXIS_VECTORS[session.axis] : null;
  let readout = '';
  if (session.mode === 'translate') {
    const delta = new THREE.Vector3();
    if (Number.isFinite(numeric)) {
      delta.copy(axisVector || AXIS_VECTORS.x).multiplyScalar(numeric);
    } else {
      const viewDirection = camera.getWorldDirection(new THREE.Vector3());
      let normal = zLocked && !axisVector ? AXIS_VECTORS.z.clone() : viewDirection.clone();
      if (axisVector) {
        normal = viewDirection.clone().sub(axisVector.clone().multiplyScalar(viewDirection.dot(axisVector)));
        if (normal.lengthSq() < 1e-6) normal = viewDirection.clone();
        normal.normalize();
      }
      const from = intersectDragPlane(session.startPointer, session.startPosition, normal);
      const to = intersectDragPlane(lastPointer, session.startPosition, normal);
      if (from && to) delta.subVectors(to, from);
      if (axisVector) delta.copy(axisVector).multiplyScalar(delta.dot(axisVector));
      if (snap) {
        const step = Number(settings.snapMove) || 1;
        delta.set(roundTo(delta.x, step), roundTo(delta.y, step), roundTo(delta.z, step));
      }
    }
    if (zLocked) delta.z = 0;
    proxy.position.add(delta);
    readout = `${delta.x.toFixed(2)}, ${delta.y.toFixed(2)}, ${delta.z.toFixed(2)} mm${zLocked && !session.item && session.axis === 'z' ? ' · Z locked by Keep on plate' : ''}`;
  } else if (session.mode === 'rotate') {
    const axis = axisVector || AXIS_VECTORS.z;
    let degrees;
    if (Number.isFinite(numeric)) degrees = numeric;
    else {
      const center = toScreen(session.startPosition);
      const angle = Math.atan2(lastPointer.y - center.y, lastPointer.x - center.x);
      if (session.lastAngle !== null) {
        let step = angle - session.lastAngle;
        if (step > Math.PI) step -= Math.PI * 2;
        if (step < -Math.PI) step += Math.PI * 2;
        session.angle += step;
      }
      session.lastAngle = angle;
      // Screen Y points down: dragging counter-clockwise rotates counter-clockwise as seen from the camera.
      const facing = camera.getWorldDirection(new THREE.Vector3()).dot(axis) < 0 ? -1 : 1;
      degrees = THREE.MathUtils.radToDeg(session.angle) * facing;
      if (snap) degrees = roundTo(degrees, Number(settings.snapRotate) || 15);
    }
    proxy.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees)));
    readout = `${degrees.toFixed(1)}° around ${(session.axis || 'z').toUpperCase()}`;
  } else {
    let factor;
    if (Number.isFinite(numeric)) factor = numeric;
    else {
      const center = toScreen(session.startPosition);
      const startDistance = Math.max(8, Math.hypot(session.startPointer.x - center.x, session.startPointer.y - center.y));
      factor = Math.hypot(lastPointer.x - center.x, lastPointer.y - center.y) / startDistance;
      if (snap) factor = roundTo(factor, (Number(settings.snapScale) || 10) / 100);
    }
    factor = Math.max(0.01, factor);
    if (session.axis) proxy.scale.setComponent('xyz'.indexOf(session.axis), session.startScale.getComponent('xyz'.indexOf(session.axis)) * factor);
    else proxy.scale.multiplyScalar(factor);
    readout = `× ${factor.toFixed(3)}${session.axis ? ` on ${session.axis.toUpperCase()}` : ''}`;
  }
  previewProxy();
  ui.transformHud.hidden = false;
  ui.transformHud.innerHTML = `<strong>${MODE_LABELS[session.mode]}${session.item ? ` · ${escapeHtml(itemLabel(activeItem() || { id: '' }))}` : ''}</strong><span>${escapeHtml(readout)}</span>`
    + (session.numeric ? `<span>Typed: ${escapeHtml(session.numeric)}</span>` : '')
    + '<span class="hud-hint">X Y Z axis · Ctrl snap · type a value · Click or Enter to apply · Esc or right-click to cancel</span>';
}

// Keys while a shortcut transform runs. Returns true when the key was used.
function handleModalTransformKey(event) {
  const session = state.transformSession;
  if (!session || session.kind !== 'modal') return false;
  const key = event.key.toLowerCase();
  if (key === 'escape') cancelTransformSession();
  else if (key === 'enter') finishTransformSession();
  else if (['x', 'y', 'z'].includes(key)) {
    session.axis = session.axis === key ? null : key;
    updateModalTransform(event.ctrlKey || event.metaKey);
  } else if (/^[0-9.]$/.test(key) || key === '-' || key === 'backspace') {
    if (key === 'backspace') session.numeric = session.numeric.slice(0, -1);
    else if (key === '-') session.numeric = session.numeric.startsWith('-') ? session.numeric.slice(1) : `-${session.numeric}`;
    else if (!(key === '.' && session.numeric.includes('.'))) session.numeric += key;
    updateModalTransform(false);
  } else if (SHORTCUT_MODES[key] && !event.ctrlKey && !event.metaKey) {
    // Pressing another transform key switches the operation, like Blender.
    cancelTransformSession();
    startShortcutTransform(SHORTCUT_MODES[key]);
  } else return false;
  event.preventDefault();
  return true;
}

window.addEventListener('pointermove', event => {
  const rect = ui.viewport.getBoundingClientRect();
  lastPointer.x = event.clientX;
  lastPointer.y = event.clientY;
  lastPointer.inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (state.transformSession?.kind === 'modal') updateModalTransform(event.ctrlKey || event.metaKey);
});

// Capture phase: a shortcut transform consumes the click before OrbitControls / the gizmo see it.
let pointerDownAt = null;
ui.viewport.addEventListener('pointerdown', event => {
  if (state.transformSession?.kind === 'modal') {
    // The click that applies or cancels a shortcut transform must not also select what is under it.
    pointerDownAt = null;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 0) finishTransformSession();
    else if (event.button === 2) cancelTransformSession();
    return;
  }
  pointerDownAt = event.button === 0 && event.target === renderer.domElement
    ? { x: event.clientX, y: event.clientY, onGizmo: gizmo.enabled && gizmo.axis !== null }
    : null;
}, true);
ui.viewport.addEventListener('pointerup', event => {
  const start = pointerDownAt;
  pointerDownAt = null;
  if (!start || event.button !== 0 || start.onGizmo || gizmo.dragging || !transformEnabled()) return;
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
  // A click on a movable item makes that item active; anywhere else on the model selects the whole model.
  const hit = pickModel({ x: event.clientX, y: event.clientY });
  setSelected(Boolean(hit), hit ? itemAt(hit)?.id || '' : '');
});
ui.viewport.addEventListener('contextmenu', event => {
  if (state.transformSession) event.preventDefault();
});
ui.transformTools.addEventListener('click', event => {
  const button = event.target.closest('[data-transform-mode]');
  if (!button || button.disabled) return;
  setTransformMode(button.dataset.transformMode);
  setSelected(true, state.activeItemId);
});
const snapKey = event => {
  if (event.key !== 'Control' && event.key !== 'Meta') return;
  const active = event.type === 'keydown';
  applySnapping(active);
  if (state.transformSession?.kind === 'modal') updateModalTransform(active);
};
window.addEventListener('keydown', snapKey);
window.addEventListener('keyup', snapKey);
window.addEventListener('blur', () => applySnapping(false));

// Distance that fits the model's largest dimension in the 38° field of view with some margin.
function viewDistance() {
  if (!state.mesh) return 160;
  const size = new THREE.Box3().setFromObject(state.mesh).getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z, 10) * 1.9;
}

const ISO_DIRECTION = new THREE.Vector3(1.1, -1.3, 0.95).normalize();

function focusObject() {
  if (!state.mesh) {
    controls.target.set(0, 0, 15);
    controls.update();
    return;
  }
  const bounds = new THREE.Box3().setFromObject(state.mesh);
  const center = bounds.getCenter(new THREE.Vector3());
  const distance = viewDistance();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(ISO_DIRECTION, distance);
  camera.near = Math.max(0.1, distance / 1000);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.update();
  document.querySelectorAll('.view-tab').forEach(tab => tab.classList.toggle('is-active', tab.dataset.view === 'iso'));
}

function setCameraView(view) {
  const distance = viewDistance();
  const target = state.mesh ? new THREE.Box3().setFromObject(state.mesh).getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const offsets = {
    iso: ISO_DIRECTION.clone().multiplyScalar(distance).toArray(),
    front: [0, -distance, 0],
    top: [0, -0.001, distance],
    right: [distance, 0, 0]
  };
  const [x, y, z] = offsets[view];
  controls.target.copy(target);
  camera.position.set(target.x + x, target.y + y, target.z + z);
  controls.update();
  document.querySelectorAll('.view-tab').forEach(tab => tab.classList.toggle('is-active', tab.dataset.view === view));
}

function switchTool(toolId, force = false) {
  if (toolId === state.activeToolId && !force) return true;
  const current = activeTool();
  if (!force && current && state.dirty && !confirm('You have unsaved parameter changes. Switch tools and discard them?')) {
    if (!isGeneratorTool(current)) ui.toolSelect.value = state.activeToolId;
    else if (state.lastScadToolId) ui.toolSelect.value = state.lastScadToolId;
    updateModeSwitch();
    return false;
  }
  clearTimeout(state.renderTimer);
  state.activeToolId = toolId;
  const tool = activeTool();
  // The dropdown keeps showing the last SCAD tool while the generator is active.
  if (tool && !isGeneratorTool(tool)) state.lastScadToolId = toolId;
  if (!isGeneratorTool(tool)) ui.toolSelect.value = toolId;
  updateModeSwitch();
  ui.presetSelect.value = '';
  ui.parameterList.replaceChildren();
  applyValues(tool, defaultValues(tool));
  renderPresetSelect();
  updateParameterHint();
  resetPreview(tool);
  queuePreview();
  return true;
}

function openModal(title, subtitle, body, className = '') {
  ui.modal.className = `modal ${className}`.trim();
  ui.modal.innerHTML = `
    <div class="modal-header">
      <div><h2 id="modalTitle">${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>
      <button class="icon-button modal-close" data-close type="button" aria-label="Close dialog"><svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
    </div>${body}`;
  ui.modalLayer.hidden = false;
  ui.modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', closeModal));
  (ui.modal.querySelector('[autofocus]') || ui.modal.querySelector('input,select,button:not([data-close])'))?.focus();
}

function closeModal() {
  ui.modalLayer.hidden = true;
  ui.modal.innerHTML = '';
}

function showModalError(containerId, message) {
  const container = ui.modal.querySelector(`#${containerId}`);
  if (container) container.innerHTML = `<div class="modal-error">${escapeHtml(cleanErrorMessage(message))}</div>`;
}

ui.modalLayer.addEventListener('click', event => {
  if (event.target === ui.modalLayer) closeModal();
});

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

window.addEventListener('keydown', event => {
  const modifier = event.ctrlKey || event.metaKey;
  if (ui.modalLayer.hidden && handleModalTransformKey(event)) return;
  if (event.key === 'Escape') {
    if (!ui.modalLayer.hidden) closeModal();
    else if (state.selected && !isTypingTarget(event.target)) setSelected(false);
    return;
  }
  if (!ui.modalLayer.hidden) return;
  if (modifier && event.key === ',') { event.preventDefault(); openSettings(); }
  else if (modifier && event.key === 'Enter') { event.preventDefault(); generatePreview(); }
  else if (modifier && event.key.toLowerCase() === 'e') { event.preventDefault(); openExportModal(); }
  else if (modifier && event.key.toLowerCase() === 'o') { event.preventDefault(); openAddToolModal(); }
  else if (!modifier && !event.altKey && !isTypingTarget(event.target)) {
    const key = event.key.toLowerCase();
    // G/R/S transform the active object; the grid toggle moves to Shift+G while these shortcuts are on.
    const shortcuts = transformEnabled() && state.settings?.transformShortcuts !== false;
    if (key === 'f') focusObject();
    else if (key === 'g' && (!shortcuts || event.shiftKey)) toggleGrid();
    else if (shortcuts && !event.shiftKey && SHORTCUT_MODES[key] && canTransform()) {
      event.preventDefault();
      startShortcutTransform(SHORTCUT_MODES[key]);
    }
  }
});

function toast(message, isError = false) {
  const element = document.createElement('div');
  element.className = `toast${isError ? ' is-error' : ''}`;
  element.setAttribute('role', isError ? 'alert' : 'status');
  element.textContent = isError ? cleanErrorMessage(message) : message;
  ui.toastRegion.append(element);
  setTimeout(() => element.remove(), isError ? 7000 : 4000);
}

document.addEventListener('click', event => {
  if (!event.target.closest('.nested-color-picker')) {
    ui.parameterList.querySelectorAll('.nested-color-menu:not([hidden])').forEach(menu => { menu.hidden = true; });
  }
});

const ADD_TOOL_SOURCES = [
  {
    id: 'file', title: 'SCAD file', description: 'A single self-contained .scad model.',
    icon: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>'
  },
  {
    id: 'project', title: 'Project folder', description: 'Models that use include/use, images, SVG, or mesh files.',
    icon: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H10l2 2h7.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/>'
  },
  {
    id: 'url', title: 'From URL', description: 'A direct HTTPS link to a .scad file.',
    icon: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2A5 5 0 0 0 12 3.9l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/>'
  }
];

function onToolAdded(result, message) {
  if (!result) return false;
  state.tools = result.tools;
  refreshToolSelect();
  switchTool(result.tool.id, true);
  setStatus(message);
  toast(message);
  return true;
}

function openAddToolModal() {
  openModal('Add tool', 'Each tool is one OpenSCAD model. BonaStudio stores a copy in your local library; the original files are never changed.', `
    <div class="choice-grid">${ADD_TOOL_SOURCES.map(source => `<button class="choice-card" type="button" data-add-source="${source.id}">
        <span class="choice-icon"><svg viewBox="0 0 24 24">${source.icon}</svg></span>
        <strong>${source.title}</strong><small>${source.description}</small>
      </button>`).join('')}</div>
    <form id="urlImportForm" class="url-import-form" hidden>
      <label class="modal-field"><span>SCAD file URL</span><input id="scadUrl" class="modal-input" type="url" placeholder="https://example.com/model.scad" required></label>
      <p class="modal-help">Use a trusted source. The link must point directly to a .scad file of 10 MB or less on a public HTTPS host.</p>
      <div id="addToolError"></div>
      <div class="modal-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button id="urlImportSubmit" class="button button-primary" type="submit">Import</button></div>
    </form>
    <div id="addToolFileError"></div>`, 'modal-wide');

  ui.modal.querySelectorAll('[data-add-source]').forEach(button => button.addEventListener('click', async () => {
    const source = button.dataset.addSource;
    ui.modal.querySelectorAll('[data-add-source]').forEach(option => option.classList.toggle('is-selected', option === button));
    ui.modal.querySelector('#addToolFileError').replaceChildren();
    if (source === 'url') {
      $('#urlImportForm').hidden = false;
      $('#scadUrl').focus();
      return;
    }
    $('#urlImportForm').hidden = true;
    button.disabled = true;
    try {
      const result = source === 'project' ? await window.formforge.importProject() : await window.formforge.importFile();
      if (onToolAdded(result, `"${result?.tool.name}" added to the library.`)) closeModal();
    } catch (error) {
      showModalError('addToolFileError', error.message || 'Could not import the tool.');
    } finally {
      button.disabled = false;
    }
  }));

  $('#urlImportForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#urlImportSubmit');
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const result = await window.formforge.importUrl($('#scadUrl').value.trim());
      if (onToolAdded(result, `"${result?.tool.name}" added to the library.`)) closeModal();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Import';
      showModalError('addToolError', error.message || 'Could not import the file.');
    }
  });
}

function openSettings() {
  const settings = state.settings || {};
  const body = `
    <form id="settingsForm">
      <div class="modal-section modal-section-first">
        <h3>Application identity</h3><p>Customize the name shown in the app window and workspace.</p>
      </div>
      <label class="modal-field"><span>Application title</span>
        <input id="appTitle" class="modal-input" value="${escapeHtml(settings.appTitle || DEFAULT_APP_TITLE)}" placeholder="${DEFAULT_APP_TITLE}" maxlength="60" required>
        <small class="modal-help">Use 1 to 60 characters.</small>
      </label>
      <div class="modal-section"><h3>Export</h3><p>Where the save dialog opens and which format is selected first.</p></div>
      <label class="modal-field"><span>Default export folder</span>
        <div class="input-with-button"><input id="exportDirectory" class="modal-input" value="${escapeHtml(settings.exportDirectory || '')}" placeholder="Desktop"><button id="browseExportDirectory" class="button button-secondary" type="button">Browse…</button></div>
      </label>
      <label class="modal-field"><span>Default export format</span>
        <select id="exportFormat" class="modal-select"><option value="stl">STL · geometry only</option><option value="3mf">3MF · geometry with colors</option></select>
      </label>
      <div class="modal-section"><h3>Preview</h3></div>
      <div class="setting-row"><div class="setting-copy"><strong>Automatic preview</strong><small>Render again shortly after a parameter changes</small></div><input id="autoPreview" class="toggle" type="checkbox" ${settings.autoPreview ? 'checked' : ''}></div>
      <label class="modal-field"><span>Automatic preview delay · <b id="delayDisplay">${settings.previewDelay || 700} ms</b></span><input id="previewDelay" type="range" min="150" max="3000" step="50" value="${settings.previewDelay || 700}"></label>
      <div class="modal-section"><h3>Viewport transform</h3><p>Move, rotate, and scale the model in the preview. Values are written to the tool's parameters, or to the Transform group when the tool has none.</p></div>
      <div class="setting-row"><div class="setting-copy"><strong>Viewport transform</strong><small>Click the model to make it active, then transform it with the gizmo or shortcuts</small></div><input id="transformEnabled" class="toggle" type="checkbox" ${settings.transformEnabled !== false ? 'checked' : ''}></div>
      <div class="setting-row"><div class="setting-copy"><strong>Show gizmo</strong><small>Move, rotate, and scale handles on the active object</small></div><input id="transformGizmo" class="toggle" type="checkbox" ${settings.transformGizmo !== false ? 'checked' : ''}></div>
      <label class="modal-field"><span>Gizmo size · <b id="gizmoSizeDisplay">${Math.round((Number(settings.gizmoSize) || 1) * 100)}%</b></span><input id="gizmoSize" type="range" min="0.5" max="2" step="0.1" value="${Number(settings.gizmoSize) || 1}"></label>
      <div class="setting-row"><div class="setting-copy"><strong>Transform shortcuts</strong><small>G move, R rotate, S scale · the grid toggle becomes Shift+G</small></div><input id="transformShortcuts" class="toggle" type="checkbox" ${settings.transformShortcuts !== false ? 'checked' : ''}></div>
      <label class="modal-field"><span>Shortcut behavior</span><select id="transformShortcutMode" class="modal-select"><option value="modal">Start transforming with the mouse (Blender style)</option><option value="gizmo">Only switch the gizmo mode</option></select></label>
      <div class="setting-row"><div class="setting-copy"><strong>Keep on plate</strong><small>After a rotate or scale the model rests on Z = 0; Z moves are locked</small></div><input id="keepOnPlate" class="toggle" type="checkbox" ${settings.keepOnPlate !== false ? 'checked' : ''}></div>
      <div class="settings-grid-3">
        <label class="modal-field"><span>Move snap (mm)</span><input id="snapMove" class="modal-input" type="number" min="0.1" max="100" step="0.1" value="${Number(settings.snapMove) || 1}"></label>
        <label class="modal-field"><span>Rotate snap (°)</span><input id="snapRotate" class="modal-input" type="number" min="1" max="90" step="1" value="${Number(settings.snapRotate) || 15}"></label>
        <label class="modal-field"><span>Scale snap (%)</span><input id="snapScale" class="modal-input" type="number" min="1" max="100" step="1" value="${Number(settings.snapScale) || 10}"></label>
      </div>
      <p class="modal-help">Hold Ctrl (⌘ on macOS) while transforming to snap to these steps.</p>
      <div class="modal-section"><h3>Icon library</h3><p>Copy icon packs (folders of SVG files) into the icon folder; tools with an image parameter list them under Icon library.</p></div>
      <div class="setting-row"><div class="setting-copy"><strong>Icon folder</strong><small>Free packs that print well: game-icons.net, Material Symbols, Tabler, Phosphor, Lucide, Font Awesome Free</small></div><button id="openIconFolderSettings" class="button button-secondary button-compact" type="button">Open icon folder</button></div>
      <div class="modal-section"><h3>Appearance</h3></div>
      <label class="modal-field"><span>Theme</span><select id="theme" class="modal-select"><option value="system">Match system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <div class="modal-section"><h3>Render engine</h3><p>${state.openscadAvailable
        ? 'The bundled OpenSCAD WebAssembly engine is ready. Rendering runs locally; no OpenSCAD installation is needed.'
        : 'The bundled OpenSCAD WebAssembly engine is missing. Rebuild the app while connected to the internet to download it.'}</p></div>
      <div id="settingsError"></div>
      <div class="modal-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button id="saveSettings" class="button button-primary" type="submit">Save settings</button></div>
    </form>`;
  openModal('Settings', '', body, 'modal-wide');
  $('#previewDelay').disabled = !settings.autoPreview;
  $('#autoPreview').addEventListener('change', event => { $('#previewDelay').disabled = !event.target.checked; });
  $('#exportFormat').value = ['stl', '3mf'].includes(settings.exportFormat) ? settings.exportFormat : 'stl';
  $('#theme').value = settings.theme || 'light';
  $('#previewDelay').addEventListener('input', event => { $('#delayDisplay').textContent = `${event.target.value} ms`; });
  $('#transformShortcutMode').value = settings.transformShortcutMode === 'gizmo' ? 'gizmo' : 'modal';
  $('#gizmoSize').addEventListener('input', event => { $('#gizmoSizeDisplay').textContent = `${Math.round(Number(event.target.value) * 100)}%`; });
  const syncTransformControls = () => {
    const enabled = $('#transformEnabled').checked;
    for (const id of ['transformGizmo', 'gizmoSize', 'transformShortcuts', 'transformShortcutMode', 'keepOnPlate', 'snapMove', 'snapRotate', 'snapScale']) $(`#${id}`).disabled = !enabled;
    if (enabled) {
      $('#gizmoSize').disabled = !$('#transformGizmo').checked;
      $('#transformShortcutMode').disabled = !$('#transformShortcuts').checked;
    }
  };
  ['transformEnabled', 'transformGizmo', 'transformShortcuts'].forEach(id => $(`#${id}`).addEventListener('change', syncTransformControls));
  syncTransformControls();
  $('#openIconFolderSettings').addEventListener('click', async () => {
    try { await window.formforge.openIconFolder(); } catch (error) { showModalError('settingsError', error.message); }
  });
  $('#browseExportDirectory').addEventListener('click', async () => {
    const result = await window.formforge.chooseExportDirectory($('#exportDirectory').value);
    if (result) $('#exportDirectory').value = result;
  });
  $('#settingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const saveButton = $('#saveSettings');
    saveButton.disabled = true;
    try {
      const previousAvailability = state.openscadAvailable;
      state.settings = await window.formforge.saveSettings({
        appTitle: $('#appTitle').value,
        exportDirectory: $('#exportDirectory').value,
        exportFormat: $('#exportFormat').value,
        autoPreview: $('#autoPreview').checked,
        previewDelay: Number($('#previewDelay').value),
        theme: $('#theme').value,
        transformEnabled: $('#transformEnabled').checked,
        transformGizmo: $('#transformGizmo').checked,
        gizmoSize: Number($('#gizmoSize').value),
        transformShortcuts: $('#transformShortcuts').checked,
        transformShortcutMode: $('#transformShortcutMode').value,
        keepOnPlate: $('#keepOnPlate').checked,
        snapMove: Number($('#snapMove').value),
        snapRotate: Number($('#snapRotate').value),
        snapScale: Number($('#snapScale').value)
      });
      const nextState = await window.formforge.initialState();
      state.openscadAvailable = nextState.openscadAvailable;
      updateAppStatus();
      // Transform settings change the parameter panel, the preview placement, and the gizmo.
      renderParameters();
      applyModelTransform();
      if (!transformEnabled()) setSelected(false);
      else updateSelectionVisuals();
      updateParameterHint();
      closeModal();
      toast('Settings saved.');
      if (!previousAvailability && state.openscadAvailable && activeTool()) generatePreview();
    } catch (error) {
      saveButton.disabled = false;
      showModalError('settingsError', error.message);
    }
  });
}

function openExportModal() {
  const tool = activeTool();
  if (!tool) {
    toast('Select a tool to export.', true);
    return;
  }
  const initial = ['stl', '3mf'].includes(state.settings?.exportFormat) ? state.settings.exportFormat : 'stl';
  const confirmLabel = 'Export…';
  // Tools that lay parts on several plates can be exported as one file per plate in a single step.
  const plateCount = tool.parameters?.some(parameter => parameter.name === 'export_plate' && parameter.type === 'number') && state.plates > 1 ? state.plates : 0;
  const plateChoice = plateCount ? `
    <div class="modal-section"><h3>Plates</h3><p>This model fills ${plateCount} build plates.</p></div>
    <div class="choice-grid choice-grid-2">
      <button class="choice-card is-selected" data-plates="each" type="button"><span class="choice-type">${plateCount} files</span><strong>One file per plate</strong><small>Each plate is moved onto plate 1, ready to print on its own.</small></button>
      <button class="choice-card" data-plates="all" type="button"><span class="choice-type">1 file</span><strong>All plates in one file</strong><small>Everything as laid out in the viewport.</small></button>
    </div>` : '';
  openModal('Export model', `${tool.name} · current parameter values`, `
    <div class="choice-grid choice-grid-2">
      <button class="choice-card ${initial === 'stl' ? 'is-selected' : ''}" data-format="stl" type="button"><span class="choice-type">STL</span><strong>Mesh</strong><small>Geometry only. Opens in every slicer.</small></button>
      <button class="choice-card ${initial === '3mf' ? 'is-selected' : ''}" data-format="3mf" type="button"><span class="choice-type">3MF</span><strong>Mesh with colors</strong><small>Keeps model colors for multi-material printing.</small></button>    </div>
    ${plateChoice}
    <div class="modal-note">Exported at maximum resolution: curves stay within about 0.015 mm of the true shape, finer than a 3D printer can reproduce. This replaces the model's own <code>$fn</code>/<code>$fa</code>/<code>$fs</code> preview settings, so export can take longer than the preview. Set printer, material, and print settings in your slicer.</div>
    ${exportTransformPayload(tool) ? '<div class="modal-note">The viewport transform from the Transform group is applied to the exported mesh, centered on the plate origin.</div>' : ''}
    <div id="exportError"></div>
    <div class="modal-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button id="confirmExport" class="button button-primary" type="button" autofocus>${confirmLabel}</button></div>`, 'modal-wide');
  let format = initial;
  let perPlate = plateCount > 0;
  ui.modal.querySelectorAll('[data-format]').forEach(button => button.addEventListener('click', () => {
    format = button.dataset.format;
    ui.modal.querySelectorAll('[data-format]').forEach(option => option.classList.toggle('is-selected', option === button));
  }));
  ui.modal.querySelectorAll('[data-plates]').forEach(button => button.addEventListener('click', () => {
    perPlate = button.dataset.plates === 'each';
    ui.modal.querySelectorAll('[data-plates]').forEach(option => option.classList.toggle('is-selected', option === button));
  }));
  $('#confirmExport').addEventListener('click', async () => {
    const button = $('#confirmExport');
    const closeButtons = [...ui.modal.querySelectorAll('[data-close]')];
    button.disabled = true;
    button.textContent = 'Choose a location…';
    // The save dialog opens first; the elapsed counter then reflects the render itself.
    const startedAt = performance.now();
    let progress = null;
    const stopProgress = window.formforge.onExportProgress(next => { progress = next; });
    const ticker = setInterval(() => {
      const seconds = Math.round((performance.now() - startedAt) / 1000);
      if (seconds >= 2 || progress) {
        const plate = progress ? `plate ${progress.plate}${progress.count ? ` of ${progress.count}` : ''} · ` : '';
        button.textContent = `Rendering ${plate}maximum quality… ${seconds} s`;
        closeButtons.forEach(element => { element.disabled = true; });
      }
    }, 500);
    setStatus(`Exporting ${tool.name} as ${format.toUpperCase()}${perPlate ? ', one file per plate' : ''}…`);
    try {
      const result = await window.formforge.export(tool.id, { ...state.values }, format, exportTransformPayload(tool), { perPlate });
      if (result.canceled) {
        setStatus('Export canceled');
        button.disabled = false;
        button.textContent = confirmLabel;
        return;
      }
      state.settings.exportDirectory = result.filePath.replace(/[\\/][^\\/]+$/, '');
      updateAppStatus();
      closeModal();
      const size = result.bytes >= 1024 * 1024 ? `${(result.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(result.bytes / 1024))} KB`;
      const where = result.files?.length > 1
        ? `${result.files.length} files · ${result.files.map(file => file.filePath.split(/[\\/]/).pop()).join(', ')}`
        : result.filePath;
      setStatus(`Exported ${where} · ${size}`);
      if (result.quality === 'maximum') toast(`Exported at maximum quality · ${size}\n${where}`);
      else toast(`Maximum quality took too long for this model, so it was exported at the model's own resolution · ${size}\n${where}`, true);
    } catch (error) {
      button.disabled = false;
      button.textContent = confirmLabel;
      setStatus('Export failed', true);
      showModalError('exportError', error.message);
    } finally {
      stopProgress();
      clearInterval(ticker);
      closeButtons.forEach(element => { element.disabled = false; });
    }
  });
}

function openAddParameterModal() {
  if (!activeTool()) return;
  openModal('Add custom parameter', 'Expose a top-level SCAD variable that was not detected automatically. The value is passed to OpenSCAD on every render.', `
    <form id="manualParameterForm">
      <label class="modal-field"><span>Variable name</span><input id="manualName" class="modal-input" placeholder="e.g. wall_thickness" pattern="[A-Za-z_][A-Za-z0-9_]*" required></label>
      <label class="modal-field"><span>Display label</span><input id="manualLabel" class="modal-input" placeholder="Wall thickness"></label>
      <label class="modal-field"><span>Control type</span><select id="manualType" class="modal-select"><option value="number">Number</option><option value="boolean">Toggle</option></select></label>
      <label class="modal-field"><span>Default value</span><input id="manualDefault" class="modal-input" type="number" value="1" step="any" required></label>
      <div id="manualParameterError"></div>
      <div class="modal-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button id="addManualSubmit" class="button button-primary" type="submit">Add parameter</button></div>
    </form>`);
  $('#manualType').addEventListener('change', () => {
    const field = $('#manualDefault');
    field.type = $('#manualType').value === 'boolean' ? 'checkbox' : 'number';
    field.required = field.type !== 'checkbox';
    if (field.type === 'checkbox') field.checked = true;
    else field.value = '1';
  });
  $('#manualParameterForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#addManualSubmit');
    button.disabled = true;
    try {
      const result = await window.formforge.addParameter(activeTool().id, {
        name: $('#manualName').value.trim(),
        label: $('#manualLabel').value.trim(),
        type: $('#manualType').value,
        default: $('#manualType').value === 'boolean' ? $('#manualDefault').checked : Number($('#manualDefault').value)
      });
      state.tools = result.tools;
      const updated = activeTool();
      // Keep the user's current values and add the new parameter's default.
      state.values = withAvailableFont(updated, { ...defaultValues(updated), ...state.values });
      state.dirty = valuesAreDirty(updated);
      renderParameters();
      queuePreview();
      closeModal();
      toast(`Parameter "${result.tool.parameters.at(-1)?.label || 'new'}" added.`);
    } catch (error) {
      button.disabled = false;
      showModalError('manualParameterError', error.message);
    }
  });
}

// Electron does not support window.prompt(), so presets are named in a modal.
function openSavePresetModal() {
  const tool = activeTool();
  if (!tool) return;
  const presets = getPresetList();
  const current = presets.find(preset => preset.id === ui.presetSelect.value);
  openModal('Save preset', `Store the current parameter values of ${tool.name} on this device.`, `
    <form id="presetForm">
      <label class="modal-field"><span>Preset name</span><input id="presetName" class="modal-input" maxlength="60" required autofocus value="${escapeHtml(current?.name || '')}" placeholder="e.g. Large, thick walls"></label>
      ${current ? '<p class="modal-help">Using an existing name replaces that preset.</p>' : ''}
      <div id="presetError"></div>
      <div class="modal-actions"><button class="button button-secondary" type="button" data-close>Cancel</button><button class="button button-primary" type="submit">Save preset</button></div>
    </form>`);
  $('#presetName').select();
  $('#presetForm').addEventListener('submit', event => {
    event.preventDefault();
    const name = $('#presetName').value.trim();
    if (!name) return showModalError('presetError', 'Enter a name for the preset.');
    const list = getPresetList();
    const existing = list.find(preset => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const preset = existing || { id: crypto.randomUUID(), name };
    preset.name = name;
    preset.values = structuredClone(state.values);
    if (!existing) list.push(preset);
    try {
      writePresetList(list);
    } catch (error) {
      return showModalError('presetError', `The preset could not be saved: ${error.message}`);
    }
    state.baselineValues = structuredClone(state.values);
    state.dirty = false;
    renderPresetSelect(preset.id);
    updateParameterHint();
    closeModal();
    setStatus(`Preset saved · ${name}`);
    toast(`Preset "${name}" ${existing ? 'updated' : 'saved'}.`);
  });
}

function deleteSelectedPreset() {
  const presets = getPresetList();
  const preset = presets.find(item => item.id === ui.presetSelect.value);
  if (!preset || !confirm(`Delete the preset "${preset.name}"?`)) return;
  writePresetList(presets.filter(item => item.id !== preset.id));
  renderPresetSelect();
  state.baselineValues = defaultValues(activeTool());
  state.dirty = valuesAreDirty(activeTool());
  updateParameterHint();
  toast(`Preset "${preset.name}" deleted.`);
}

function updateParameter(name, value, target) {
  const tool = activeTool();
  const parameter = findParameter(tool, name);
  if (!parameter) return;
  let normalized = value;
  if (parameter.type === 'number') {
    const number = value === '' ? NaN : Number(value);
    const outOfRange = (Number.isFinite(parameter.min) && number < parameter.min) || (Number.isFinite(parameter.max) && number > parameter.max);
    target?.setAttribute('aria-invalid', String(!Number.isFinite(number) || outOfRange));
    if (!Number.isFinite(number) || outOfRange) {
      ui.parameterHint.classList.add('is-dirty');
      ui.parameterHint.textContent = Number.isFinite(parameter.min) && Number.isFinite(parameter.max)
        ? `${parameter.label || name} must be between ${parameter.min} and ${parameter.max}`
        : `${parameter.label || name} must be a number`;
      return;
    }
    normalized = number;
  } else if (parameter.type === 'vector' && typeof value === 'string') {
    normalized = value.split(',').map(item => Number(item.trim()));
    if (normalized.some(number => !Number.isFinite(number))) return;
  } else if (parameter.type === 'boolean') normalized = Boolean(value);
  state.values[name] = normalized;
  document.querySelectorAll(`[data-param="${CSS.escape(name)}"]`).forEach(input => {
    if (input === target) return;
    if (input.type === 'checkbox') input.checked = Boolean(normalized);
    else input.value = Array.isArray(normalized) ? normalized.join(', ') : String(normalized);
  });
  if (parameter.appTransform) {
    applyModelTransform();
    markValuesChanged(false);
  } else markValuesChanged();
}

function nestedNodeAt(path) {
  const tree = state.values.decorative_layers;
  let current = tree;
  const parts = path === '' ? [] : path.split('.').map(Number);
  for (const part of parts) {
    if (part === undefined || !Array.isArray(current) || !current[part]) return null;
    current = current[part].children;
  }
  return parts.length ? current : tree;
}

function nestedNode(path) {
  const parts = path === '' ? [] : path.split('.').map(Number);
  if (!parts.length) return null;
  let node = state.values.decorative_layers[parts[0]];
  for (const part of parts.slice(1)) node = node?.children?.[part];
  return node || null;
}

// A new element starts without children; nesting is added explicitly so the tool's max-depth is respected.
function createNestedElement(type = 'Text') {
  return {
    type, text: 'Text', font: state.values.font_name || state.localFonts[0]?.name || 'Liberation Sans:style=Bold', icon: nestedIcons()[0], svgPath: '',
    x: 0, y: 0, size: 24, thickness: 1.6, bold: 0.2, placement: 'Above', overlap: 0, rotation: 0, color: '#111827', children: []
  };
}

function commitNestedTree(tree, rerender = false) {
  state.values.decorative_layers = tree;
  if (rerender) renderParameters();
  markValuesChanged();
}

async function chooseNestedSvg(button) {
  const file = await window.formforge.chooseParameterFile('icon');
  if (!file) return;
  const node = nestedNode(button.dataset.treePath);
  if (!node) return;
  const bytes = new Uint8Array(file.data);
  const svg = file.extension === '.svg' ? new TextDecoder().decode(bytes) : await rasterFileToSvg(file);
  const saved = await window.formforge.saveIconAsset(activeTool().id, 'decorative_layers', svg);
  node.svgPath = saved.reference;
  commitNestedTree(state.values.decorative_layers, true);
  toast('SVG added to this element.');
}

const NESTED_FIELD_LABELS = { size: 'Size', thickness: 'Thickness', bold: 'Bold', overlap: 'Inset depth', x: 'X position', y: 'Y position', rotation: 'Rotation' };

// Numeric nested fields are validated against the input's own min/max before they reach the tree,
// so a half-typed or empty value never triggers a render the main process would reject.
function readNestedInput(target) {
  if (!['number', 'range'].includes(target.type)) return { valid: true, value: target.value };
  const value = target.value.trim() === '' ? NaN : Number(target.value);
  const min = Number(target.min);
  const max = Number(target.max);
  const valid = Number.isFinite(value) && !(target.min !== '' && value < min) && !(target.max !== '' && value > max);
  target.setAttribute('aria-invalid', String(!valid));
  if (!valid) {
    ui.parameterHint.classList.add('is-dirty');
    ui.parameterHint.textContent = `${NESTED_FIELD_LABELS[target.dataset.treeKey] || 'Value'} must be between ${target.min} and ${target.max}`;
  }
  return { valid, value };
}

ui.parameterList.addEventListener('input', event => {
  const target = event.target;
  if (!target.dataset.treePath || !target.dataset.treeKey) return;
  const node = nestedNode(target.dataset.treePath);
  if (!node) return;
  const key = target.dataset.treeKey;
  const { valid, value } = readNestedInput(target);
  if (!valid) return;
  node[key] = value;
  document.querySelectorAll(`[data-tree-path="${CSS.escape(target.dataset.treePath)}"][data-tree-key="${CSS.escape(key)}"]`).forEach(input => {
    if (input !== target) input.value = String(node[key]);
  });
  document.querySelectorAll(`[data-tree-path="${CSS.escape(target.dataset.treePath)}"][data-tree-value="${CSS.escape(key)}"]`).forEach(output => {
    output.textContent = `${Number(node[key]).toFixed(1)} ${output.dataset.treeUnit || 'mm'}`;
  });
  commitNestedTree(state.values.decorative_layers);
});

ui.parameterList.addEventListener('change', event => {
  const target = event.target;
  if (!target.dataset.treePath || !target.dataset.treeKey) return;
  const node = nestedNode(target.dataset.treePath);
  if (!node) return;
  const key = target.dataset.treeKey;
  const { valid, value } = readNestedInput(target);
  if (!valid) {
    // On blur, fall back to the last valid value instead of leaving the field in an unusable state.
    target.value = String(node[key]);
    target.setAttribute('aria-invalid', 'false');
    updateParameterHint();
    return;
  }
  node[key] = value;
  commitNestedTree(state.values.decorative_layers, key === 'type');
});

ui.parameterList.addEventListener('click', async event => {
  const button = event.target.closest('[data-tree-action]');
  if (!button) return;
  const action = button.dataset.treeAction;
  if (action === 'toggle-color') {
    const menu = button.closest('.nested-color-picker')?.querySelector('.nested-color-menu');
    if (menu) menu.hidden = !menu.hidden;
    return;
  }
  if (action === 'set-color') {
    const node = nestedNode(button.dataset.treePath);
    if (!node || !/^#[\da-f]{6}$/i.test(button.dataset.color || '')) return;
    node.color = button.dataset.color;
    commitNestedTree(state.values.decorative_layers, true);
    return;
  }
  if (action === 'pick-svg') {
    button.disabled = true;
    try { await chooseNestedSvg(button); }
    catch (error) { toast(error.message || 'Could not use the selected SVG.', true); }
    finally { button.disabled = false; }
    return;
  }
  const tree = structuredClone(state.values.decorative_layers);
  const path = button.dataset.treePath || '';
  const parts = path === '' ? [] : path.split('.').map(Number);
  const getNodeFrom = () => {
    let node = tree[parts[0]];
    for (const index of parts.slice(1)) node = node?.children?.[index];
    return node;
  };
  if (action === 'add-root') tree.push(createNestedElement());
  else if (action === 'add-child') getNodeFrom()?.children.push(createNestedElement());
  else if (action === 'add-sibling' || action === 'remove') {
    const listPath = button.dataset.treeList ?? '';
    let list = tree;
    if (listPath) {
      const listParts = listPath.split('.');
      const nodePath = listParts.slice(0, -1).join('.');
      list = nestedNodeFromTree(tree, nodePath)?.children || [];
    }
    const index = parts.at(-1);
    if (action === 'add-sibling') list.push(createNestedElement());
    else if (list.length > 1 || listPath) list.splice(index, 1);
  }
  commitNestedTree(tree, true);
});

function nestedNodeFromTree(tree, path) {
  const parts = path === '' ? [] : path.split('.').map(Number);
  if (!parts.length) return null;
  let node = tree[parts[0]];
  for (const index of parts.slice(1)) node = node?.children?.[index];
  return node || null;
}

ui.parameterList.addEventListener('input', event => {
  const target = event.target;
  const name = target.dataset.param;
  if (!name) return;
  const parameter = findParameter(activeTool(), name);
  if (parameter?.type === 'boolean') return;
  updateParameter(name, target.value, target);
});
ui.parameterList.addEventListener('change', event => {
  const target = event.target;
  const name = target.dataset.param;
  if (!name) return;
  if (target.type === 'checkbox') updateParameter(name, target.checked, target);
  else if (target.tagName === 'SELECT') {
    updateParameter(name, target.value, target);
    if (isFontParameterName(name)) {
      const font = state.localFonts.find(item => item.name === target.value);
      const preview = ui.parameterList.querySelector('[data-font-preview=\"' + CSS.escape(name) + '\"]');
      if (preview) preview.style.fontFamily = font ? JSON.stringify(font.family) + ', sans-serif' : '';
    }
  }
});
ui.parameterList.addEventListener('toggle', handleParameterGroupToggle, true);
ui.parameterList.addEventListener('click', async event => {
  if (event.target.closest('[data-transform-reset]')) {
    resetTransform();
    return;
  }
  const library = event.target.closest('[data-icon-library]');
  if (library) {
    const tool = activeTool();
    if (tool) openIconLibraryModal(tool, library.dataset.param);
    return;
  }
  const button = event.target.closest('[data-file-picker]');
  if (!button) return;
  button.disabled = true;
  try {
    await handleParameterFilePicker(button);
  } catch (error) {
    toast(error.message || 'Could not use the selected file.', true);
  } finally {
    button.disabled = false;
  }
});

async function deleteActiveTool() {
  const tool = activeTool();
  if (!tool) return;
  try {
    const result = await window.formforge.deleteTool(tool.id);
    state.tools = result.tools;
    if (!result.deleted) return;
    try { localStorage.removeItem(presetStorageKey(tool)); } catch {}
    refreshToolSelect();
    switchTool(scadTools()[0]?.id || generatorTool()?.id || '', true);
    setStatus(`"${tool.name}" removed from the library`);
    toast(`"${tool.name}" removed from the library.`);
  } catch (error) {
    toast(error.message || 'Could not delete the tool.', true);
  }
}

async function changeExportFolder() {
  try {
    const directory = await window.formforge.chooseExportDirectory(state.settings?.exportDirectory);
    if (!directory) return;
    state.settings = await window.formforge.saveSettings({ ...state.settings, exportDirectory: directory });
    updateAppStatus();
    toast(`Export folder set to ${exportFolderName()}.`);
  } catch (error) {
    toast(error.message || 'Could not change the export folder.', true);
  }
}

function toggleGrid() {
  state.grid.visible = !state.grid.visible;
  ui.gridButton.classList.toggle('is-selected', state.grid.visible);
  ui.gridButton.setAttribute('aria-pressed', String(state.grid.visible));
}

$('#addToolButton').addEventListener('click', openAddToolModal);
ui.deleteToolButton.addEventListener('click', deleteActiveTool);
ui.toolSelect.addEventListener('change', () => switchTool(ui.toolSelect.value));
ui.modeLithophane.addEventListener('click', () => chooseMode('lithophane'));
ui.modeTools.addEventListener('click', () => chooseMode('tools'));
ui.renderButton.addEventListener('click', generatePreview);
ui.resetParamsButton.addEventListener('click', () => {
  const tool = activeTool();
  if (!tool) return;
  ui.presetSelect.value = '';
  applyValues(tool, defaultValues(tool));
  renderPresetSelect();
  updateParameterHint();
  queuePreview();
  setStatus('Parameters restored to default values');
});
ui.addParameterButton.addEventListener('click', openAddParameterModal);
ui.savePresetButton.addEventListener('click', openSavePresetModal);
ui.deletePresetButton.addEventListener('click', deleteSelectedPreset);
ui.presetSelect.addEventListener('change', () => {
  const tool = activeTool();
  if (!tool) return;
  if (state.dirty && !confirm('You have unsaved parameter changes. Load the selected values and discard them?')) {
    renderPresetSelect(getPresetList().find(preset => JSON.stringify(preset.values) === JSON.stringify(state.baselineValues))?.id || '');
    return;
  }
  const preset = getPresetList().find(item => item.id === ui.presetSelect.value);
  applyValues(tool, preset ? { ...defaultValues(tool), ...structuredClone(preset.values) } : defaultValues(tool));
  renderPresetSelect(preset?.id || '');
  updateParameterHint();
  queuePreview();
});
$('#settingsButton').addEventListener('click', openSettings);
ui.exportButton.addEventListener('click', openExportModal);
$('#focusButton').addEventListener('click', focusObject);
ui.gridButton.addEventListener('click', toggleGrid);
ui.plateLayout.innerHTML = '<option value="auto">Auto · 1 plate</option>'
  + PLATE_LAYOUTS.map(layout => `<option value="${layout}">${plateCountLabel(layout)}</option>`).join('');
ui.plateLayout.value = plateSetting();
ui.plateLayout.addEventListener('change', async () => {
  const layout = ui.plateLayout.value;
  if (layout !== 'auto' && !PLATE_LAYOUTS.includes(layout)) return;
  try {
    state.settings = await window.formforge.saveSettings({ ...state.settings, plateLayout: layout });
    updatePlates();
    if (!state.grid.visible) toggleGrid();
  } catch (error) {
    ui.plateLayout.value = plateSetting();
    toast(error.message || 'Could not change the build plates.', true);
  }
});
ui.exportFolderStatus.addEventListener('click', changeExportFolder);
ui.exportFolderStatus.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); changeExportFolder(); }
});
ui.emptyActions.addEventListener('click', event => {
  const action = event.target.closest('[data-empty-action]')?.dataset.emptyAction;
  if (action === 'add-tool') openAddToolModal();
  else if (action === 'render') generatePreview();
});
ui.viewportNotice.addEventListener('click', event => {
  if (event.target.closest('[data-dismiss-notice]')) hideNotice();
});
document.querySelectorAll('.view-tab').forEach(tab => tab.addEventListener('click', () => setCameraView(tab.dataset.view)));
$('#sidebarCollapseButton').addEventListener('click', event => {
  const collapsed = ui.appShell.classList.toggle('sidebar-collapsed');
  event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  event.currentTarget.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  event.currentTarget.setAttribute('aria-label', event.currentTarget.title);
  resizeViewport();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings?.theme === 'system') applyTheme();
});

async function initialize() {
  try {
    const initial = await window.formforge.initialState();
    try { state.localFonts = await window.formforge.listFonts(); } catch (error) { console.warn('Could not enumerate local fonts:', error); }
    state.tools = initial.tools;
    state.settings = initial.settings;
    state.version = initial.version || '';
    state.platform = initial.platform || '';
    state.openscadAvailable = initial.openscadAvailable;
    updatePlates();
    updateAppStatus();
    refreshToolSelect();
    switchTool(scadTools()[0]?.id || generatorTool()?.id || '', true);
    setStatus(state.openscadAvailable ? 'All data is stored locally on this device' : 'Render engine missing — rebuild the app to enable previews', !state.openscadAvailable);
    resizeViewport();
  } catch (error) {
    setRenderState('Startup failed', 'error');
    setEmptyState('Could not open the library', error.message || 'The local library could not be loaded.');
    setStatus('Startup failed', true);
    toast(error.message || 'Could not open the library.', true);
  }
}

initialize();
