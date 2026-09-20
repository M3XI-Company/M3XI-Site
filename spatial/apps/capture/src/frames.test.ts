/**
 * Frame pacing, and the rule that the resolution never moves.
 *
 * The pacer takes its time as an argument for exactly this: the behaviour
 * being pinned is about milliseconds, and a test that waited for real ones
 * would be slow and flaky in proportion to how carefully it was written.
 */

import { describe, expect, it } from 'vitest';
import { FramePacer, MAX_IN_FLIGHT, captureResolution } from './frames.js';

describe('captureResolution', () => {
  it('returns the source resolution when the device is comfortable', () => {
    expect(captureResolution({ width: 1920, height: 1080 }, { degraded: false, medianCostMs: 20 }))
      .toEqual({ width: 1920, height: 1080 });
  });

  it('STILL returns the source resolution when the device is struggling', () => {
    // This is the rule, not a coincidence. Scoring a smaller frame silently
    // changes what BLUR_ABS_FLOOR means, so when a phone cannot keep up the
    // RATE comes down and the resolution does not.
    expect(captureResolution({ width: 3840, height: 2160 }, { degraded: true, medianCostMs: 400 }))
      .toEqual({ width: 3840, height: 2160 });
  });
});

describe('FramePacer', () => {
  it('analyses the first frame it is offered', () => {
    const p = new FramePacer();
    expect(p.decide(0, 100).kind).toBe('analyse');
  });

  it('refuses to queue a second frame while the worker holds one', () => {
    const p = new FramePacer();
    p.markDispatched(0);
    expect(p.inFlight).toBe(MAX_IN_FLIGHT);
    const d = p.decide(1000, 100);
    expect(d).toEqual({ kind: 'skip', because: 'worker_busy' });
    expect(p.droppedForBusy).toBe(1);
    p.completed();
    expect(p.decide(1000, 100).kind).toBe('analyse');
  });

  it('holds the interval the session asked for', () => {
    const p = new FramePacer();
    p.markDispatched(0);
    p.completed();
    expect(p.decide(50, 100)).toEqual({ kind: 'skip', because: 'too_soon' });
    expect(p.decide(100, 100).kind).toBe('analyse');
  });

  it('has no lead tolerance until it has measured the camera', () => {
    const p = new FramePacer();
    expect(p.callbackPeriodMs).toBeNull();
    expect(p.leadMs).toBe(0);
    p.observeCallback(0);
    expect(p.leadMs).toBe(0);
  });

  it('measures the callback period from the callbacks themselves', () => {
    const p = new FramePacer();
    for (let t = 0; t <= 330; t += 33) p.observeCallback(t);
    expect(p.callbackPeriodMs).toBeCloseTo(33, 5);
    expect(p.leadMs).toBeCloseTo(16.5, 5);
  });

  it('takes a frame that lands just BEFORE the deadline, so the rate is not one-sided', () => {
    // 30 fps callbacks against a 100 ms target. Without a lead tolerance the
    // first callback at or after 100 ms is the one at 132, and every interval
    // is a third long -- for the whole capture, always in the same direction.
    const p = new FramePacer();
    for (let t = 0; t <= 99; t += 33) p.observeCallback(t);
    p.markDispatched(0);
    p.completed();
    expect(p.decide(66, 100)).toEqual({ kind: 'skip', because: 'too_soon' });
    expect(p.decide(99, 100).kind).toBe('analyse');
  });

  it('never lets the tolerance admit two frames inside one interval', () => {
    const p = new FramePacer();
    for (let t = 0; t <= 330; t += 33) p.observeCallback(t);
    p.markDispatched(1000);
    p.completed();
    // leadMs is 16.5, so the earliest acceptable moment is 83.5 ms after the
    // last dispatch -- comfortably more than half the interval, which is what
    // stops a pair landing inside one period.
    expect(p.decide(1083, 100)).toEqual({ kind: 'skip', because: 'too_soon' });
    expect(p.decide(1084, 100).kind).toBe('analyse');
  });

  it('ignores a backgrounded tab when measuring the camera', () => {
    const p = new FramePacer();
    p.observeCallback(0);
    p.observeCallback(33);
    const before = p.callbackPeriodMs;
    p.observeCallback(45_000);     // the phone was in a pocket
    expect(p.callbackPeriodMs).toBe(before);
  });

  it('follows the interval down when the session slows the analyser', () => {
    const p = new FramePacer();
    p.markDispatched(0);
    p.completed();
    // ANALYSIS_HZ 10 -> 100 ms. Degraded to 7.5 Hz -> 133 ms. The pacer holds
    // whatever it is handed; it has no rate of its own to disagree with.
    expect(p.decide(120, 133.33)).toEqual({ kind: 'skip', because: 'too_soon' });
    expect(p.decide(134, 133.33).kind).toBe('analyse');
  });

  it('gives the timer fallback a delay rather than a deadline', () => {
    const p = new FramePacer();
    expect(p.nextDelayMs(0, 100)).toBe(0);
    p.markDispatched(1000);
    expect(p.nextDelayMs(1000, 100)).toBe(100);
    expect(p.nextDelayMs(1060, 100)).toBe(40);
    // Already late: zero, not a negative that setTimeout would silently clamp.
    expect(p.nextDelayMs(1500, 100)).toBe(0);
  });

  it('reports utilisation as analysed over offered', () => {
    const p = new FramePacer();
    expect(p.utilisation()).toBe(1);
    p.markDispatched(0);
    p.completed();
    p.decide(10, 100);   // too soon
    p.decide(20, 100);   // too soon
    p.decide(100, 100);  // would analyse
    p.markDispatched(100);
    expect(p.dispatchedFrames).toBe(2);
    expect(p.droppedForPace).toBe(2);
    expect(p.utilisation()).toBeCloseTo(0.5, 5);
  });

  it('does not go negative when completed is called more than dispatched', () => {
    const p = new FramePacer();
    p.completed();
    expect(p.inFlight).toBe(0);
  });
});
