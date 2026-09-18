import { deriveWarrantyCode } from '../../scripts/rewrite-order-codes';

describe('deriveWarrantyCode', () => {
  it('returns undefined for a regular (non-warranty) order code', () => {
    const oldToNew = new Map<string, string>();
    expect(deriveWarrantyCode('ORD001', oldToNew)).toBeUndefined();
  });

  it('maps -BH to the new source code with the -BH suffix preserved', () => {
    const oldToNew = new Map([['ORD001', '20260501-00001']]);
    expect(deriveWarrantyCode('ORD001-BH', oldToNew)).toEqual({
      newCode: '20260501-00001-BH',
    });
  });

  it('maps -BH2 to the new source code with the -BH2 suffix preserved', () => {
    const oldToNew = new Map([['ORD001', '20260501-00001']]);
    expect(deriveWarrantyCode('ORD001-BH2', oldToNew)).toEqual({
      newCode: '20260501-00001-BH2',
    });
  });

  it('maps -BH3 to the new source code with the -BH3 suffix preserved', () => {
    const oldToNew = new Map([['ORD001', '20260501-00001']]);
    expect(deriveWarrantyCode('ORD001-BH3', oldToNew)).toEqual({
      newCode: '20260501-00001-BH3',
    });
  });

  it('returns a skipReason (no newCode) when the source was not rewritten in this run', () => {
    const oldToNew = new Map<string, string>(); // source not present — pre-dates --from-date
    const result = deriveWarrantyCode('ORD001-BH', oldToNew);
    expect(result).toBeDefined();
    expect(result!.newCode).toBeUndefined();
    expect(result!.skipReason).toMatch(/ORD001/);
    expect(result!.skipReason).toMatch(/pre-dates --from-date/);
  });

  it('skipReason references the correct stripped source code for a -BH2 order', () => {
    const oldToNew = new Map<string, string>();
    const result = deriveWarrantyCode('ORD002-BH2', oldToNew);
    expect(result!.skipReason).toMatch(/^source order ORD002 /);
  });
});
