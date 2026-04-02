import {
  BASE_SLEEP_NEED_MINUTES,
  applyNapCreditToSleepDebt,
  calculateOptimalBedtimeMinutes,
  calculateSleepDebtMinutes,
  calculateSleepNeedMinutes,
  roundClockMinutes,
} from '@/utils/sleepPlan';

describe('sleepPlan helpers', () => {
  it('keeps baseline need at eight hours without recent shortfalls', () => {
    expect(calculateSleepDebtMinutes([480, 480, 480])).toBe(0);
    expect(calculateSleepNeedMinutes([480, 480, 480])).toBe(BASE_SLEEP_NEED_MINUTES);
  });

  it('weights recent short sleep more heavily', () => {
    expect(calculateSleepDebtMinutes([450, 390, 360])).toBe(102);
  });

  it('caps sleep debt and allows nap credit to reduce it', () => {
    expect(calculateSleepDebtMinutes([120, 120, 120])).toBe(150);
    expect(applyNapCreditToSleepDebt(120, 45)).toBe(75);
    expect(applyNapCreditToSleepDebt(45, 90)).toBe(0);
  });

  it('calculates an overnight bedtime from a target wake time', () => {
    expect(calculateOptimalBedtimeMinutes(7 * 60 + 30, 9 * 60)).toBe(22 * 60 + 30);
  });

  it('rounds wake targets to the nearest quarter hour', () => {
    expect(roundClockMinutes(7 * 60 + 37)).toBe(7 * 60 + 30);
    expect(roundClockMinutes(-5)).toBe(0);
  });
});
