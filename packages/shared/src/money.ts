/**
 * Integer-only currency & GST helpers (100 paise = 1 INR).
 * Basis points (bps): 500 bps = 5.00%.
 */

export function calculateGstPaise(taxablePaise: number, gstRateBps: number): {
  cgstPaise: number;
  sgstPaise: number;
  totalTaxPaise: number;
} {
  if (!Number.isInteger(taxablePaise) || taxablePaise < 0) {
    throw new Error('taxablePaise must be a non-negative integer');
  }
  if (!Number.isInteger(gstRateBps) || gstRateBps < 0 || gstRateBps > 2800) {
    throw new Error('gstRateBps must be an integer between 0 and 2800');
  }

  const halfBps = Math.floor(gstRateBps / 2);
  const remainderBps = gstRateBps - halfBps * 2;

  const cgstPaise = Math.floor((taxablePaise * (halfBps + remainderBps) + 5000) / 10000);
  const sgstPaise = Math.floor((taxablePaise * halfBps + 5000) / 10000);

  return {
    cgstPaise,
    sgstPaise,
    totalTaxPaise: cgstPaise + sgstPaise,
  };
}

export function formatInrFromPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}₹${rupees}.${rem}`;
}

export function rupeesToPaise(rupeesInput: string | number): number {
  const normalized = String(rupeesInput).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error('Invalid INR amount format (max 2 decimal places)');
  }
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole = '0', frac = ''] = unsigned.split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -paise : paise;
}
