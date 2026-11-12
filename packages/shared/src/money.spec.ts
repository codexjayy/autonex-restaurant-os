import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateGstPaise, formatInrFromPaise, rupeesToPaise } from './money';

describe('money helpers (integer paise)', () => {
  it('calculates 5% GST split equally into CGST and SGST', () => {
    const gst = calculateGstPaise(20000, 500);
    assert.deepEqual(gst, { cgstPaise: 500, sgstPaise: 500, totalTaxPaise: 1000 });
  });

  it('rounds half-up deterministically without floating-point drift', () => {
    const gst = calculateGstPaise(1999, 500);
    assert.deepEqual(gst, { cgstPaise: 50, sgstPaise: 50, totalTaxPaise: 100 });
  });

  it('formats paise into INR string cleanly', () => {
    assert.equal(formatInrFromPaise(24950), '₹249.50');
    assert.equal(formatInrFromPaise(500), '₹5.00');
  });

  it('converts INR rupees strings/numbers to integer paise cleanly', () => {
    assert.equal(rupeesToPaise('249.50'), 24950);
    assert.equal(rupeesToPaise('19.99'), 1999);
    assert.equal(rupeesToPaise(260), 26000);
    assert.throws(() => rupeesToPaise('12.345'));
  });
});
