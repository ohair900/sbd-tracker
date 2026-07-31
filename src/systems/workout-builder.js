/**
 * Workout builder — accessory selection, scoring, set-weight ramping,
 * weight progression, and smart accessory picking.
 *
 * The "smart" system scores accessories based on weak-point alignment,
 * recency, muscle-group fatigue, progression readiness, and completion
 * rate, then picks a diverse set across categories and equipment types.
 */

import store from '../state/store.js';
import { ACCESSORY_DB } from '../data/accessories.js';
import { ACCESSORY_CAT_WEIGHTS, MUSCLE_GROUPS } from '../data/muscle-groups.js';
import { EXERCISE_CATALOG, PROGRESSION_MODELS } from '../data/exercise-catalog.js';
import {
  TRAVEL_GROUPINGS,
  GROUPING_LIFT_CONTEXT,
  TRAVEL_SET_DEFAULTS,
  TRAVEL_SET_DEFAULTS_FALLBACK,
} from '../constants/travel-config.js';
import {
  resolveExercise,
  resolveCanonicalId,
  resolveAccessory,
  getExerciseHistory,
} from '../data/exercise-compat.js';
import { MS_PER_DAY } from '../constants/time.js';
import {
  SET_RAMP_PERCENTAGES,
  SET_RAMP_MODERATE,
  SET_RAMP_FATIGUED,
} from '../constants/thresholds.js';
import { roundToPlate } from '../formulas/plates.js';
import { bestE1RM } from '../formulas/e1rm.js';
import { calcFatigueByMuscle } from '../systems/fatigue.js';
import { ROTATION_EXCLUDED, REP_TIERS } from '../constants/rotation.js';

// ---------------------------------------------------------------------------
// Rep-tier rotation (auto-periodized accessories)
// ---------------------------------------------------------------------------

/**
 * Determine the next rep tier for an exercise by inspecting its most recent
 * session in the accessory log. Cycles: heavy → moderate → light → heavy.
 *
 * @param {string} exerciseId
 * @returns {'heavy' | 'moderate' | 'light' | null} null if exercise is excluded from rotation
 */
export function getNextTier(exerciseId) {
  if (ROTATION_EXCLUDED.has(exerciseId)) return null;

  const history = getExerciseHistory(exerciseId, store.accessoryLog);
  if (history.length === 0) return 'moderate';

  const last = history[0];
  const avgReps =
    last.setsCompleted && last.setsCompleted.length > 0
      ? last.setsCompleted.reduce((s, r) => s + r, 0) / last.setsCompleted.length
      : 10;

  if (avgReps <= 6) return 'moderate';
  if (avgReps <= 12) return 'light';
  return 'heavy';
}

/**
 * Estimate the right working weight for a given rep tier using Epley e1RM
 * from the exercise's last performance.
 *
 * @param {string} exerciseId
 * @param {string} tier - 'heavy' | 'moderate' | 'light'
 * @param {string} mainLift
 * @returns {number} Working weight rounded to plates
 */
export function getWeightForTier(exerciseId, tier, mainLift) {
  const history = getExerciseHistory(exerciseId, store.accessoryLog);
  if (history.length === 0) return getAccessoryWeight(exerciseId, mainLift);

  const last = history[0];
  const lastWeight = last.setWeights
    ? last.setWeights[last.setWeights.length - 1]
    : last.weight || 0;
  const lastReps =
    last.setsCompleted && last.setsCompleted.length > 0
      ? last.setsCompleted.reduce((s, r) => s + r, 0) / last.setsCompleted.length
      : 10;

  if (lastWeight === 0) return 0; // bodyweight exercise

  const e1rm = lastWeight * (1 + lastReps / 30);
  const tierInfo = REP_TIERS[tier];
  const targetReps = (tierInfo.repRange[0] + tierInfo.repRange[1]) / 2;
  return roundToPlate(e1rm / (1 + targetReps / 30));
}

// ---------------------------------------------------------------------------
// Accessory selection (simple wrapper)
// ---------------------------------------------------------------------------

/**
 * Select the default number (5) of smart accessories for a main lift.
 *
 * @param {string} mainLift - 'squat' | 'bench' | 'deadlift'
 * @returns {Object[]} Scored and selected accessories
 */
export function selectAccessories(mainLift) {
  return selectSmartAccessories(mainLift, 5);
}

// ---------------------------------------------------------------------------
// Set-weight ramping
// ---------------------------------------------------------------------------

/**
 * Compute ramped set weights for a given working weight and number of sets.
 * Sets ramp from lighter warm-up percentages up to 100 % of working weight.
 * If `workingWeight` is 0, returns an array of zeros.
 *
 * Optionally accepts a fatigue status to select a tempered ramp profile (#6).
 * Only applies to builder-generated ramps, not program templates.
 *
 * @param {number} workingWeight - Target working weight
 * @param {number} numSets       - Number of sets
 * @param {string} [fatigueStatus] - 'red'|'orange'|'yellow'|'lime'|'green' (optional)
 * @returns {number[]} Rounded weights for each set
 */
export function computeSetWeights(workingWeight, numSets, fatigueStatus) {
  if (workingWeight === 0) return Array(numSets).fill(0);
  if (workingWeight < 0) return Array(numSets).fill(roundToPlate(workingWeight));

  let rampTable = SET_RAMP_PERCENTAGES;
  if (fatigueStatus === 'red' || fatigueStatus === 'orange') {
    rampTable = SET_RAMP_FATIGUED;
  } else if (fatigueStatus === 'yellow') {
    rampTable = SET_RAMP_MODERATE;
  }

  const pcts = rampTable[numSets] || rampTable[3] || SET_RAMP_PERCENTAGES[3];
  return pcts.map((p) => roundToPlate(workingWeight * p));
}

// ---------------------------------------------------------------------------
// Bodybuilding split targets
// ---------------------------------------------------------------------------

/**
 * Build an accessory-row target for one resolved bodybuilding split slot.
 *
 * Intentionally simpler than the accessory engine: clean role-based rep ranges
 * (no per-exercise catalog ranges), history-seeded double progression, and NO
 * SBD-TM seeding or fatigue weight scalar — those are the noise sources that
 * make output feel random. Straight sets (flat weight), not a ramp.
 *
 * - Competition lifts (no catalog id): seed weight from the lift's e1RM at the
 *   middle of the rep range (auto-progresses as the real max climbs).
 * - Accessories: repeat last weight, climbing reps; when all sets hit the top
 *   of the range, add the catalog increment and reset reps to the bottom.
 *   First time (no history): weight 0 for the user to enter; it self-seeds.
 *
 * @param {Object} slot - A resolved slot from getSplitDay()
 * @returns {Object} Accessory-row object for the workout session
 */
export function computeSplitTargets(slot) {
  const { sets: targetSets, repRange } = slot.scheme;
  const [lo, hi] = repRange;

  // Competition lift — seed from e1RM, log toward the SBD max later.
  if (slot.isCompLift) {
    const e1rm = bestE1RM(slot.compLift);
    const midReps = Math.round((lo + hi) / 2);
    const weight = e1rm ? roundToPlate(e1rm / (1 + midReps / 30)) : 0;
    return {
      exerciseId: slot.compLift,
      name: slot.name,
      compLift: slot.compLift,
      setWeights: Array(targetSets).fill(weight),
      targetSets,
      repRange: [lo, hi],
      equipment: slot.equipment,
      setsCompleted: [],
      progressed: false,
      _targetReps: Array(targetSets).fill(midReps),
    };
  }

  // Accessory — history-based double progression on the clean scheme.
  const exerciseId = slot.exerciseId;
  const catalogEx = EXERCISE_CATALOG[exerciseId];
  const progressionType = catalogEx ? catalogEx.progressionType : 'compound';
  const canonId = resolveCanonicalId(exerciseId);
  const history = getExerciseHistory(canonId, store.accessoryLog);
  const recent = history[0];

  let weight = 0;
  let progressed = false;
  let reps = lo;
  if (recent) {
    const lastWeight = recent.setWeights
      ? recent.setWeights[recent.setWeights.length - 1]
      : recent.weight || 0;
    const allHitTop =
      recent.setsCompleted &&
      recent.setsCompleted.length >= targetSets &&
      recent.setsCompleted.every((r) => r >= hi);
    if (allHitTop && lastWeight > 0) {
      const model = PROGRESSION_MODELS[progressionType];
      const bump = model?.increment
        ? store.unit === 'kg'
          ? model.increment.kg
          : model.increment.lbs
        : store.unit === 'kg'
          ? 2.5
          : 5;
      weight = roundToPlate(lastWeight + bump);
      progressed = true;
      reps = lo; // reset to bottom of range after a weight bump
    } else {
      weight = lastWeight;
      reps = hi; // keep climbing reps toward the top
    }
  }

  return {
    exerciseId,
    name: slot.name,
    compLift: null,
    setWeights: Array(targetSets).fill(weight),
    targetSets,
    repRange: [lo, hi],
    equipment: slot.equipment,
    setsCompleted: [],
    progressed,
    _targetReps: Array(targetSets).fill(reps),
  };
}

// ---------------------------------------------------------------------------
// Accessory weight determination
// ---------------------------------------------------------------------------

/**
 * Determine the working weight for an accessory exercise.
 *
 * Uses the new catalog + compat layer when available, falling back to
 * the legacy ACCESSORY_DB for exercises not yet in the catalog.
 *
 * Priority order:
 *  1. Most recent accessory log entry (merged across legacy IDs)
 *     with category-specific progression bump if earned
 *  2. Percentage of the main lift's training max
 *  3. Percentage of the main lift's best e1RM * 0.9
 *  4. Zero (bodyweight exercises or no data)
 *
 * @param {string} exerciseId - Key in EXERCISE_CATALOG or ACCESSORY_DB
 * @param {string} mainLift   - 'squat' | 'bench' | 'deadlift'
 * @returns {number} Working weight (rounded to nearest plate increment)
 */
export function getAccessoryWeight(exerciseId, mainLift) {
  // Try catalog first, then legacy DB
  const catalogEx = resolveExercise(exerciseId);
  const legacyEx = ACCESSORY_DB[exerciseId];
  const ex = catalogEx || legacyEx;
  if (!ex) return 0;

  const progressionType = catalogEx ? catalogEx.progressionType : 'compound';

  // Bodyweight exercises: weight can be negative (assisted), 0 (BW), or positive (weighted)
  if (progressionType === 'bodyweight') {
    const canonId = resolveCanonicalId(exerciseId);
    const history = getExerciseHistory(canonId, store.accessoryLog);
    const recent = history[0];
    if (!recent) return 0; // Default to bodyweight (0)

    const topOfRange = ex.repRange ? ex.repRange[1] : 12;
    const allHitTop =
      recent.setsCompleted.length >= recent.targetSets &&
      recent.setsCompleted.every((reps) => reps >= topOfRange);
    if (allHitTop) {
      const model = PROGRESSION_MODELS['bodyweight'];
      const bump = store.unit === 'kg' ? model.increment.kg : model.increment.lbs;
      // Assisted (negative): reduce assistance toward 0. BW/weighted: add weight.
      return recent.weight + bump;
    }
    return recent.weight;
  }

  // Time-based exercises: honor pctOfTM if set (e.g., farmer's walk), else return 0
  if (progressionType === 'time') {
    const pctOfTM = catalogEx ? catalogEx.pctOfTM[mainLift] || 0 : 0;
    if (pctOfTM <= 0) return 0;

    // Use history first if available
    const canonId = resolveCanonicalId(exerciseId);
    const history = getExerciseHistory(canonId, store.accessoryLog);
    const recent = history[0];
    if (recent && recent.weight > 0) return recent.weight;

    // Compute from TM
    const tm = store.programConfig.trainingMaxes[mainLift];
    if (tm) return roundToPlate(tm * pctOfTM);
    const e1rm = bestE1RM(mainLift);
    if (e1rm) return roundToPlate(e1rm * 0.9 * pctOfTM);
    return 0;
  }

  // Legacy bodyweight check (no catalog entry)
  if (!catalogEx && legacyEx && legacyEx.pctOfTM === 0) return 0;

  const pctOfTM = catalogEx ? catalogEx.pctOfTM[mainLift] || 0 : legacyEx ? legacyEx.pctOfTM : 0;

  // Close-variation: always recalculate from TM (auto-scales when TM changes)
  if (progressionType === 'close-variation' && pctOfTM > 0) {
    const tm = store.programConfig.trainingMaxes[mainLift];
    let baseWeight = 0;
    if (tm) baseWeight = roundToPlate(tm * pctOfTM);
    else {
      const e1rm = bestE1RM(mainLift);
      if (e1rm) baseWeight = roundToPlate(e1rm * 0.9 * pctOfTM);
      else {
        // Fallback: try any other lift's TM/e1RM as proxy
        for (const lift of ['squat', 'bench', 'deadlift']) {
          if (lift === mainLift) continue;
          const otherTm = store.programConfig.trainingMaxes[lift];
          if (otherTm) {
            baseWeight = roundToPlate(otherTm * pctOfTM);
            break;
          }
          const otherE1rm = bestE1RM(lift);
          if (otherE1rm) {
            baseWeight = roundToPlate(otherE1rm * 0.9 * pctOfTM);
            break;
          }
        }
      }
    }
    // Close-variation: smaller fatigue reduction (0.90 floor)
    return applyFatigueScalar(baseWeight, catalogEx, 0.9);
  }

  // Merge history from all legacy IDs for this exercise
  const canonId = resolveCanonicalId(exerciseId);
  const history = getExerciseHistory(canonId, store.accessoryLog);
  const recent = history[0];

  if (recent) {
    const topOfRange = ex.repRange ? ex.repRange[1] : recent.repRange ? recent.repRange[1] : 12;
    const allHitTop =
      recent.setsCompleted.length >= recent.targetSets &&
      recent.setsCompleted.every((reps) => reps >= topOfRange);

    if (allHitTop) {
      const model = PROGRESSION_MODELS[progressionType];
      let bump;
      if (model && model.increment) {
        bump = store.unit === 'kg' ? model.increment.kg : model.increment.lbs;
      } else {
        bump =
          mainLift === 'bench' ? (store.unit === 'kg' ? 2.5 : 5) : store.unit === 'kg' ? 5 : 10;
      }
      return applyFatigueScalar(roundToPlate(recent.weight + bump), catalogEx);
    }
    return applyFatigueScalar(recent.weight, catalogEx);
  }

  // Initial weight from TM (try current lift first, then any supported lift)
  if (pctOfTM > 0) {
    const tm = store.programConfig.trainingMaxes[mainLift];
    if (tm) return applyFatigueScalar(roundToPlate(tm * pctOfTM), catalogEx);
    const e1rm = bestE1RM(mainLift);
    if (e1rm) return applyFatigueScalar(roundToPlate(e1rm * 0.9 * pctOfTM), catalogEx);
  }

  // Fallback: try other supported lifts if pctOfTM exists for them
  if (catalogEx && catalogEx.pctOfTM) {
    for (const [lift, pct] of Object.entries(catalogEx.pctOfTM)) {
      if (lift === mainLift || pct <= 0) continue;
      const tm = store.programConfig.trainingMaxes[lift];
      if (tm) return applyFatigueScalar(roundToPlate(tm * pct), catalogEx);
      const e1rm = bestE1RM(lift);
      if (e1rm) return applyFatigueScalar(roundToPlate(e1rm * 0.9 * pct), catalogEx);
    }
  }

  return 0;
}

// Fatigue-scaled accessory weight (#5)
const FATIGUE_WEIGHT_SCALAR = { green: 1.0, lime: 1.0, yellow: 0.95, orange: 0.9, red: 0.85 };
const DISPLAY_STATUS_ORDER = { green: 0, lime: 1, yellow: 2, orange: 3, red: 4 };

function applyFatigueScalar(weight, catalogEx, floor = 0.85) {
  if (!weight || weight <= 0 || !catalogEx?.primaryMuscles) return weight;
  const muscleFatigue = calcFatigueByMuscle();
  if (!muscleFatigue) return weight;

  let worstStatus = 'green';
  for (const [mg, mw] of Object.entries(catalogEx.primaryMuscles)) {
    if (mw > 0.15 && muscleFatigue[mg]) {
      const ds = muscleFatigue[mg].displayStatus || 'green';
      if (DISPLAY_STATUS_ORDER[ds] > DISPLAY_STATUS_ORDER[worstStatus]) worstStatus = ds;
    }
  }
  const scalar = Math.max(floor, FATIGUE_WEIGHT_SCALAR[worstStatus] || 1.0);
  if (scalar >= 1.0) return weight;
  return roundToPlate(weight * scalar);
}

// ---------------------------------------------------------------------------
// Accessory progression check
// ---------------------------------------------------------------------------

/**
 * Check whether an accessory exercise is ready for a weight increase
 * (double progression: all prescribed sets completed at the top of the rep range).
 *
 * @param {string} exerciseId - Key in EXERCISE_CATALOG or ACCESSORY_DB
 * @param {string} mainLift   - 'squat' | 'bench' | 'deadlift'
 * @returns {boolean}
 */
export function checkAccessoryProgression(exerciseId, mainLift) {
  const catalogEx = resolveExercise(exerciseId);
  const legacyEx = ACCESSORY_DB[exerciseId];
  const ex = catalogEx || legacyEx;
  if (!ex) return false;

  const pctOfTM = catalogEx ? catalogEx.pctOfTM[mainLift] || 0 : legacyEx ? legacyEx.pctOfTM : 0;
  if (pctOfTM === 0 && !catalogEx?.pctOfTM) return false;

  const canonId = resolveCanonicalId(exerciseId);
  const history = getExerciseHistory(canonId, store.accessoryLog);
  const recent = history[0];
  if (!recent) return false;
  const topOfRange = ex.repRange ? ex.repRange[1] : 12;
  const allHitTop =
    recent.setsCompleted.length >= recent.targetSets &&
    recent.setsCompleted.every((reps) => reps >= topOfRange);
  if (!allHitTop) return false;

  // Fatigue gate: hold weight if primary muscles are red/orange (#2)
  const progressionType = catalogEx ? catalogEx.progressionType : 'compound';
  if (progressionType !== 'bodyweight' && progressionType !== 'time') {
    const muscleFatigue = calcFatigueByMuscle();
    if (muscleFatigue) {
      const primaryMuscles = catalogEx ? catalogEx.primaryMuscles : null;
      if (primaryMuscles) {
        for (const [mg, weight] of Object.entries(primaryMuscles)) {
          if (weight > 0.2 && muscleFatigue[mg]) {
            const ds = muscleFatigue[mg].displayStatus;
            if (ds === 'red' || ds === 'orange') return false;
          }
        }
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Accessory scoring
// ---------------------------------------------------------------------------

/**
 * Score every accessory for a main lift based on:
 *  - Weak-point alignment (+25)
 *  - Recency — days since last performed (up to +20)
 *  - Muscle-group fatigue (green +5, red -10)
 *  - Progression readiness (+10)
 *  - Completion-rate penalty (low -15, moderate -5)
 *  - Equipment availability (available +0, unavailable -50)
 *
 * Uses EXERCISE_CATALOG for cross-lift support. Falls back to legacy
 * ACCESSORY_DB for exercises not yet in the catalog.
 *
 * @param {string} mainLift - 'squat' | 'bench' | 'deadlift'
 * @param {Object} [options]
 * @param {string} [options.excludeEquipment] - Equipment type to exclude
 * @param {boolean} [options.crossLift=true] - Include exercises from other lifts
 * @param {Object} [options.equipmentOverride] - Session-scoped equipment map (does not persist)
 * @returns {Object[]} Scored accessories sorted by score descending
 */
export function scoreAccessories(mainLift, options = {}) {
  const { excludeEquipment = null, crossLift = true, equipmentOverride = null } = options;
  const weakPoint = store.workoutConfig.weakPoints[mainLift];
  const now = Date.now();
  const muscleFatigue = calcFatigueByMuscle();
  const equip = equipmentOverride || store.equipmentProfile || {};
  const disabledSet = new Set(store.disabledAccessories || []);

  // Build candidate list from EXERCISE_CATALOG (canonical, cross-lift)
  const candidates = [];
  const seenCanonical = new Set();

  for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
    if (disabledSet.has(id)) continue;
    // Apply user overrides
    const resolved = resolveAccessory(id) || ex;
    if (excludeEquipment && resolved.equipment === excludeEquipment) continue;
    const supportsThisLift = ex.supportsLifts.includes(mainLift);
    if (!crossLift && !supportsThisLift) continue;

    let score = 0;
    const r = [];

    // Equipment availability: available is neutral, unavailable is heavily penalized (grayed out)
    const equipAvailable = equip[ex.equipment] !== false;
    if (!equipAvailable) {
      score -= 50;
      r.push('Equipment unavailable');
    }

    // Weak point alignment
    const exerciseWeakPoints = ex.weakPoints[mainLift] || [];
    if (weakPoint && exerciseWeakPoints.includes(weakPoint)) {
      score += 25;
      r.push('Targets weak point');
    }

    // Cross-lift relevance penalty (exercises that don't directly support this lift)
    if (!supportsThisLift) {
      score -= 15;
      r.push('Cross-lift exercise');
    }

    // Recency — merge history from all legacy IDs
    const history = getExerciseHistory(id, store.accessoryLog);
    const recent = history[0];
    if (recent) {
      const daysSince = Math.floor((now - recent.timestamp) / MS_PER_DAY);
      const recencyScore = Math.min(20, daysSince * 2);
      score += recencyScore;
      if (daysSince >= 5) r.push(`${daysSince}d since last`);
    } else {
      score += 20;
      r.push('Not yet performed');
    }

    // Muscle group fatigue
    if (muscleFatigue && ex.primaryMuscles) {
      for (const [mg, weight] of Object.entries(ex.primaryMuscles)) {
        if (weight > 0.15 && muscleFatigue[mg]) {
          if (muscleFatigue[mg].status === 'green') score += 5;
          else if (muscleFatigue[mg].status === 'red') {
            score -= 10;
            r.push(`${mg} fatigued`);
          }
        }
      }
    }

    // Progression readiness
    if (recent && checkAccessoryProgression(id, mainLift)) {
      score += 10;
      r.push('Ready for weight increase');
    }

    // Completion rate penalty
    const last5 = history.slice(0, 5);
    if (last5.length >= 2) {
      const avgCompletion =
        last5.reduce(
          (sum, log) => sum + log.setsCompleted.length / Math.max(log.targetSets, 1),
          0
        ) / last5.length;
      if (avgCompletion < 0.5) {
        score -= 15;
        r.push('Low completion rate');
      } else if (avgCompletion < 0.75) {
        score -= 5;
        r.push('Moderate completion');
      }
    }

    candidates.push({
      id,
      ...ex,
      score,
      reasons: r,
      equipAvailable,
      movementPattern: ex.movementPattern,
      canonicalId: id,
    });
    seenCanonical.add(id);
  }

  // Also include legacy-only exercises not yet in catalog
  for (const [id, ex] of Object.entries(ACCESSORY_DB)) {
    const canonId = resolveCanonicalId(id);
    if (seenCanonical.has(canonId)) continue; // Already in catalog
    if (disabledSet.has(canonId)) continue;
    if (ex.mainLift !== mainLift) continue;
    if (excludeEquipment && ex.equipment === excludeEquipment) continue;

    let score = 0;
    const r = [];
    if (weakPoint && ex.weakPoints.includes(weakPoint)) {
      score += 25;
      r.push('Targets weak point');
    }
    const recentLogs = store.accessoryLog
      .filter((l) => l.exerciseId === id)
      .sort((a, b) => b.timestamp - a.timestamp);
    const recent = recentLogs[0];
    if (recent) {
      const daysSince = Math.floor((now - recent.timestamp) / MS_PER_DAY);
      score += Math.min(20, daysSince * 2);
      if (daysSince >= 5) r.push(`${daysSince}d since last`);
    } else {
      score += 20;
      r.push('Not yet performed');
    }
    if (muscleFatigue) {
      const catWeights = ACCESSORY_CAT_WEIGHTS[ex.category];
      if (catWeights) {
        MUSCLE_GROUPS.forEach((mg) => {
          if (catWeights[mg] > 0 && muscleFatigue[mg]) {
            if (muscleFatigue[mg].status === 'green') score += 5;
            else if (muscleFatigue[mg].status === 'red') {
              score -= 10;
              r.push(`${mg} fatigued`);
            }
          }
        });
      }
    }
    candidates.push({ id, ...ex, score, reasons: r, equipAvailable: true, canonicalId: canonId });
    seenCanonical.add(canonId);
  }

  // Include user-created custom exercises
  for (const custom of store.customAccessories || []) {
    if (seenCanonical.has(custom.id)) continue;
    if (disabledSet.has(custom.id)) continue;
    if (custom.mainLift !== mainLift) continue;
    if (excludeEquipment && custom.equipment === excludeEquipment) continue;

    let score = 0;
    const r = [];
    const customEquip = equipmentOverride || store.equipmentProfile || {};
    const equipAvailable = customEquip[custom.equipment] !== false;
    if (!equipAvailable) {
      score -= 50;
      r.push('Equipment unavailable');
    }
    if (weakPoint && Array.isArray(custom.weakPoints) && custom.weakPoints.includes(weakPoint)) {
      score += 25;
      r.push('Targets weak point');
    }
    const history = getExerciseHistory(custom.id, store.accessoryLog);
    const recent = history[0];
    if (recent) {
      const daysSince = Math.floor((now - recent.timestamp) / MS_PER_DAY);
      score += Math.min(20, daysSince * 2);
      if (daysSince >= 5) r.push(`${daysSince}d since last`);
    } else {
      score += 20;
      r.push('Not yet performed');
    }

    candidates.push({
      id: custom.id,
      ...custom,
      score,
      reasons: r,
      equipAvailable,
      canonicalId: custom.id,
    });
    seenCanonical.add(custom.id);
  }

  return candidates.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Smart accessory selection
// ---------------------------------------------------------------------------

/**
 * Pick `count` accessories using a multi-pass strategy:
 *  1. One per movement pattern (highest scorer)
 *  2. Equipment diversity
 *  3. Pure score fill
 *
 * Only includes exercises with available equipment in first two passes.
 * Unavailable-equipment exercises can fill in pass 3 if needed.
 *
 * @param {string} mainLift - 'squat' | 'bench' | 'deadlift'
 * @param {number} [count=5] - Number of accessories to select
 * @param {Object} [options]
 * @param {Object} [options.equipmentOverride] - Session-scoped equipment map
 * @returns {Object[]} Selected accessories (subset of scoreAccessories output)
 */
export function selectSmartAccessories(mainLift, count, options = {}) {
  count = count || 5;
  // Only score exercises that support this lift (no cross-lift in auto-selection)
  const scored = scoreAccessories(mainLift, {
    crossLift: false,
    equipmentOverride: options.equipmentOverride || null,
  });
  const available = scored.filter((ex) => ex.equipAvailable !== false);
  const picked = [];
  const usedPatterns = new Set();
  const usedEquip = new Set();

  // Pass 1: one per movement pattern (highest scorer, available equipment only)
  for (const ex of available) {
    if (picked.length >= count) break;
    const pattern = ex.movementPattern || ex.category;
    if (!usedPatterns.has(pattern)) {
      picked.push(ex);
      usedPatterns.add(pattern);
      usedEquip.add(ex.equipment);
    }
  }

  // Pass 2: equipment diversity (available equipment only)
  for (const ex of available) {
    if (picked.length >= count) break;
    if (!picked.some((p) => p.id === ex.id) && !usedEquip.has(ex.equipment)) {
      picked.push(ex);
      usedEquip.add(ex.equipment);
    }
  }

  // Pass 3: pure score (still only exercises that support this lift)
  for (const ex of scored) {
    if (picked.length >= count) break;
    if (!picked.some((p) => p.id === ex.id)) picked.push(ex);
  }

  return picked;
}

// ---------------------------------------------------------------------------
// Travel workout selection — fatigue-aware, equipment-scoped
// ---------------------------------------------------------------------------

/**
 * Select exercises for a travel (off-program) session.
 *
 * Skips red-fatigued muscles entirely, down-weights orange/yellow muscles,
 * and filters to the session-scoped equipment override.
 *
 * @param {string} grouping - 'push' | 'pull' | 'legs' | 'full'
 * @param {Object} equipmentOverride - Session-scoped equipment map
 * @returns {{ exercises: Object[], skippedMuscles: string[] }}
 */
export function selectTravelWorkout(grouping, equipmentOverride) {
  const cfg = TRAVEL_GROUPINGS[grouping];
  if (!cfg) return { exercises: [], skippedMuscles: [] };

  const muscleFatigue = calcFatigueByMuscle() || {};
  const disabledSet = new Set(store.disabledAccessories || []);
  const equip = equipmentOverride || store.equipmentProfile || {};
  const now = Date.now();

  // Determine eligible (non-red) and downweighted (orange/yellow) muscles
  const eligibleMuscles = new Set(
    cfg.muscles.filter((m) => muscleFatigue[m]?.displayStatus !== 'red')
  );
  const downweightedMuscles = new Set(
    cfg.muscles.filter((m) => {
      const s = muscleFatigue[m]?.displayStatus;
      return s === 'orange' || s === 'yellow';
    })
  );
  const skippedMuscles = cfg.muscles.filter((m) => !eligibleMuscles.has(m));

  // Score all catalog exercises
  const candidates = [];
  for (const [id, ex] of Object.entries(EXERCISE_CATALOG)) {
    if (disabledSet.has(id)) continue;
    if (equip[ex.equipment] === false) continue;

    // Must target at least one eligible muscle from this grouping
    const targetedEligible = Object.entries(ex.primaryMuscles).filter(
      ([mg, w]) => w >= 0.2 && eligibleMuscles.has(mg)
    );
    if (targetedEligible.length === 0) continue;

    const primaryMuscle = Object.entries(ex.primaryMuscles).sort(([, a], [, b]) => b - a)[0]?.[0];

    let score = 0;

    // Freshness bonus per targeted muscle
    for (const [mg] of targetedEligible) {
      const status = muscleFatigue[mg]?.displayStatus || 'green';
      if (status === 'green' || status === 'lime') score += 8;
      else if (status === 'yellow') score += 4;
    }

    // Downweighted penalty when primary muscle is orange/yellow
    if (primaryMuscle && downweightedMuscles.has(primaryMuscle)) score -= 5;

    // Recency bonus (mirrors scoreAccessories logic)
    const history = getExerciseHistory(id, store.accessoryLog);
    const recent = history[0];
    if (recent) {
      const daysSince = Math.floor((now - recent.timestamp) / MS_PER_DAY);
      score += Math.min(20, daysSince * 2);
    } else {
      score += 20;
    }

    // Movement-class bias. The freshness bonus above stacks per targeted
    // muscle, which lets a wide-but-shallow isolation machine outscore a
    // genuine compound. Session slots are scarce, so favour compounds and
    // discount isolation everywhere — not just on full-body days.
    if (ex.progressionType === 'compound') score += grouping === 'full' ? 8 : 5;
    else if (ex.progressionType === 'isolation') score -= 5;

    candidates.push({ id, ex, score, primaryMuscle });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Pick top N with muscle diversity (max 2 per primary muscle)
  const count = cfg.count;
  const picked = [];
  const muscleCounts = {};
  for (const { id, ex, primaryMuscle } of candidates) {
    if (picked.length >= count) break;
    const pm = primaryMuscle || 'unknown';
    if ((muscleCounts[pm] || 0) >= 2) continue;
    picked.push({ id, ex });
    muscleCounts[pm] = (muscleCounts[pm] || 0) + 1;
  }

  // Build accessory row objects
  const liftContext = GROUPING_LIFT_CONTEXT[grouping] || 'squat';
  const exercises = picked.map(({ id, ex }) => {
    const defaults = TRAVEL_SET_DEFAULTS[ex.progressionType] || TRAVEL_SET_DEFAULTS_FALLBACK;
    const weight = getAccessoryWeight(id, liftContext);
    const setWeights = computeSetWeights(weight, defaults.sets);
    const isDownweighted =
      ex.primaryMuscles &&
      Object.entries(ex.primaryMuscles).some(([mg, w]) => w >= 0.25 && downweightedMuscles.has(mg));
    return {
      exerciseId: id,
      name: ex.name,
      setWeights,
      targetSets: defaults.sets,
      repRange: defaults.repRange,
      equipment: ex.equipment,
      setsCompleted: [],
      progressed: false,
      _downweighted: isDownweighted,
    };
  });

  return { exercises, skippedMuscles };
}
