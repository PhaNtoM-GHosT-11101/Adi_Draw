/* ------------------------------------------------------------------ *
 *  Input filters
 *
 *  The One Euro filter (Casiez, Roussel & Vogel, CHI 2012) is the state
 *  of the art for pointer input: it removes hand tremor when the pen is
 *  slow and gets out of the way when it moves fast, so the line looks
 *  clean *without* the lag a fixed moving average introduces.
 * ------------------------------------------------------------------ */

/** Minimum-jerk adaptive low-pass filter for pointer streams. */
export class OneEuroFilter {
  private xPrev = 0
  private dxPrev = 0
  private started = false

  constructor(
    private minCutoff = 1,
    private beta = 0.007,
    private dCutoff = 1,
  ) {}

  reset() {
    this.started = false
    this.xPrev = 0
    this.dxPrev = 0
  }

  get params() {
    return { minCutoff: this.minCutoff, beta: this.beta, dCutoff: this.dCutoff }
  }

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(x: number, dt: number) {
    if (!this.started || !Number.isFinite(x)) {
      this.started = true
      this.xPrev = x
      this.dxPrev = 0
      return x
    }
    const d = (x - this.xPrev) / dt
    const aD = OneEuroFilter.alpha(this.dCutoff, dt)
    this.dxPrev = aD * d + (1 - aD) * this.dxPrev
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev)
    const a = OneEuroFilter.alpha(Math.max(0.02, cutoff), dt)
    const out = a * x + (1 - a) * this.xPrev
    this.xPrev = out
    return out
  }
}

/** Map the 0..1 tool sliders onto One Euro parameters. */
export function euroParams(smoothing: number, response: number) {
  // smoothing 0 = no filtering, 1 = very heavy
  const s = smoothing < 0 ? 0 : smoothing > 1 ? 1 : smoothing
  const r = response < 0 ? 0 : response > 1 ? 1 : response
  // 14 Hz is effectively "off" for a stylus at 120 Hz sampling
  const minCutoff = 14 - 13.2 * s * s - 0.4 * s
  const beta = 0.02 * r
  return { minCutoff, beta, dCutoff: 1 }
}

/**
 * Stylus tilt, normalised to 0..1 (0 = upright, 1 = flat on the glass).
 * Browsers report degrees in -90..90 on both axes.
 */
export function tiltAmount(tiltX: number, tiltY: number) {
  const tx = (tiltX || 0) / 90
  const ty = (tiltY || 0) / 90
  const mag = Math.min(1, Math.hypot(tx, ty))
  // signed direction matters for edge-only shading, so keep it normalised
  return mag >= 0 ? mag : 0
}

/** Signed tilt direction in radians (0 = pointing up the screen). */
export function tiltDirection(tiltX: number, tiltY: number) {
  return Math.atan2(tiltY || 0, tiltX || 0)
}

/** Barrel pressure fallback: some digitisers only report `twist`. */
export function twistAmount(twist: number) {
  if (!twist) return 0
  return Math.min(1, Math.abs(twist) / 180)
}

/**
 * Barrel-pen rotation profile: thicker along the nib axis, thinner across it.
 * `nib` is the angle of the broad edge in radians; returns a 0..1 width hint.
 */
export function chiselProfile(direction: number, nibAngle: number) {
  const d = Math.cos(direction - nibAngle)
  return 0.5 + 0.5 * d
}
