export const FULLSCREEN_BASELINE_STORAGE_KEY = 'examFullscreenBaselineWidth';
export const SIDE_PANEL_SHRINK_THRESHOLD_PX = 80;
export const SIDE_PANEL_SUSTAIN_POLLS = 2;
export const SIDE_PANEL_MAX_REPORTS = 2;

export interface SidePanelDetectorState {
  consecutiveShrinkPolls: number;
  reportsReserved: number;
  reportInFlight: boolean;
}

export interface SidePanelObservation {
  active: boolean;
  baselineWidth: number | null;
  currentWidth: number;
}

export interface SidePanelDecision {
  state: SidePanelDetectorState;
  shouldReport: boolean;
  widthShrink: number;
  reportNumber: number | null;
}

export function createSidePanelDetectorState(): SidePanelDetectorState {
  return {
    consecutiveShrinkPolls: 0,
    reportsReserved: 0,
    reportInFlight: false,
  };
}

function isUsableWidth(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Pure state transition for one viewport poll. Polling never performs network
 * I/O itself: it only reserves one of at most two logical violation reports.
 */
export function observeSidePanel(
  state: SidePanelDetectorState,
  observation: SidePanelObservation
): SidePanelDecision {
  const { active, baselineWidth, currentWidth } = observation;
  const widthsAreUsable = isUsableWidth(baselineWidth) && isUsableWidth(currentWidth);
  const widthShrink = widthsAreUsable ? Math.max(0, baselineWidth - currentWidth) : 0;

  if (!active || !widthsAreUsable || state.reportsReserved >= SIDE_PANEL_MAX_REPORTS) {
    return {
      state: { ...state, consecutiveShrinkPolls: 0 },
      shouldReport: false,
      widthShrink,
      reportNumber: null,
    };
  }

  if (widthShrink <= SIDE_PANEL_SHRINK_THRESHOLD_PX || state.reportInFlight) {
    return {
      state: { ...state, consecutiveShrinkPolls: 0 },
      shouldReport: false,
      widthShrink,
      reportNumber: null,
    };
  }

  const consecutiveShrinkPolls = state.consecutiveShrinkPolls + 1;
  if (consecutiveShrinkPolls < SIDE_PANEL_SUSTAIN_POLLS) {
    return {
      state: { ...state, consecutiveShrinkPolls },
      shouldReport: false,
      widthShrink,
      reportNumber: null,
    };
  }

  const reportNumber = state.reportsReserved + 1;
  return {
    state: {
      consecutiveShrinkPolls: 0,
      reportsReserved: reportNumber,
      reportInFlight: true,
    },
    shouldReport: true,
    widthShrink,
    reportNumber,
  };
}

export function completeSidePanelReport(state: SidePanelDetectorState): SidePanelDetectorState {
  return { ...state, consecutiveShrinkPolls: 0, reportInFlight: false };
}

export function parseFullscreenBaselineWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const width = Number(raw);
  return isUsableWidth(width) ? width : null;
}

export function storeFullscreenBaselineWidth(width: number): boolean {
  if (!isUsableWidth(width)) return false;
  try {
    window.sessionStorage.setItem(FULLSCREEN_BASELINE_STORAGE_KEY, String(width));
    return true;
  } catch {
    return false;
  }
}

export function readFullscreenBaselineWidth(): number | null {
  try {
    return parseFullscreenBaselineWidth(
      window.sessionStorage.getItem(FULLSCREEN_BASELINE_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

export function clearFullscreenBaselineWidth(): void {
  try {
    window.sessionStorage.removeItem(FULLSCREEN_BASELINE_STORAGE_KEY);
  } catch {
    // Storage cleanup must never block submission or navigation.
  }
}
