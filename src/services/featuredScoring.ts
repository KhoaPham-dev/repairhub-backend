// Pure scoring/sorting/variety-guard logic for GET /api/agent/featured.
// Deliberately has NO DB access and NO Express types, so every rule (each
// scoring signal, the sort order, the variety guard + backfill) is directly
// unit-testable without spinning up a request or mocking the pool.

export type MediaStage = 'INTAKE' | 'COMPLETION';
export type MediaKind = 'photo' | 'video';

export interface FeaturedMediaSignal {
  stage: MediaStage;
  kind: MediaKind;
}

export interface FeaturedScoreInput {
  orderCode: string;
  status: string;
  /** fault_description AFTER masking (see agentPrivacy.ts) — never the raw value. */
  maskedFaultDescription: string;
  media: FeaturedMediaSignal[];
}

export interface FeaturedScoreResult {
  score: number;
  reasons: string[];
}

// Single source of truth for every scoring weight (FR-17.16). Exported so
// it can be asserted directly in tests and referenced from documentation/
// tooling without duplicating the magic numbers.
export const FEATURED_WEIGHTS = {
  completionMedia: 3,
  bothStages: 2,
  goodStatus: 2,
  hasVideo: 1,
  detailedFault: 1,
  warrantyOrder: -1,
} as const;

const GOOD_STATUSES = new Set(['SUA_XONG', 'DA_GIAO']);
const WARRANTY_ORDER_CODE_RE = /-BH\d*$/;
const DETAILED_FAULT_MIN_LENGTH = 30;

/**
 * Scores a single candidate order per FR-17.16 and returns the matching
 * Vietnamese reasons (FR-17.17) in the same fixed order as the rules below,
 * regardless of which rules actually matched — this is also the order the
 * contract's example response shows.
 */
export function scoreOrder(input: FeaturedScoreInput): FeaturedScoreResult {
  let score = 0;
  const reasons: string[] = [];

  const hasCompletion = input.media.some((m) => m.stage === 'COMPLETION');
  if (hasCompletion) {
    score += FEATURED_WEIGHTS.completionMedia;
    reasons.push('Có ảnh/video sau sửa');
  }

  const hasIntake = input.media.some((m) => m.stage === 'INTAKE');
  if (hasIntake && hasCompletion) {
    score += FEATURED_WEIGHTS.bothStages;
    reasons.push('Có ảnh trước & sau');
  }

  if (GOOD_STATUSES.has(input.status)) {
    score += FEATURED_WEIGHTS.goodStatus;
    reasons.push('Đã sửa xong');
  }

  const hasVideo = input.media.some((m) => m.kind === 'video');
  if (hasVideo) {
    score += FEATURED_WEIGHTS.hasVideo;
    reasons.push('Có video');
  }

  if (input.maskedFaultDescription.length >= DETAILED_FAULT_MIN_LENGTH) {
    score += FEATURED_WEIGHTS.detailedFault;
    reasons.push('Mô tả lỗi chi tiết');
  }

  if (WARRANTY_ORDER_CODE_RE.test(input.orderCode)) {
    score += FEATURED_WEIGHTS.warrantyOrder;
    reasons.push('Đơn bảo hành');
  }

  return { score, reasons };
}

export interface SortableFeaturedCandidate {
  score: number;
  mediaCount: number;
  /** Most recent in-window activity timestamp, as an ISO string or Date. */
  latestActivity: string | Date;
  orderCode: string;
}

/**
 * FR-17.18 sort: score desc, then media_count desc, then latest activity
 * desc, then order_code asc (stable tie-break so pagination-free output is
 * deterministic).
 */
export function compareFeaturedCandidates(
  a: SortableFeaturedCandidate,
  b: SortableFeaturedCandidate
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.mediaCount !== a.mediaCount) return b.mediaCount - a.mediaCount;
  const aTime = new Date(a.latestActivity).getTime();
  const bTime = new Date(b.latestActivity).getTime();
  if (bTime !== aTime) return bTime - aTime;
  if (a.orderCode < b.orderCode) return -1;
  if (a.orderCode > b.orderCode) return 1;
  return 0;
}

const MAX_PER_PRODUCT_TYPE = 3;

/**
 * FR-17.19 variety guard: at most MAX_PER_PRODUCT_TYPE per product_type,
 * applied over the already-sorted candidate list; if the capped list is
 * shorter than `limit`, backfill from the excluded overflow (still in the
 * original sort order) until `limit` is reached or candidates run out.
 * Callers must pass an already-sorted array (see compareFeaturedCandidates)
 * and a `limit` already clamped to [1, 20] — this function only enforces
 * the per-type cap and the final length, it does not re-sort or re-clamp.
 */
export function applyVarietyGuard<T extends { productType: string }>(
  sortedCandidates: T[],
  limit: number
): T[] {
  const perTypeCount = new Map<string, number>();
  const selected: T[] = [];
  const overflow: T[] = [];

  for (const candidate of sortedCandidates) {
    const count = perTypeCount.get(candidate.productType) ?? 0;
    if (count < MAX_PER_PRODUCT_TYPE) {
      selected.push(candidate);
      perTypeCount.set(candidate.productType, count + 1);
    } else {
      overflow.push(candidate);
    }
  }

  if (selected.length < limit) {
    for (const candidate of overflow) {
      if (selected.length >= limit) break;
      selected.push(candidate);
    }
  }

  return selected.slice(0, limit);
}

const DEFAULT_FEATURED_LIMIT = 12;
const MAX_FEATURED_LIMIT = 20;

/** FR-17.20: default 12, clamp (never reject) to a max of 20, minimum 1. */
export function clampFeaturedLimit(rawLimit: unknown): number {
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return DEFAULT_FEATURED_LIMIT;
  const truncated = Math.trunc(parsed);
  if (truncated < 1) return DEFAULT_FEATURED_LIMIT;
  return Math.min(truncated, MAX_FEATURED_LIMIT);
}
