/**
 * Accessory rep-scheme rotation constants.
 *
 * Each rotation-eligible exercise auto-cycles through three tiers:
 * heavy → moderate → light → heavy. The tier is determined by the
 * exercise's last session in accessoryLog. Weight is auto-calculated
 * from last performance via Epley e1RM estimation.
 *
 * Excluded exercises always use their catalog default rep range (typically
 * isolation or time-based movements where heavy loading is unsafe or
 * pointless).
 */

export const REP_TIERS = {
  heavy: { repRange: [4, 6], sets: 4, label: 'Heavy' },
  moderate: { repRange: [8, 12], sets: 3, label: 'Moderate' },
  light: { repRange: [12, 20], sets: 3, label: 'Light' },
};

export const ROTATION_EXCLUDED = new Set([
  'lateral-raises', // shoulder safety at heavy loads
  'ab-wheel', // core — rep-based
  'pallof-press', // core stability, not strength
  'plank', // time-based
  'wall-sit', // time-based
  'rear-delt-flies', // isolation, light only
  'dead-hang', // time-based

  // Time-based holds and carries — duration is the progression, not load
  'side-plank',
  'hollow-hold',
  'suitcase-carry',
  'overhead-carry',
  'sled-push',
  'sled-drag',
  'plate-pinch',

  // Small-joint / shoulder-health isolation — heavy tiers are unsafe or useless
  'cable-lateral-raise',
  'front-raise',
  'reverse-pec-deck',
  'band-pull-apart',
  'upright-row',
  'tricep-kickback',
  'wrist-curl',
  'reverse-wrist-curl',
  'wrist-roller',
  'sissy-squat',

  // Direct core and glute isolation — rep-based by nature
  'crunch',
  'sit-up',
  'v-up',
  'russian-twist',
  'machine-crunch',
  'cable-crunch',
  'dead-bug',
  'bird-dog',
  'hanging-leg-raise',
  'hanging-knee-raise',
  'toes-to-bar',
  'cable-kickback',
  'hip-abduction',
  'hip-adduction',
  'bodyweight-squat',
]);
