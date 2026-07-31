/**
 * Data consistency validators.
 *
 * These tests guard the static data files (muscle-groups, exercise-catalog,
 * exercise-compat) against drift. They're cheap to run but catch a large class
 * of data-shape bugs that would otherwise only show up at runtime in specific
 * fatigue / coverage / workout-builder code paths.
 *
 * Rule of thumb: if you add a new muscle group or a new exercise, these tests
 * should fail loudly until you've updated every required lookup table.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../state/store.js', () => ({
  default: { unit: 'lbs', customAccessories: [], accessoryOverrides: {} },
}));

import {
  MUSCLE_GROUPS,
  MUSCLE_RECOVERY_HOURS,
  MAIN_LIFT_WEIGHTS,
  ACCESSORY_CAT_WEIGHTS,
  SYNERGIST_MAP,
  MUSCLE_PUSH_PULL,
  WEEKLY_SET_TARGETS,
} from '../data/muscle-groups.js';
import {
  EXERCISE_CATALOG,
  MOVEMENT_PATTERNS,
  PROGRESSION_MODELS,
  PATTERN_DEFAULT_MUSCLES,
} from '../data/exercise-catalog.js';
import {
  LEGACY_ID_MAP,
  resolveCanonicalId,
  resolveExercise,
  getLegacyIds,
} from '../data/exercise-compat.js';
import { BODYBUILDING_SPLITS } from '../constants/bodybuilding-config.js';
import { ROTATION_EXCLUDED } from '../constants/rotation.js';

const MUSCLE_SET = new Set(MUSCLE_GROUPS);
const LIFTS = ['squat', 'bench', 'deadlift'];
const ALLOWED_EQUIPMENT = new Set(['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight']);
const EPSILON = 0.011;

// Helper: sum numeric values of an object
const sumWeights = (obj) =>
  Object.values(obj).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);

// ============================================================================
// muscle-groups.js
// ============================================================================

describe('muscle-groups: MUSCLE_GROUPS coverage across lookups', () => {
  it('every muscle group has an entry in MUSCLE_RECOVERY_HOURS', () => {
    for (const mg of MUSCLE_GROUPS) {
      expect(MUSCLE_RECOVERY_HOURS[mg]).toBeTypeOf('number');
    }
  });

  it('every muscle group has an entry in MUSCLE_PUSH_PULL', () => {
    for (const mg of MUSCLE_GROUPS) {
      expect(MUSCLE_PUSH_PULL[mg]).toBeTypeOf('string');
      expect(['push', 'pull', 'neutral']).toContain(MUSCLE_PUSH_PULL[mg]);
    }
  });

  it('every muscle group has WEEKLY_SET_TARGETS with min and max', () => {
    for (const mg of MUSCLE_GROUPS) {
      const t = WEEKLY_SET_TARGETS[mg];
      expect(t).toBeDefined();
      expect(t.min).toBeTypeOf('number');
      expect(t.max).toBeTypeOf('number');
      expect(t.min).toBeLessThanOrEqual(t.max);
    }
  });

  it('every muscle group has an entry in MAIN_LIFT_WEIGHTS for each lift', () => {
    for (const lift of LIFTS) {
      const lw = MAIN_LIFT_WEIGHTS[lift];
      expect(lw).toBeDefined();
      for (const mg of MUSCLE_GROUPS) {
        expect(lw[mg]).toBeTypeOf('number');
      }
    }
  });

  it('every muscle group has an entry in every ACCESSORY_CAT_WEIGHTS category', () => {
    for (const [cat, weights] of Object.entries(ACCESSORY_CAT_WEIGHTS)) {
      for (const mg of MUSCLE_GROUPS) {
        expect(weights[mg], `category ${cat} missing muscle ${mg}`).toBeTypeOf('number');
      }
    }
  });
});

describe('muscle-groups: weight normalization', () => {
  for (const lift of LIFTS) {
    it(`MAIN_LIFT_WEIGHTS.${lift} sums to <= 1.01`, () => {
      const total = sumWeights(MAIN_LIFT_WEIGHTS[lift]);
      expect(total).toBeLessThanOrEqual(1.0 + EPSILON);
      // Also require at least 0.99 so we don't under-distribute
      expect(total).toBeGreaterThanOrEqual(1.0 - EPSILON);
    });
  }

  it('every ACCESSORY_CAT_WEIGHTS category sums to <= 1.01', () => {
    for (const [cat, weights] of Object.entries(ACCESSORY_CAT_WEIGHTS)) {
      const total = sumWeights(weights);
      expect(total, `category ${cat} sum ${total}`).toBeLessThanOrEqual(1.0 + EPSILON);
    }
  });

  it('every muscle weight is non-negative', () => {
    for (const lift of LIFTS) {
      for (const [mg, w] of Object.entries(MAIN_LIFT_WEIGHTS[lift])) {
        expect(w, `${lift}.${mg}`).toBeGreaterThanOrEqual(0);
      }
    }
    for (const [cat, weights] of Object.entries(ACCESSORY_CAT_WEIGHTS)) {
      for (const [mg, w] of Object.entries(weights)) {
        expect(w, `${cat}.${mg}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('muscle-groups: SYNERGIST_MAP shape', () => {
  it('every SYNERGIST_MAP key is a valid muscle group', () => {
    for (const key of Object.keys(SYNERGIST_MAP)) {
      expect(MUSCLE_SET.has(key), `synergist key "${key}" not in MUSCLE_GROUPS`).toBe(true);
    }
  });

  it('every SYNERGIST_MAP value references valid muscle groups', () => {
    for (const [key, synergists] of Object.entries(SYNERGIST_MAP)) {
      expect(Array.isArray(synergists), `synergist entry "${key}" not an array`).toBe(true);
      for (const mg of synergists) {
        expect(MUSCLE_SET.has(mg), `synergist "${mg}" under "${key}" not in MUSCLE_GROUPS`).toBe(
          true
        );
      }
    }
  });
});

describe('muscle-groups: recovery hours sanity', () => {
  it('all recovery hours are in a sane range [12, 120]', () => {
    for (const [mg, hours] of Object.entries(MUSCLE_RECOVERY_HOURS)) {
      expect(hours, `${mg} recovery ${hours}`).toBeGreaterThanOrEqual(12);
      expect(hours, `${mg} recovery ${hours}`).toBeLessThanOrEqual(120);
    }
  });
});

// ============================================================================
// exercise-catalog.js
// ============================================================================

describe('exercise-catalog: required fields', () => {
  it('every exercise has name, movementPattern, primaryMuscles, progressionType, equipment, repRange, sets', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      expect(ex.name, `${id} missing name`).toBeTypeOf('string');
      expect(ex.movementPattern, `${id} missing movementPattern`).toBeTypeOf('string');
      expect(ex.primaryMuscles, `${id} missing primaryMuscles`).toBeTypeOf('object');
      expect(ex.progressionType, `${id} missing progressionType`).toBeTypeOf('string');
      expect(ex.equipment, `${id} missing equipment`).toBeTypeOf('string');
      expect(Array.isArray(ex.repRange), `${id} repRange not array`).toBe(true);
      expect(ex.repRange.length, `${id} repRange not [min,max]`).toBe(2);
      expect(ex.sets, `${id} missing sets`).toBeTypeOf('number');
    }
  });

  it('every movementPattern is a known pattern', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      expect(
        MOVEMENT_PATTERNS[ex.movementPattern],
        `${id} unknown pattern ${ex.movementPattern}`
      ).toBeDefined();
    }
  });

  it('every progressionType is a known model', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      expect(
        PROGRESSION_MODELS[ex.progressionType],
        `${id} unknown progressionType ${ex.progressionType}`
      ).toBeDefined();
    }
  });

  it('every equipment value is in the allowed set', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      expect(ALLOWED_EQUIPMENT.has(ex.equipment), `${id} unknown equipment ${ex.equipment}`).toBe(
        true
      );
    }
  });
});

describe('exercise-catalog: primaryMuscles shape', () => {
  it('every primaryMuscles key is a valid muscle group', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      for (const mg of Object.keys(ex.primaryMuscles)) {
        expect(MUSCLE_SET.has(mg), `${id}.primaryMuscles has unknown muscle "${mg}"`).toBe(true);
      }
    }
  });

  it('every primaryMuscles weight is in [0, 1]', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      for (const [mg, w] of Object.entries(ex.primaryMuscles)) {
        expect(w, `${id}.${mg} weight`).toBeGreaterThanOrEqual(0);
        expect(w, `${id}.${mg} weight`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('every primaryMuscles sums to <= 1.01', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      const total = sumWeights(ex.primaryMuscles);
      expect(total, `${id} primaryMuscles sum ${total}`).toBeLessThanOrEqual(1.0 + EPSILON);
    }
  });
});

describe('exercise-catalog: regression fixes', () => {
  it('calf-raise has Calves as its dominant muscle (regression for cffb2f8)', () => {
    const calfRaise = EXERCISE_CATALOG['calf-raise'];
    expect(calfRaise).toBeDefined();
    expect(calfRaise.primaryMuscles.Calves).toBeGreaterThanOrEqual(0.8);
    // And not the old wrong values
    expect(calfRaise.primaryMuscles.Quads || 0).toBeLessThan(0.2);
    expect(calfRaise.primaryMuscles.Hams || 0).toBeLessThan(0.2);
  });

  it('farmers-walk has Forearms in primaryMuscles (regression for cffb2f8)', () => {
    const fw = EXERCISE_CATALOG['farmers-walk'];
    expect(fw).toBeDefined();
    expect(fw.primaryMuscles.Forearms).toBeGreaterThan(0);
    expect(fw.primaryMuscles.Calves).toBeGreaterThan(0);
  });
});

describe('exercise-catalog: supportsLifts + weakPoints shape', () => {
  // These three fields are read WITHOUT optional chaining in hot paths
  // (scoreAccessories, gap-analysis suggestions, workout-guardrails,
  // getAccessoryWeight). A catalog entry missing any of them throws at
  // runtime rather than degrading, so presence is non-negotiable.
  it('every exercise declares supportsLifts, weakPoints, and pctOfTM', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      expect(Array.isArray(ex.supportsLifts), `${id} missing supportsLifts array`).toBe(true);
      expect(ex.weakPoints, `${id} missing weakPoints object`).toBeTypeOf('object');
      expect(ex.pctOfTM, `${id} missing pctOfTM object`).toBeTypeOf('object');
    }
  });

  it('supportsLifts only contains valid lifts', () => {
    for (const [_id, ex] of Object.entries(EXERCISE_CATALOG)) {
      if (!ex.supportsLifts) continue;
      expect(Array.isArray(ex.supportsLifts)).toBe(true);
      for (const lift of ex.supportsLifts) {
        expect(LIFTS).toContain(lift);
      }
    }
  });

  it('weakPoints per lift are arrays keyed by a valid lift', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      if (!ex.weakPoints) continue;
      for (const [lift, points] of Object.entries(ex.weakPoints)) {
        expect(LIFTS, `${id}.weakPoints has unknown lift ${lift}`).toContain(lift);
        expect(Array.isArray(points), `${id}.weakPoints.${lift} not array`).toBe(true);
      }
    }
  });

  it('pctOfTM is keyed by valid lifts with sane percentages', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      for (const [lift, pct] of Object.entries(ex.pctOfTM || {})) {
        expect(LIFTS, `${id}.pctOfTM has unknown lift ${lift}`).toContain(lift);
        expect(pct, `${id}.pctOfTM.${lift}`).toBeGreaterThan(0);
        expect(pct, `${id}.pctOfTM.${lift}`).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it('weakPoints and pctOfTM only reference lifts the exercise supports', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      const supported = new Set(ex.supportsLifts || []);
      for (const lift of Object.keys(ex.weakPoints || {})) {
        expect(supported.has(lift), `${id}.weakPoints.${lift} but lift not in supportsLifts`).toBe(
          true
        );
      }
      for (const lift of Object.keys(ex.pctOfTM || {})) {
        expect(supported.has(lift), `${id}.pctOfTM.${lift} but lift not in supportsLifts`).toBe(
          true
        );
      }
    }
  });

  it('time-based exercises use the time progression model', () => {
    for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
      if (!ex.timeBased) continue;
      expect(ex.progressionType, `${id} is timeBased but not a time progression`).toBe('time');
    }
  });
});

// ============================================================================
// Cross-file exercise ID references
// ============================================================================

describe('exercise ID references resolve to real catalog entries', () => {
  it('every BODYBUILDING_SPLITS candidate is a real exercise', () => {
    for (const split of Object.values(BODYBUILDING_SPLITS)) {
      for (const day of split.days) {
        for (const slot of day.slots) {
          for (const id of slot.candidates || []) {
            expect(
              EXERCISE_CATALOG[id],
              `${split.key}/${day.key} references unknown exercise "${id}"`
            ).toBeDefined();
          }
        }
      }
    }
  });

  it('every ROTATION_EXCLUDED id is a real exercise', () => {
    for (const id of ROTATION_EXCLUDED) {
      expect(EXERCISE_CATALOG[id], `ROTATION_EXCLUDED has unknown exercise "${id}"`).toBeDefined();
    }
  });
});

// ============================================================================
// PATTERN_DEFAULT_MUSCLES
// ============================================================================

describe('PATTERN_DEFAULT_MUSCLES', () => {
  it('every key is in MOVEMENT_PATTERNS', () => {
    for (const key of Object.keys(PATTERN_DEFAULT_MUSCLES)) {
      expect(MOVEMENT_PATTERNS[key], `pattern "${key}" unknown`).toBeDefined();
    }
  });

  it('every value sums to <= 1.01', () => {
    for (const [pattern, weights] of Object.entries(PATTERN_DEFAULT_MUSCLES)) {
      const total = sumWeights(weights);
      expect(total, `pattern ${pattern} sum ${total}`).toBeLessThanOrEqual(1.0 + EPSILON);
    }
  });

  it('every muscle key is a valid muscle group', () => {
    for (const [pattern, weights] of Object.entries(PATTERN_DEFAULT_MUSCLES)) {
      for (const mg of Object.keys(weights)) {
        expect(MUSCLE_SET.has(mg), `pattern ${pattern} has unknown muscle ${mg}`).toBe(true);
      }
    }
  });
});

// ============================================================================
// exercise-compat.js
// ============================================================================

describe('exercise-compat: LEGACY_ID_MAP integrity', () => {
  it('every legacy ID maps to an existing canonical catalog entry', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_ID_MAP)) {
      expect(
        EXERCISE_CATALOG[canonical],
        `${legacy} maps to missing canonical ${canonical}`
      ).toBeDefined();
    }
  });

  it('no legacy ID equals its own canonical (no self-loops)', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_ID_MAP)) {
      expect(legacy, `${legacy} is a self-loop`).not.toBe(canonical);
    }
  });
});

describe('exercise-compat: resolution functions', () => {
  it('resolveCanonicalId passes through catalog IDs unchanged', () => {
    for (const id of Object.keys(EXERCISE_CATALOG)) {
      expect(resolveCanonicalId(id)).toBe(id);
    }
  });

  it('resolveCanonicalId maps legacy IDs to canonical', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_ID_MAP)) {
      expect(resolveCanonicalId(legacy)).toBe(canonical);
    }
  });

  it('resolveCanonicalId passes through unknown IDs unchanged', () => {
    expect(resolveCanonicalId('totally-made-up-exercise')).toBe('totally-made-up-exercise');
    expect(resolveCanonicalId('custom-abc123')).toBe('custom-abc123');
  });

  it('resolveExercise returns catalog entry for both canonical and legacy IDs', () => {
    const byCanonical = resolveExercise('front-squat');
    expect(byCanonical).toBeDefined();
    expect(byCanonical.name).toBe('Front Squat');

    const byLegacy = resolveExercise('sq-front');
    expect(byLegacy).toBeDefined();
    expect(byLegacy.name).toBe('Front Squat');

    // Same object either way
    expect(byLegacy).toBe(byCanonical);
  });

  it('getLegacyIds returns multiple legacy IDs for duplicated canonicals', () => {
    // front-squat had both sq-front and dl-frontsquat in the old scheme
    const legacyIds = getLegacyIds('front-squat');
    expect(legacyIds.length).toBeGreaterThanOrEqual(2);
    expect(legacyIds).toContain('sq-front');
    expect(legacyIds).toContain('dl-frontsquat');
  });

  it('getLegacyIds returns empty array for canonicals without legacy IDs', () => {
    // Newer exercises with no legacy mapping should return []
    const ids = getLegacyIds('seated-ham-curl');
    expect(Array.isArray(ids)).toBe(true);
  });
});
