/**
 * Exercises tab for the settings modal.
 * Browse, filter, edit, enable/disable, and add custom accessories.
 */

import store from '../state/store.js';
import { EXERCISE_CATALOG } from '../data/exercise-catalog.js';
import { getAllExerciseIds, resolveAccessory } from '../data/exercise-compat.js';
import { MUSCLE_GROUPS } from '../data/muscle-groups.js';

// --- Ephemeral filter state ---
let _liftFilter = 'all';
let _equipFilter = 'all';
let _muscleFilter = 'all';
let _searchQuery = '';
let _expandedId = null;
let _showAddForm = false;

// --- Helpers ---

function getMainLift(ex, _id) {
  if (ex.supportsLifts?.length) return ex.supportsLifts[0];
  if (ex.mainLift) return ex.mainLift;
  return 'other';
}

/** Heaviest-weighted muscle for an exercise, used to bucket non-SBD movements. */
function getPrimaryMuscle(ex) {
  if (!ex.primaryMuscles) return null;
  const sorted = Object.entries(ex.primaryMuscles).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || null;
}

function getPctDisplay(ex) {
  if (!ex.pctOfTM) return '';
  if (typeof ex.pctOfTM === 'number') return `${Math.round(ex.pctOfTM * 100)}%`;
  const vals = Object.values(ex.pctOfTM);
  if (vals.length === 0) return '';
  return `${Math.round(vals[0] * 100)}%`;
}

function matchesLiftFilter(ex) {
  if (_liftFilter === 'all') return true;
  if (ex.supportsLifts) return ex.supportsLifts.includes(_liftFilter);
  return ex.mainLift === _liftFilter;
}

// A muscle counts as "trained" by an exercise once it carries at least a fifth
// of the load — below that it's incidental stabilizer work, not a reason to
// show up under that muscle's filter.
const MUSCLE_FILTER_THRESHOLD = 0.2;

function matchesMuscleFilter(ex) {
  if (_muscleFilter === 'all') return true;
  const w = ex.primaryMuscles?.[_muscleFilter];
  return typeof w === 'number' && w >= MUSCLE_FILTER_THRESHOLD;
}

function matchesEquipFilter(ex) {
  if (_equipFilter === 'all') return true;
  return ex.equipment === _equipFilter;
}

function matchesSearch(ex) {
  if (!_searchQuery) return true;
  return ex.name.toLowerCase().includes(_searchQuery.toLowerCase());
}

// --- Render ---

export function renderExercisesTab() {
  const disabledSet = new Set(store.disabledAccessories || []);
  const allIds = getAllExerciseIds();

  // Build exercise list with resolved data
  const exercises = [];
  for (const id of allIds) {
    const ex = resolveAccessory(id);
    if (!ex) continue;
    const mainLift = getMainLift(ex, id);
    exercises.push({ id, ex, mainLift, disabled: disabledSet.has(id) });
  }

  // Apply filters
  const filtered = exercises.filter(
    (e) =>
      matchesLiftFilter(e.ex) &&
      matchesEquipFilter(e.ex) &&
      matchesMuscleFilter(e.ex) &&
      matchesSearch(e.ex)
  );

  // Group by lift. Movements that don't carry over to a competition lift
  // (pure bodybuilding / conditioning work) get bucketed by primary muscle
  // instead of piling into one undifferentiated "Other" list.
  const groups = { squat: [], bench: [], deadlift: [] };
  const muscleGroups = {};
  const otherGroup = [];
  const customGroup = [];
  for (const item of filtered) {
    if (item.id.startsWith('custom-')) {
      customGroup.push(item);
    } else if (groups[item.mainLift]) {
      groups[item.mainLift].push(item);
    } else {
      const mg = getPrimaryMuscle(item.ex);
      if (mg) {
        (muscleGroups[mg] = muscleGroups[mg] || []).push(item);
      } else {
        otherGroup.push(item);
      }
    }
  }

  // Sort each group alphabetically
  const byName = (a, b) => a.ex.name.localeCompare(b.ex.name);
  for (const g of Object.values(groups)) g.sort(byName);
  for (const g of Object.values(muscleGroups)) g.sort(byName);
  otherGroup.sort(byName);
  customGroup.sort(byName);

  let html = '';

  // Filter bar
  html += `<div class="exercises-filter-bar">`;
  html += `<div class="exercises-filter-row">`;
  for (const l of ['all', 'squat', 'bench', 'deadlift']) {
    const label = l === 'all' ? 'All' : l.charAt(0).toUpperCase() + l.slice(1);
    html += `<button class="filter-pill${_liftFilter === l ? ' active' : ''}" data-lift-filter="${l}">${label}</button>`;
  }
  html += `</div>`;
  html += `<div class="exercises-filter-row">`;
  for (const [val, label] of [
    ['all', 'All'],
    ['barbell', 'Barbell'],
    ['dumbbell', 'DB'],
    ['machine', 'Machine'],
    ['cable', 'Cable'],
    ['bodyweight', 'BW'],
  ]) {
    html += `<button class="filter-pill${_equipFilter === val ? ' active' : ''}" data-equip-filter="${val}">${label}</button>`;
  }
  html += `</div>`;
  html += `<div class="exercises-filter-row">`;
  html += `<button class="filter-pill${_muscleFilter === 'all' ? ' active' : ''}" data-muscle-filter="all">All Muscles</button>`;
  for (const mg of MUSCLE_GROUPS) {
    html += `<button class="filter-pill${_muscleFilter === mg ? ' active' : ''}" data-muscle-filter="${mg}">${mg}</button>`;
  }
  html += `</div>`;
  html += `<input type="text" class="exercise-search" placeholder="Search exercises..." value="${_searchQuery}">`;
  html += `</div>`;

  // Render groups
  const liftOrder = ['squat', 'bench', 'deadlift'];
  for (const lift of liftOrder) {
    const items = groups[lift];
    if (items.length === 0) continue;
    const enabledCount = items.filter((i) => !i.disabled).length;
    html += `<div class="exercise-section-label">${lift.charAt(0).toUpperCase() + lift.slice(1)} (${enabledCount}/${items.length})</div>`;
    html += renderExerciseRows(items);
  }

  // Non-SBD movements, grouped by the muscle they primarily train
  for (const mg of MUSCLE_GROUPS) {
    const items = muscleGroups[mg];
    if (!items || items.length === 0) continue;
    const enabledCount = items.filter((i) => !i.disabled).length;
    html += `<div class="exercise-section-label">${mg} (${enabledCount}/${items.length})</div>`;
    html += renderExerciseRows(items);
  }

  if (otherGroup.length > 0) {
    html += `<div class="exercise-section-label">Other (${otherGroup.length})</div>`;
    html += renderExerciseRows(otherGroup);
  }

  if (customGroup.length > 0) {
    html += `<div class="exercise-section-label">Custom (${customGroup.length})</div>`;
    html += renderExerciseRows(customGroup);
  }

  if (filtered.length === 0) {
    html += `<div style="text-align:center;color:var(--text-dim);padding:24px 0;font-size:var(--text-sm)">No exercises match your filters</div>`;
  }

  // Add custom button / form
  if (_showAddForm) {
    html += renderAddForm();
  } else {
    html += `<button class="exercise-add-btn" id="exercise-add-btn">+ Add Custom Exercise</button>`;
  }

  return html;
}

function renderExerciseRows(items) {
  let html = '';
  for (const { id, ex, disabled } of items) {
    const isExpanded = _expandedId === id;
    const isCustom = id.startsWith('custom-');
    const hasOverrides =
      !isCustom &&
      store.accessoryOverrides?.[id] &&
      Object.keys(store.accessoryOverrides[id]).length > 0;
    const repRange = ex.repRange ? `${ex.repRange[0]}-${ex.repRange[1]}` : '';
    const meta = [ex.equipment, ex.sets ? `${ex.sets}x${repRange}` : '', getPctDisplay(ex)]
      .filter(Boolean)
      .join(' \u00B7 ');

    html += `<div class="exercise-row${disabled ? ' disabled' : ''}${isExpanded ? ' expanded' : ''}" data-exercise-id="${id}">`;
    html += `<label class="exercise-row-toggle" onclick="event.stopPropagation()"><input type="checkbox" ${disabled ? '' : 'checked'} data-toggle-id="${id}"></label>`;
    html += `<div class="exercise-row-info">`;
    html += `<div class="exercise-row-name">${ex.name}${hasOverrides ? ' *' : ''}</div>`;
    html += `<div class="exercise-row-meta">${meta}</div>`;
    html += `</div>`;
    html += `<span class="exercise-row-chevron">\u25BC</span>`;
    html += `</div>`;

    // Edit form (always rendered, shown via CSS when expanded)
    const pctVal = getPctNumeric(ex);
    html += `<div class="exercise-edit-form" data-edit-id="${id}">`;
    html += `<div class="exercise-edit-grid">`;
    html += `<div><label>Sets</label><input type="number" value="${ex.sets || ''}" min="1" max="10" data-edit-field="sets" data-edit-ex="${id}"></div>`;
    html += `<div><label>Rep Min</label><input type="number" value="${ex.repRange?.[0] || ''}" min="1" max="50" data-edit-field="repMin" data-edit-ex="${id}"></div>`;
    html += `<div><label>Rep Max</label><input type="number" value="${ex.repRange?.[1] || ''}" min="1" max="50" data-edit-field="repMax" data-edit-ex="${id}"></div>`;
    html += `<div><label>% TM</label><input type="number" value="${pctVal || ''}" min="0" max="120" data-edit-field="pctOfTM" data-edit-ex="${id}"></div>`;
    html += `</div>`;
    html += `<div class="exercise-edit-actions">`;
    if (hasOverrides) {
      html += `<button class="exercise-reset-btn" data-reset-id="${id}">Reset to Default</button>`;
    }
    if (isCustom) {
      html += `<button class="exercise-delete-btn" data-delete-id="${id}">Delete Exercise</button>`;
    }
    html += `</div>`;
    html += `</div>`;
  }
  return html;
}

function getPctNumeric(ex) {
  if (!ex.pctOfTM) return '';
  if (typeof ex.pctOfTM === 'number') return Math.round(ex.pctOfTM * 100);
  const vals = Object.values(ex.pctOfTM);
  return vals.length ? Math.round(vals[0] * 100) : '';
}

function renderAddForm() {
  let html = `<div class="exercise-add-form" id="exercise-add-form">`;
  html += `<div class="exercise-section-label">New Custom Exercise</div>`;
  html += `<div class="exercise-edit-grid">`;
  html += `<div><label>Name</label><input type="text" id="add-ex-name" placeholder="Exercise name" style="width:100%;padding:6px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:var(--text-sm)"></div>`;
  html += `<div><label>Equipment</label><select id="add-ex-equip" style="width:100%;padding:6px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:var(--text-sm)">`;
  for (const eq of ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight']) {
    html += `<option value="${eq}">${eq.charAt(0).toUpperCase() + eq.slice(1)}</option>`;
  }
  html += `</select></div>`;
  html += `</div>`;
  html += `<div class="exercises-filter-row" style="margin-top:8px">`;
  html += `<span style="font-size:0.65rem;font-weight:600;text-transform:uppercase;color:var(--text-dim);margin-right:4px">Lift:</span>`;
  for (const l of ['squat', 'bench', 'deadlift']) {
    html += `<button class="filter-pill add-ex-lift" data-add-lift="${l}">${l.charAt(0).toUpperCase() + l.slice(1)}</button>`;
  }
  html += `</div>`;
  html += `<div class="exercise-edit-grid" style="margin-top:8px">`;
  html += `<div><label>Sets</label><input type="number" id="add-ex-sets" value="3" min="1" max="10"></div>`;
  html += `<div><label>Rep Min</label><input type="number" id="add-ex-repmin" value="8" min="1" max="50"></div>`;
  html += `<div><label>Rep Max</label><input type="number" id="add-ex-repmax" value="12" min="1" max="50"></div>`;
  html += `<div><label>% TM</label><input type="number" id="add-ex-pct" value="" min="0" max="120" placeholder="\u2014"></div>`;
  html += `</div>`;
  // Muscle percentage picker — lets custom exercises participate in fatigue / gap analysis
  html += `<div style="margin-top:10px">`;
  html += `<div style="font-size:0.65rem;font-weight:600;text-transform:uppercase;color:var(--text-dim);letter-spacing:0.04em;margin-bottom:6px">Target Muscles (%)</div>`;
  html += `<div class="exercise-add-muscles" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 8px">`;
  for (const mg of MUSCLE_GROUPS) {
    html +=
      `<label style="display:flex;align-items:center;gap:6px;font-size:var(--text-xs);color:var(--text)">` +
      `<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${mg}</span>` +
      `<input type="number" min="0" max="100" step="5" value="0" data-add-muscle="${mg}" style="width:44px;padding:3px 4px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:var(--text-xs);text-align:center">` +
      `</label>`;
  }
  html += `</div></div>`;
  html += `<div class="exercise-add-form-actions">`;
  html += `<button class="exercise-add-cancel" id="add-ex-cancel">Cancel</button>`;
  html += `<button class="exercise-add-save" id="add-ex-save">Add Exercise</button>`;
  html += `</div>`;
  html += `</div>`;
  return html;
}

// --- Event Wiring ---

export function attachExercisesListeners(container) {
  // Filter pills — lift
  container.querySelectorAll('[data-lift-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _liftFilter = btn.dataset.liftFilter;
      rerender(container);
    });
  });

  // Filter pills — equipment
  container.querySelectorAll('[data-equip-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _equipFilter = btn.dataset.equipFilter;
      rerender(container);
    });
  });

  // Filter pills — muscle group
  container.querySelectorAll('[data-muscle-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _muscleFilter = btn.dataset.muscleFilter;
      rerender(container);
    });
  });

  // Search input
  const searchInput = container.querySelector('.exercise-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      _searchQuery = e.target.value;
      rerender(container);
    });
  }

  // Toggle enable/disable
  container.querySelectorAll('[data-toggle-id]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.toggleId;
      const disabled = store.disabledAccessories || [];
      if (cb.checked) {
        store.disabledAccessories = disabled.filter((d) => d !== id);
      } else {
        if (!disabled.includes(id)) store.disabledAccessories = [...disabled, id];
      }
      store.saveDisabledAccessories();
      rerender(container);
    });
  });

  // Row expand/collapse (click on info area)
  container.querySelectorAll('.exercise-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.exercise-row-toggle')) return;
      const id = row.dataset.exerciseId;
      _expandedId = _expandedId === id ? null : id;
      rerender(container);
    });
  });

  // Edit fields
  container.querySelectorAll('[data-edit-field]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.editEx;
      const field = input.dataset.editField;
      const val = parseFloat(input.value);
      if (isNaN(val)) return;

      const isCustom = id.startsWith('custom-');

      if (isCustom) {
        const custom = (store.customAccessories || []).find((c) => c.id === id);
        if (!custom) return;
        if (field === 'sets') custom.sets = val;
        else if (field === 'repMin') custom.repRange = [val, custom.repRange?.[1] || val];
        else if (field === 'repMax') custom.repRange = [custom.repRange?.[0] || val, val];
        else if (field === 'pctOfTM') custom.pctOfTM = val / 100;
        store.saveCustomAccessories();
      } else {
        const overrides = store.accessoryOverrides || {};
        if (!overrides[id]) overrides[id] = {};
        if (field === 'sets') overrides[id].sets = val;
        else if (field === 'repMin') {
          const ex = resolveAccessory(id);
          overrides[id].repRange = [val, ex?.repRange?.[1] || val];
        } else if (field === 'repMax') {
          const ex = resolveAccessory(id);
          overrides[id].repRange = [ex?.repRange?.[0] || val, val];
        } else if (field === 'pctOfTM') {
          // Determine original pctOfTM structure
          const orig = EXERCISE_CATALOG[id];
          if (orig && typeof orig.pctOfTM === 'object') {
            const newPct = {};
            for (const lift of Object.keys(orig.pctOfTM)) newPct[lift] = val / 100;
            overrides[id].pctOfTM = newPct;
          } else {
            overrides[id].pctOfTM = val / 100;
          }
        }
        store.accessoryOverrides = overrides;
        store.saveAccessoryOverrides();
      }
      // Don't rerender — user is still editing
    });
    // Stop row click when interacting with input
    input.addEventListener('click', (e) => e.stopPropagation());
  });

  // Reset to defaults
  container.querySelectorAll('[data-reset-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.resetId;
      const overrides = store.accessoryOverrides || {};
      delete overrides[id];
      store.accessoryOverrides = overrides;
      store.saveAccessoryOverrides();
      rerender(container);
    });
  });

  // Delete custom exercise
  container.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.deleteId;
      store.customAccessories = (store.customAccessories || []).filter((c) => c.id !== id);
      store.disabledAccessories = (store.disabledAccessories || []).filter((d) => d !== id);
      store.saveCustomAccessories();
      store.saveDisabledAccessories();
      _expandedId = null;
      rerender(container);
    });
  });

  // Add custom button
  const addBtn = container.querySelector('#exercise-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      _showAddForm = true;
      rerender(container);
    });
  }

  // Add form — lift selection
  let _addLift = null;
  container.querySelectorAll('.add-ex-lift').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.add-ex-lift').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _addLift = btn.dataset.addLift;
    });
  });

  // Add form — cancel
  const cancelBtn = container.querySelector('#add-ex-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      _showAddForm = false;
      rerender(container);
    });
  }

  // Add form — save
  const saveBtn = container.querySelector('#add-ex-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const name = container.querySelector('#add-ex-name')?.value?.trim();
      const equip = container.querySelector('#add-ex-equip')?.value;
      const sets = parseInt(container.querySelector('#add-ex-sets')?.value) || 3;
      const repMin = parseInt(container.querySelector('#add-ex-repmin')?.value) || 8;
      const repMax = parseInt(container.querySelector('#add-ex-repmax')?.value) || 12;
      const pctRaw = parseFloat(container.querySelector('#add-ex-pct')?.value);
      const lift = _addLift || container.querySelector('.add-ex-lift.active')?.dataset.addLift;

      if (!name) {
        alert('Please enter an exercise name');
        return;
      }
      if (!lift) {
        alert('Please select a lift');
        return;
      }

      // Build primaryMuscles map from the muscle % inputs so custom exercises
      // participate in gap-analysis and fatigue calculations.
      const primaryMuscles = {};
      container.querySelectorAll('[data-add-muscle]').forEach((inp) => {
        const mg = inp.dataset.addMuscle;
        const pct = parseFloat(inp.value) || 0;
        if (pct > 0) primaryMuscles[mg] = pct / 100;
      });

      const newEx = {
        id: `custom-${Date.now()}`,
        name,
        mainLift: lift,
        weakPoints: [],
        pctOfTM: isNaN(pctRaw) ? 0 : pctRaw / 100,
        sets,
        repRange: [repMin, repMax],
        equipment: equip || 'barbell',
        category: 'custom',
        primaryMuscles,
      };

      store.customAccessories = [...(store.customAccessories || []), newEx];
      store.saveCustomAccessories();
      _showAddForm = false;
      _addLift = null;
      rerender(container);
    });
  }
}

function rerender(container) {
  container.innerHTML = renderExercisesTab();
  attachExercisesListeners(container);
  // Restore focus to search if it was active
  if (_searchQuery) {
    const input = container.querySelector('.exercise-search');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

/** Reset ephemeral state when settings modal opens */
export function resetExercisesTabState() {
  _liftFilter = 'all';
  _equipFilter = 'all';
  _searchQuery = '';
  _expandedId = null;
  _showAddForm = false;
}
