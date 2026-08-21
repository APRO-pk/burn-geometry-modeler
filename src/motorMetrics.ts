/**
 * Summary numbers produced by one simulation run.
 *
 * Extracted into its own type because `metrics` was `useState<any>` in
 * AppDesktop and is read by every tab. `any` meant the compiler could not tell
 * anyone when a field stopped being produced -- a real removal of
 * `calculate_discontinuity_stress` from the Rust core left the UI rendering
 * `undefined` while `tsc --noEmit` stayed green, and it was only caught by
 * grepping. Typing it moves that class of bug back to compile time.
 *
 * All values are SI: pascals, newtons, seconds, kilograms, metres.
 */
export interface MotorMetrics {
  maxThrust: number;
  avgThrust: number;
  /** Peak chamber pressure, Pa. */
  maxPc: number;
  avgPc: number;
  /** Total impulse, N*s. */
  totalImpulse: number;
  /** Delivered specific impulse, s. */
  isp: number;
  /** Time from ignition to burnout, s. */
  actionTime: number;
  /** Wall thickness the pressure trace requires, m. */
  requiredThickness: number;
  /** Propellant mass consumed, kg. */
  propMass: number;
  /** Klemmung (burning area / throat area) at ignition and at its peak. */
  initialKn: number;
  peakKn: number;
  /** Peak port mass flux, kg/m^2/s. */
  peakMassFlux: number;
  /** Port area over throat area; below ~2 invites erosive burning. */
  portThroatRatio: number;
  /** Fraction of chamber volume filled with propellant. */
  volumeLoading: number;
}
