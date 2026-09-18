// rewrite-order-codes.ts (RH-67, RH-71)
// -----------------------------------------------------------------------------
// One-shot cutover script. Walks all orders with created_at >= --from-date
// in ascending creation order and rewrites their order_code to the new
// YYYYMMDD-NNNNN format (regular) or YYYYMMDD-NNNNN-BH (warranty), starting
// from --start-code. Counter resets to 0 at each calendar year boundary
// (UTC+7) encountered during the walk.
//
// Wraps the entire rewrite + counter update in a single transaction so a
// failure rolls everything back.
//
// Usage:
//   npm run order-code:rewrite:dev     -- --from-date 2026-05-01 --start-code 1
//   npm run order-code:rewrite:dev     -- --from-date 2026-05-01 --start-code 1 --dry-run
//   npm run order-code:rewrite:dev     -- --from-date 2026-05-01 --start-code 1 --force
//
// --force bypasses the safety check that refuses to run if any affected
// order already matches the new format. Without --force a re-run is a no-op.
//
// Warranty orders (current code ends in -BH) get their new code from the
// rewritten source: <new_source_code>-BH. If the warranty's source pre-dates
// --from-date (so it isn't being rewritten in this run), the warranty is
// SKIPPED with a warning and its old code is left in place.

import dotenv from 'dotenv';
dotenv.config();

import { Pool, PoolClient } from 'pg';

interface CliArgs {
  fromDate: string;
  startCode: number;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: Partial<CliArgs> = { dryRun: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from-date')   { out.fromDate = args[++i]; continue; }
    if (a === '--start-code')  { out.startCode = Number(args[++i]); continue; }
    if (a === '--dry-run')     { out.dryRun = true; continue; }
    if (a === '--force')       { out.force = true; continue; }
    throw new Error(`Unknown arg: ${a}`);
  }
  if (!out.fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(out.fromDate)) {
    throw new Error('--from-date YYYY-MM-DD is required');
  }
  if (out.startCode === undefined || isNaN(out.startCode) || out.startCode < 0 || out.startCode > 99999) {
    throw new Error('--start-code 0..99999 is required');
  }
  return out as CliArgs;
}

// YYYYMMDD in Asia/Ho_Chi_Minh (UTC+7) — matches the runtime generator.
function vnDateParts(d: Date): { year: number; ymd: string } {
  const iso = d.toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
  const [year, month, day] = iso.split(' ')[0].split('-');
  return { year: Number(year), ymd: `${year}${month}${day}` };
}

const NEW_FORMAT_RE = /^\d{8}-\d{5}(-BH\d*)?$/;
const WARRANTY_SUFFIX_RE = /-BH\d*$/;

interface OrderRow {
  id: string;
  order_code: string;
  created_at: Date;
}

export interface WarrantyCodeDerivation {
  newCode?: string;
  skipReason?: string;
}

// Pure helper: derive the new code for a warranty order's old code (one
// ending in -BH, -BH2, -BH3, ...), given the map of old->new codes already
// assigned to orders processed earlier in the walk (see `run` step 3).
// Preserves the original warranty suffix on the rewritten source code.
//
// Returns `undefined` if `oldCode` isn't a warranty code at all (caller
// should treat it as a regular order). Returns `{ skipReason }` (no
// `newCode`) if it IS a warranty code but its source hasn't been rewritten
// in this run yet — e.g. the source pre-dates --from-date.
export function deriveWarrantyCode(
  oldCode: string,
  oldToNew: ReadonlyMap<string, string>
): WarrantyCodeDerivation | undefined {
  const match = WARRANTY_SUFFIX_RE.exec(oldCode);
  if (!match) return undefined;

  const suffix = match[0];
  const oldSourceCode = oldCode.slice(0, -suffix.length);
  const newSourceCode = oldToNew.get(oldSourceCode);
  if (!newSourceCode) {
    return {
      skipReason: `source order ${oldSourceCode} pre-dates --from-date and was not rewritten`,
    };
  }
  return { newCode: `${newSourceCode}${suffix}` };
}

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set (e.g. inside the running backend container, or via --env-file).');
  }
  const args = parseArgs();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch every affected order in created_at order. Casting created_at
    //    to the VN timezone keeps year boundaries aligned with the operator.
    const fromTimestamp = `${args.fromDate}T00:00:00+07:00`;
    const all = await client.query<OrderRow>(
      `SELECT id, order_code, created_at
       FROM orders
       WHERE created_at >= $1
       ORDER BY created_at ASC, id ASC`,
      [fromTimestamp]
    );

    if (all.rows.length === 0) {
      console.log('[rewrite] No orders found with created_at >= ' + args.fromDate);
      await client.query('ROLLBACK');
      return;
    }

    // 2. Safety: refuse to run if any of those rows already use the new format.
    if (!args.force) {
      const offender = all.rows.find((r) => NEW_FORMAT_RE.test(r.order_code));
      if (offender) {
        throw new Error(
          `Order ${offender.id} (${offender.order_code}) already matches the new format — ` +
          `rewrite previously ran or these are post-cutover orders. Re-run with --force to override.`
        );
      }
    }

    // 3. Walk and assign codes. Track:
    //    - oldToNew: map from each order's old code to the new code (so warranty
    //      lookups can use it).
    //    - perYearMaxSeq: highest sequence assigned per year (for the counter
    //      table update at the end).
    const oldToNew = new Map<string, string>();
    const perYearMaxSeq = new Map<number, number>();

    let runningYear = vnDateParts(new Date(`${args.fromDate}T00:00:00+07:00`)).year;
    let runningSeq = args.startCode;

    interface Plan { id: string; oldCode: string; newCode: string }
    const plan: Plan[] = [];
    const skipped: Array<{ id: string; oldCode: string; reason: string }> = [];

    for (const row of all.rows) {
      const { year, ymd } = vnDateParts(row.created_at);

      // Year boundary: reset the running counter when we cross into a new year.
      if (year > runningYear) {
        runningYear = year;
        runningSeq = 0;
      }

      const warrantyDerivation = deriveWarrantyCode(row.order_code, oldToNew);
      let newCode: string;

      if (warrantyDerivation) {
        // Warranty (-BH, -BH2, -BH3, ...): derive from the rewritten source
        // order's new code, preserving the original warranty suffix.
        if (warrantyDerivation.skipReason) {
          // Source was created before --from-date and is not part of this run.
          skipped.push({
            id: row.id,
            oldCode: row.order_code,
            reason: warrantyDerivation.skipReason,
          });
          continue;
        }
        newCode = warrantyDerivation.newCode!;
        // Warranty doesn't advance the counter (matches runtime behaviour).
      } else {
        // Regular: use the running sequence, then increment.
        newCode = `${ymd}-${String(runningSeq).padStart(5, '0')}`;
        const prev = perYearMaxSeq.get(year) ?? -1;
        if (runningSeq > prev) perYearMaxSeq.set(year, runningSeq);
        runningSeq++;
      }

      oldToNew.set(row.order_code, newCode);
      plan.push({ id: row.id, oldCode: row.order_code, newCode });
    }

    console.log(`[rewrite] Plan: ${plan.length} orders to rewrite, ${skipped.length} skipped`);
    for (const p of plan.slice(0, 5)) console.log(`  ${p.oldCode}  →  ${p.newCode}`);
    if (plan.length > 5) console.log(`  ... and ${plan.length - 5} more`);
    for (const s of skipped) console.warn(`  SKIP ${s.oldCode}: ${s.reason}`);

    if (args.dryRun) {
      console.log('[rewrite] --dry-run: rolling back, no changes written.');
      await client.query('ROLLBACK');
      return;
    }

    // 4. Apply order_code updates one by one (cheap; small N typically).
    for (const p of plan) {
      await client.query(`UPDATE orders SET order_code = $1 WHERE id = $2`, [p.newCode, p.id]);
    }

    // 5. Push the counter table forward for each touched year so the live
    //    generator continues from the right value.
    for (const [year, maxSeq] of perYearMaxSeq.entries()) {
      await client.query(
        `INSERT INTO order_code_counters (year, last_issued, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (year) DO UPDATE
         SET last_issued = GREATEST(order_code_counters.last_issued, EXCLUDED.last_issued),
             updated_at = NOW()`,
        [year, maxSeq]
      );
    }

    await client.query('COMMIT');
    console.log(`[rewrite] DONE — ${plan.length} orders rewritten, counters updated for years: ${[...perYearMaxSeq.keys()].sort().join(', ')}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Guard so importing this module (e.g. from a unit test, to exercise
// `deriveWarrantyCode`) doesn't also kick off the live CLI run.
if (require.main === module) {
  run().catch((err) => {
    console.error('[rewrite] FAILED:', err.message);
    process.exit(1);
  });
}
