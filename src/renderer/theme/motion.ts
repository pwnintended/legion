/** Motion constants (architecture §11): critically damped springs, transform/opacity only. */
export const SPRING = { type: 'spring', stiffness: 800, damping: 2 * Math.sqrt(800), mass: 1 } as const;
/** The only bouncy spring: attention/notification pop-in. */
export const SPRING_ATTENTION = {
  type: 'spring',
  stiffness: 1000,
  damping: 0.6 * 2 * Math.sqrt(1000),
  mass: 1,
} as const;
export const DURATION_OPEN_MS = 150;
export const URGENCY_PULSE_MS = 1600;
