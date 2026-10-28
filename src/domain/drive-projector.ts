export interface DriveParameters { contactTauHours: number; responseRelief: number; cap: number }
export interface DriveState { atMs: number; contact: number; exploration: number; load: number; responses: number }
export const DRIVE_DEFAULTS: DriveParameters = { contactTauHours: 6, responseRelief: .35, cap: 1 }
const unit = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))

/** Pure projection; never save repeated read projections as new source events. */
export function projectDrives(state: DriveState, atMs: number, parameters: DriveParameters = DRIVE_DEFAULTS): DriveState {
  const dt = Math.max(0, atMs - state.atMs), cap = unit(parameters.cap)
  const tau = Math.max(.01, Number.isFinite(parameters.contactTauHours) ? parameters.contactTauHours : 6) * 3600000
  return { ...state, atMs: Math.max(state.atMs, atMs), contact: unit(cap - (cap - Math.min(cap, unit(state.contact))) * Math.exp(-dt / tau)), exploration: unit(state.exploration * Math.exp(-dt / (12 * 3600000))), load: unit(state.load * Math.exp(-dt / (2 * 3600000))) }
}

export function respondDrive(state: DriveState, atMs: number, parameters: DriveParameters = DRIVE_DEFAULTS): DriveState {
  const next = projectDrives(state, atMs, parameters)
  return { ...next, contact: next.contact * (1 - unit(parameters.responseRelief)), load: unit(next.load + .04), responses: next.responses + 1 }
}
