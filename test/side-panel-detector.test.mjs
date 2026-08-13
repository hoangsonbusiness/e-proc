import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../client/src/services/sidePanelDetector.ts', import.meta.url),
  'utf8'
);
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const detector = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);

const BASELINE = 1920;
const SHRUNK = 1450;

function poll(state, currentWidth, active = true) {
  return detector.observeSidePanel(state, {
    active,
    baselineWidth: BASELINE,
    currentWidth,
  });
}

test('does not report when viewport width remains at the immutable fullscreen baseline', () => {
  let state = detector.createSidePanelDetectorState();
  for (let i = 0; i < 20; i += 1) {
    const decision = poll(state, BASELINE);
    state = decision.state;
    assert.equal(decision.shouldReport, false);
  }
  assert.equal(state.reportsReserved, 0);
});

test('a one-poll transient shrink is reset and never reported', () => {
  let state = detector.createSidePanelDetectorState();

  let decision = poll(state, SHRUNK);
  state = decision.state;
  assert.equal(decision.shouldReport, false);
  assert.equal(state.consecutiveShrinkPolls, 1);

  decision = poll(state, BASELINE);
  state = decision.state;
  assert.equal(decision.shouldReport, false);
  assert.equal(state.consecutiveShrinkPolls, 0);
  assert.equal(state.reportsReserved, 0);
});

test('persistent side panel produces exactly two logical reports and then stops', () => {
  let state = detector.createSidePanelDetectorState();
  const reportNumbers = [];

  for (let i = 0; i < 20; i += 1) {
    const decision = poll(state, SHRUNK);
    state = decision.state;
    if (decision.shouldReport) {
      reportNumbers.push(decision.reportNumber);
      state = detector.completeSidePanelReport(state);
    }
  }

  assert.deepEqual(reportNumbers, [1, 2]);
  assert.equal(state.reportsReserved, detector.SIDE_PANEL_MAX_REPORTS);
});

test('an in-flight report prevents overlapping violation requests', () => {
  let state = detector.createSidePanelDetectorState();

  state = poll(state, SHRUNK).state;
  const firstReport = poll(state, SHRUNK);
  state = firstReport.state;
  assert.equal(firstReport.shouldReport, true);
  assert.equal(state.reportInFlight, true);

  for (let i = 0; i < 10; i += 1) {
    const decision = poll(state, SHRUNK);
    state = decision.state;
    assert.equal(decision.shouldReport, false);
  }
  assert.equal(state.reportsReserved, 1);
});

test('submit, lock, or fullscreen exit resets suspicion without creating a report', () => {
  let state = detector.createSidePanelDetectorState();
  state = poll(state, SHRUNK).state;
  assert.equal(state.consecutiveShrinkPolls, 1);

  const terminalDecision = poll(state, 0, false);
  assert.equal(terminalDecision.shouldReport, false);
  assert.equal(terminalDecision.state.consecutiveShrinkPolls, 0);
  assert.equal(terminalDecision.state.reportsReserved, 0);
});

test('baseline parser rejects missing, invalid, and non-positive widths', () => {
  for (const raw of [null, '', 'NaN', 'Infinity', '0', '-1']) {
    assert.equal(detector.parseFullscreenBaselineWidth(raw), null);
  }
  assert.equal(detector.parseFullscreenBaselineWidth('1920'), 1920);
  assert.equal(detector.parseFullscreenBaselineWidth('1536.5'), 1536.5);
});

test('fullscreen baseline persists across a page reload and is cleared at terminal state', () => {
  const values = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    sessionStorage: {
      setItem: (key, value) => values.set(key, value),
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    assert.equal(detector.storeFullscreenBaselineWidth(BASELINE), true);
    assert.equal(detector.readFullscreenBaselineWidth(), BASELINE);
    detector.clearFullscreenBaselineWidth();
    assert.equal(detector.readFullscreenBaselineWidth(), null);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
