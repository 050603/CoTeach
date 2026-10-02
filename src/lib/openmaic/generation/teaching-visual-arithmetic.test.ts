import { describe, expect, it } from 'vitest';
import { groundedNumericValues, verifiedTeachingArithmetic } from './teaching-visual-arithmetic';

describe('original-source teaching calculations', () => {
  const original = ['原灯功率60 W，新灯10 W，20盏，每天5 h。',
    '每天节电量=(60−10)÷1000×20×5=5 kWh。', '每月按30天，节电150 kWh。'];
  it('verifies intermediate power, conversion and total steps from the adopted formula', () => {
    const texts = ['单盏功率差 = 60 − 10 = 50 W', '换算 = (60−10)÷1000=0.05 kW', '合计 = 0.05×20=1 kW', '每月节电量 = 5 × 30 = 150 kWh'];
    const verified = verifiedTeachingArithmetic(texts, original);
    expect(verified.invalidTexts.size).toBe(0);
    expect(verified.quantitiesByText.get(texts[0]!)).toContain('50');
    expect(verified.quantitiesByText.get(texts[1]!)).toContain('0.05');
    expect(verified.quantitiesByText.get(texts[2]!)).toContain('1');
    expect(verified.quantitiesByText.get(texts[3]!)).toContain('5');
  });
  it('rejects incorrect equalities, new operands and unrelated computed measurements', () => {
    const texts = ['60−10=51 W', '999×20=19980 W', '60+10=70 W', '20÷0=5 W'];
    const verified = verifiedTeachingArithmetic(texts, original);
    expect(verified.invalidTexts).toContain(texts[0]);
    expect(verified.quantitiesByText.get(texts[0]!)).toBeUndefined();
    expect(verified.quantitiesByText.get(texts[1]!)).toBeUndefined();
    expect(verified.quantitiesByText.get(texts[2]!)).toBeUndefined();
    expect(verified.quantitiesByText.get(texts[3]!)).toBeUndefined();
  });
  it('verifies averaging with an original count and result without inventing evidence', () => {
    const text = '(12+10+14)÷3=12 kWh';
    const verified = verifiedTeachingArithmetic([text], ['三日用电量12、10、14 kWh；平均12 kWh。']);
    expect(verified.quantitiesByText.get(text)).toContain('3');
    expect(groundedNumericValues('a zero divisor')).toContain('0');
  });
  it('never evaluates calls, property access or incomplete numeric expressions', () => {
    const texts = ['globalThis.secret()=3', '2**3=8', '(2+3=5', '2/0=5'];
    const verified = verifiedTeachingArithmetic(texts, ['2+3=5；8；0']);
    expect(verified.quantitiesByText.size).toBe(0);
    expect(verified.invalidTexts.has('(2+3=5')).toBe(true);
    expect(verified.invalidTexts.has('2/0=5')).toBe(true);
  });
});
