import {
  FEATURED_WEIGHTS,
  applyVarietyGuard,
  clampFeaturedLimit,
  compareFeaturedCandidates,
  scoreOrder,
} from '../../services/featuredScoring';

const NORMAL_STATUS = 'DANG_SUA_CHUA';
const SHORT_FAULT = 'Máy hỏng'; // < 30 chars
const LONG_FAULT = 'Loa không lên nguồn sau khi rơi xuống nước, cần thay mainboard'; // >= 30 chars

describe('FEATURED_WEIGHTS', () => {
  it('matches the contract weights exactly', () => {
    expect(FEATURED_WEIGHTS).toEqual({
      completionMedia: 3,
      bothStages: 2,
      goodStatus: 2,
      hasVideo: 1,
      detailedFault: 1,
      warrantyOrder: -1,
    });
  });
});

describe('scoreOrder', () => {
  it('scores 0 with no reasons for a bare candidate with no signals', () => {
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'INTAKE', kind: 'photo' }],
    });
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('adds +3 and "Có ảnh/video sau sửa" for a COMPLETION-stage media item', () => {
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'COMPLETION', kind: 'photo' }],
    });
    expect(result.score).toBe(FEATURED_WEIGHTS.completionMedia);
    expect(result.reasons).toEqual(['Có ảnh/video sau sửa']);
  });

  it('adds +2 and "Có ảnh trước & sau" only when BOTH intake and completion media are present', () => {
    const bothStages = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'INTAKE', kind: 'photo' }, { stage: 'COMPLETION', kind: 'photo' }],
    });
    expect(bothStages.score).toBe(FEATURED_WEIGHTS.completionMedia + FEATURED_WEIGHTS.bothStages);
    expect(bothStages.reasons).toEqual(['Có ảnh/video sau sửa', 'Có ảnh trước & sau']);

    const intakeOnly = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'INTAKE', kind: 'photo' }],
    });
    expect(intakeOnly.reasons).not.toContain('Có ảnh trước & sau');
  });

  it.each(['SUA_XONG', 'DA_GIAO'])('adds +2 and "Đã sửa xong" for status %s', (status) => {
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status,
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'INTAKE', kind: 'photo' }],
    });
    expect(result.score).toBe(FEATURED_WEIGHTS.goodStatus);
    expect(result.reasons).toEqual(['Đã sửa xong']);
  });

  it('does not add the status bonus for any other status', () => {
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status: 'DANG_KIEM_TRA',
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'INTAKE', kind: 'photo' }],
    });
    expect(result.reasons).not.toContain('Đã sửa xong');
  });

  it('adds +1 and "Có video" when any media item is a video', () => {
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'INTAKE', kind: 'video' }],
    });
    expect(result.score).toBe(FEATURED_WEIGHTS.hasVideo);
    expect(result.reasons).toEqual(['Có video']);
  });

  it('adds +1 and "Mô tả lỗi chi tiết" when the masked fault_description is >= 30 characters', () => {
    expect(LONG_FAULT.length).toBeGreaterThanOrEqual(30);
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: LONG_FAULT,
      media: [{ stage: 'INTAKE', kind: 'photo' }],
    });
    expect(result.score).toBe(FEATURED_WEIGHTS.detailedFault);
    expect(result.reasons).toEqual(['Mô tả lỗi chi tiết']);
  });

  it('does not add the detailed-fault bonus for a masked description under 30 characters', () => {
    expect(SHORT_FAULT.length).toBeLessThan(30);
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'INTAKE', kind: 'photo' }],
    });
    expect(result.reasons).not.toContain('Mô tả lỗi chi tiết');
  });

  it('treats exactly 30 characters as meeting the threshold (>=, not >)', () => {
    const exactly30 = 'a'.repeat(30);
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: exactly30,
      media: [{ stage: 'INTAKE', kind: 'photo' }],
    });
    expect(result.reasons).toContain('Mô tả lỗi chi tiết');
  });

  it.each(['20260918-00001-BH', '20260918-00001-BH2', '20260918-00001-BH37'])(
    'subtracts 1 and adds "Đơn bảo hành" for a warranty order code: %s',
    (orderCode) => {
      const result = scoreOrder({
        orderCode,
        status: NORMAL_STATUS,
        maskedFaultDescription: SHORT_FAULT,
        media: [{ stage: 'INTAKE', kind: 'photo' }],
      });
      expect(result.score).toBe(FEATURED_WEIGHTS.warrantyOrder);
      expect(result.reasons).toEqual(['Đơn bảo hành']);
    }
  );

  it('does not treat a non-warranty order code as a warranty order', () => {
    const result = scoreOrder({
      orderCode: '20260918-00001',
      status: NORMAL_STATUS,
      maskedFaultDescription: SHORT_FAULT,
      media: [{ stage: 'INTAKE', kind: 'photo' }],
    });
    expect(result.reasons).not.toContain('Đơn bảo hành');
  });

  it('reaches the maximum possible score with every positive signal present, minus the warranty penalty', () => {
    const result = scoreOrder({
      orderCode: '20260918-00001-BH',
      status: 'DA_GIAO',
      maskedFaultDescription: LONG_FAULT,
      media: [
        { stage: 'INTAKE', kind: 'photo' },
        { stage: 'COMPLETION', kind: 'video' },
      ],
    });
    const expectedMax =
      FEATURED_WEIGHTS.completionMedia +
      FEATURED_WEIGHTS.bothStages +
      FEATURED_WEIGHTS.goodStatus +
      FEATURED_WEIGHTS.hasVideo +
      FEATURED_WEIGHTS.detailedFault +
      FEATURED_WEIGHTS.warrantyOrder;
    expect(expectedMax).toBe(8); // 3+2+2+1+1-1
    expect(result.score).toBe(expectedMax);
    expect(result.reasons).toEqual([
      'Có ảnh/video sau sửa',
      'Có ảnh trước & sau',
      'Đã sửa xong',
      'Có video',
      'Mô tả lỗi chi tiết',
      'Đơn bảo hành',
    ]);
  });
});

describe('compareFeaturedCandidates', () => {
  const base = { score: 5, mediaCount: 2, latestActivity: '2026-09-18T05:00:00Z', orderCode: '20260918-00002' };

  it('sorts by score descending first', () => {
    const higher = { ...base, score: 10 };
    const lower = { ...base, score: 1 };
    expect(compareFeaturedCandidates(higher, lower)).toBeLessThan(0);
    expect(compareFeaturedCandidates(lower, higher)).toBeGreaterThan(0);
  });

  it('breaks a score tie by media_count descending', () => {
    const moreMedia = { ...base, mediaCount: 5 };
    const lessMedia = { ...base, mediaCount: 1 };
    expect(compareFeaturedCandidates(moreMedia, lessMedia)).toBeLessThan(0);
  });

  it('breaks a score+media_count tie by latest activity descending', () => {
    const recent = { ...base, latestActivity: '2026-09-18T10:00:00Z' };
    const older = { ...base, latestActivity: '2026-09-18T01:00:00Z' };
    expect(compareFeaturedCandidates(recent, older)).toBeLessThan(0);
  });

  it('breaks a full tie by order_code ascending', () => {
    const a = { ...base, orderCode: '20260918-00001' };
    const b = { ...base, orderCode: '20260918-00002' };
    expect(compareFeaturedCandidates(a, b)).toBeLessThan(0);
    expect(compareFeaturedCandidates(b, a)).toBeGreaterThan(0);
  });

  it('returns 0 for fully identical candidates', () => {
    expect(compareFeaturedCandidates(base, { ...base })).toBe(0);
  });
});

describe('applyVarietyGuard', () => {
  function order(id: string, productType: string) {
    return { id, productType };
  }

  it('passes through fewer than the cap per product_type unchanged', () => {
    const sorted = [order('a', 'SPEAKER'), order('b', 'HEADPHONE')];
    expect(applyVarietyGuard(sorted, 12)).toEqual(sorted);
  });

  it('caps at 3 per product_type when limit is already satisfied by the cap', () => {
    const sorted = [
      order('a', 'SPEAKER'), order('b', 'SPEAKER'), order('c', 'SPEAKER'), order('d', 'SPEAKER'),
    ];
    // limit == the capped count, so there's no room left to backfill the 4th SPEAKER
    const result = applyVarietyGuard(sorted, 3);
    expect(result.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('backfills a 4th same-type candidate when no other type is available to fill the limit', () => {
    const sorted = [
      order('a', 'SPEAKER'), order('b', 'SPEAKER'), order('c', 'SPEAKER'), order('d', 'SPEAKER'),
    ];
    // limit > the capped count and there's nothing else to backfill with —
    // the variety guard's cap only applies to the first pass, not backfill.
    const result = applyVarietyGuard(sorted, 4);
    expect(result.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('backfills from the overflow (still in sort order) when the capped list is short of limit', () => {
    // 4 SPEAKER (cap 3, 1 overflow) + 1 HEADPHONE — capped list is 4 (a,b,c,e), short of limit 5
    const sorted = [
      order('a', 'SPEAKER'), order('b', 'SPEAKER'), order('c', 'SPEAKER'), order('d', 'SPEAKER'),
      order('e', 'HEADPHONE'),
    ];
    const result = applyVarietyGuard(sorted, 5);
    // capped: a,b,c (speaker cap) + e (headphone) = 4, backfill from overflow [d] -> 5
    expect(result.map((o) => o.id)).toEqual(['a', 'b', 'c', 'e', 'd']);
  });

  it('does not backfill beyond limit even when overflow remains', () => {
    const sorted = [
      order('a', 'SPEAKER'), order('b', 'SPEAKER'), order('c', 'SPEAKER'), order('d', 'SPEAKER'), order('e', 'SPEAKER'),
    ];
    const result = applyVarietyGuard(sorted, 4);
    expect(result).toHaveLength(4);
    expect(result.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns fewer than limit when candidates are exhausted', () => {
    const sorted = [order('a', 'SPEAKER'), order('b', 'HEADPHONE')];
    const result = applyVarietyGuard(sorted, 12);
    expect(result).toHaveLength(2);
  });

  it('returns an empty array for an empty candidate list', () => {
    expect(applyVarietyGuard([], 12)).toEqual([]);
  });
});

describe('clampFeaturedLimit', () => {
  it('defaults to 12 when missing/undefined', () => {
    expect(clampFeaturedLimit(undefined)).toBe(12);
  });

  it('defaults to 12 for a non-numeric value', () => {
    expect(clampFeaturedLimit('abc')).toBe(12);
  });

  it('passes through an in-range value unchanged', () => {
    expect(clampFeaturedLimit('7')).toBe(7);
    expect(clampFeaturedLimit(7)).toBe(7);
  });

  it('clamps values above 20 down to 20 (never rejects)', () => {
    expect(clampFeaturedLimit('20')).toBe(20);
    expect(clampFeaturedLimit('21')).toBe(20);
    expect(clampFeaturedLimit('1000')).toBe(20);
  });

  it('falls back to the default for zero or negative values', () => {
    expect(clampFeaturedLimit('0')).toBe(12);
    expect(clampFeaturedLimit('-5')).toBe(12);
  });

  it('truncates a fractional value', () => {
    expect(clampFeaturedLimit('7.9')).toBe(7);
  });
});
