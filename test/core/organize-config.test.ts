import { describe, expect, it } from 'vitest';
import {
  ORGANIZE_HEURISTICS_VERSION,
  ORGANIZE_THRESHOLDS,
} from '../../src/core/organize-config.js';

describe('ORGANIZE_THRESHOLDS (設計書 §8-K の確定初期値)', () => {
  it('holds exactly the values fixed in the design doc', () => {
    expect(ORGANIZE_THRESHOLDS).toEqual({
      subdivideMinFiles: 10,
      mergeCandidateBigramJaccard: 0.6,
      duplicateTitleExact: true,
      duplicateBodyHashExact: true,
      uncategorizedAssignMinJaccard: 0.25,
      staleDays: 540,
      clusterTagMinShare: 0.5,
    });
  });

  it('has no extra keys beyond the 7 documented thresholds', () => {
    expect(Object.keys(ORGANIZE_THRESHOLDS).sort()).toEqual(
      [
        'clusterTagMinShare',
        'duplicateBodyHashExact',
        'duplicateTitleExact',
        'mergeCandidateBigramJaccard',
        'staleDays',
        'subdivideMinFiles',
        'uncategorizedAssignMinJaccard',
      ].sort(),
    );
  });

  it('subdivideMinFiles is a positive integer (cluster file-count unit)', () => {
    expect(Number.isInteger(ORGANIZE_THRESHOLDS.subdivideMinFiles)).toBe(true);
    expect(ORGANIZE_THRESHOLDS.subdivideMinFiles).toBeGreaterThan(0);
    expect(ORGANIZE_THRESHOLDS.subdivideMinFiles).toBe(10);
  });

  it('staleDays is a positive integer number of days', () => {
    expect(Number.isInteger(ORGANIZE_THRESHOLDS.staleDays)).toBe(true);
    expect(ORGANIZE_THRESHOLDS.staleDays).toBeGreaterThan(0);
    expect(ORGANIZE_THRESHOLDS.staleDays).toBe(540);
  });

  it('the Jaccard cutoffs are numbers within [0, 1]', () => {
    for (const key of [
      'mergeCandidateBigramJaccard',
      'uncategorizedAssignMinJaccard',
      'clusterTagMinShare',
    ] as const) {
      const v = ORGANIZE_THRESHOLDS[key];
      expect(typeof v).toBe('number');
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('merge candidate cutoff (0.60) is stricter than the uncategorized assign cutoff (0.25)', () => {
    expect(ORGANIZE_THRESHOLDS.mergeCandidateBigramJaccard).toBeGreaterThan(
      ORGANIZE_THRESHOLDS.uncategorizedAssignMinJaccard,
    );
  });

  it('the exact-match switches are booleans and enabled', () => {
    expect(ORGANIZE_THRESHOLDS.duplicateTitleExact).toBe(true);
    expect(ORGANIZE_THRESHOLDS.duplicateBodyHashExact).toBe(true);
  });
});

describe('ORGANIZE_HEURISTICS_VERSION (設計書 付録 C)', () => {
  it('is the number 1 at the initial release', () => {
    expect(typeof ORGANIZE_HEURISTICS_VERSION).toBe('number');
    expect(ORGANIZE_HEURISTICS_VERSION).toBe(1);
  });

  it('is a positive integer', () => {
    expect(Number.isInteger(ORGANIZE_HEURISTICS_VERSION)).toBe(true);
    expect(ORGANIZE_HEURISTICS_VERSION).toBeGreaterThan(0);
  });
});
