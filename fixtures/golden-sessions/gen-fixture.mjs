/*
  Authoring tool for the golden-session fixtures. The OHLC ledger below is
  the hand-designed source of truth: every session encodes specific,
  hand-verified behaviors (gap direction/size/fill, opening-range breaks
  and failures, prior-level touches, inside days, NR4, engulfing, streaks,
  OPEX day). expected-features.json asserts the exact derived values;
  the engine tests assert the query-level counts.

  Regenerate the CSVs with:  node fixtures/golden-sessions/gen-fixture.mjs
  (Committed output is the fixture — change the ledger only together with
  the expected values and the query-count assertions in the tests.)

  FIX_STK: NYSE RTH (09:30–16:00 ET), hourly bars, Jan 8–19 2024.
  Jan 2024 is EST (UTC−5) → 09:30 ET = 14:30 UTC. MLK Mon Jan 15 is a
  holiday: the engine must derive 9 sessions, not 10.

  FIX_FUT: same RTH shape with a futures contract column; the front month
  rolls H24 → M24 on Jan 10 with a basis jump that must register as a ROLL
  (gap features NULL), not a gap.
*/
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// [date, [O, H, L, C] × 7 hourly bars starting 09:30 ET]
const STK = [
  [
    "2024-01-08",
    [
      [100.0, 100.8, 99.6, 100.5],
      [100.5, 101.2, 100.3, 101.0],
      [101.0, 101.5, 100.8, 101.2],
      [101.2, 101.6, 100.9, 101.0],
      [101.0, 101.4, 100.7, 101.3],
      [101.3, 102.0, 101.1, 101.8],
      [101.8, 101.9, 101.2, 101.5],
    ],
  ],
  [
    "2024-01-09",
    [
      [101.9, 102.3, 101.7, 102.1],
      [102.1, 102.4, 101.8, 101.9],
      [101.9, 102.0, 101.4, 101.5],
      [101.5, 101.7, 101.2, 101.3],
      [101.3, 101.5, 100.9, 101.0],
      [101.0, 101.2, 100.8, 101.1],
      [101.1, 101.3, 100.9, 101.0],
    ],
  ],
  [
    "2024-01-10",
    [
      [100.5, 100.9, 100.2, 100.4],
      [100.4, 100.6, 100.0, 100.1],
      [100.1, 100.3, 99.8, 99.9],
      [99.9, 100.1, 99.5, 99.6],
      [99.6, 99.8, 99.2, 99.4],
      [99.4, 99.6, 99.0, 99.1],
      [99.1, 99.3, 98.9, 99.0],
    ],
  ],
  [
    "2024-01-11",
    [
      [98.8, 99.2, 98.6, 99.1],
      [99.1, 99.5, 99.0, 99.4],
      [99.4, 99.8, 99.3, 99.7],
      [99.7, 100.0, 99.5, 99.9],
      [99.9, 100.2, 99.7, 100.1],
      [100.1, 100.4, 99.9, 100.3],
      [100.3, 100.7, 100.1, 100.6],
    ],
  ],
  [
    "2024-01-12",
    [
      [100.6, 100.7, 100.2, 100.5],
      [100.5, 100.6, 100.1, 100.3],
      [100.3, 100.4, 99.9, 100.0],
      [100.0, 100.2, 99.8, 100.1],
      [100.1, 100.3, 100.0, 100.2],
      [100.2, 100.4, 100.0, 100.3],
      [100.3, 100.7, 100.2, 100.65],
    ],
  ],
  [
    "2024-01-16",
    [
      [101.7, 102.2, 101.5, 102.0],
      [102.0, 102.5, 101.8, 102.4],
      [102.4, 102.9, 102.2, 102.8],
      [102.8, 103.1, 102.5, 102.9],
      [102.9, 103.3, 102.7, 103.2],
      [103.2, 103.6, 103.0, 103.5],
      [103.5, 103.8, 103.2, 103.6],
    ],
  ],
  [
    "2024-01-17",
    [
      [103.1, 103.4, 102.9, 103.2],
      [103.2, 103.5, 103.0, 103.4],
      [103.4, 103.7, 103.2, 103.5],
      [103.5, 103.6, 103.1, 103.2],
      [103.2, 103.3, 102.8, 102.9],
      [102.9, 103.0, 102.5, 102.6],
      [102.6, 102.8, 102.3, 102.4],
    ],
  ],
  [
    "2024-01-18",
    [
      [102.5, 102.8, 102.35, 102.7],
      [102.7, 103.0, 102.6, 102.9],
      [102.9, 103.2, 102.8, 103.1],
      [103.1, 103.4, 103.0, 103.3],
      [103.3, 103.5, 103.1, 103.4],
      [103.4, 103.7, 103.3, 103.6],
      [103.6, 103.9, 103.5, 103.8],
    ],
  ],
  [
    "2024-01-19",
    [
      [103.7, 103.75, 103.4, 103.5],
      [103.5, 103.6, 103.2, 103.3],
      [103.3, 103.4, 103.0, 103.1],
      [103.1, 103.2, 102.8, 102.9],
      [102.9, 103.0, 102.6, 102.7],
      [102.7, 102.9, 102.5, 102.6],
      [102.6, 102.7, 102.4, 102.5],
    ],
  ],
];

// FIX_FUT: flat sessions with a contract roll on Jan 10 (basis jump ≠ gap).
const FUT = [
  [
    "2024-01-08",
    "FIX_FUTH24",
    [
      [5000, 5010, 4990, 5005],
      [5005, 5015, 5000, 5010],
      [5010, 5020, 5005, 5015],
      [5015, 5020, 5005, 5010],
      [5010, 5015, 5000, 5005],
      [5005, 5015, 5000, 5010],
      [5010, 5015, 5000, 5008],
    ],
  ],
  [
    "2024-01-09",
    "FIX_FUTH24",
    [
      [5010, 5020, 5000, 5015],
      [5015, 5025, 5010, 5020],
      [5020, 5030, 5015, 5025],
      [5025, 5030, 5015, 5020],
      [5020, 5025, 5010, 5015],
      [5015, 5025, 5010, 5020],
      [5020, 5025, 5010, 5018],
    ],
  ],
  // Roll day: M24 opens ~0.5% above H24's close — a roll, not a gap.
  [
    "2024-01-10",
    "FIX_FUTM24",
    [
      [5043, 5053, 5033, 5048],
      [5048, 5058, 5043, 5053],
      [5053, 5063, 5048, 5058],
      [5058, 5063, 5048, 5053],
      [5053, 5058, 5043, 5048],
      [5048, 5058, 5043, 5053],
      [5053, 5058, 5043, 5051],
    ],
  ],
  [
    "2024-01-11",
    "FIX_FUTM24",
    [
      [5056, 5066, 5046, 5061],
      [5061, 5071, 5056, 5066],
      [5066, 5076, 5061, 5071],
      [5071, 5076, 5061, 5066],
      [5066, 5071, 5056, 5061],
      [5061, 5071, 5056, 5066],
      [5066, 5071, 5056, 5064],
    ],
  ],
];

function epochMs(dateIso, barIndex) {
  const [y, m, d] = dateIso.split("-").map(Number);
  // 09:30 ET in January = 14:30 UTC; hourly bars.
  return Date.UTC(
    y,
    m - 1,
    d,
    14 + Math.floor((30 + barIndex * 60) / 60),
    (30 + barIndex * 60) % 60,
  );
}

{
  const lines = ["ts,open,high,low,close,volume"];
  for (const [date, bars] of STK) {
    bars.forEach((bar, i) => {
      const [o, h, l, c] = bar;
      lines.push(`${epochMs(date, i)},${o},${h},${l},${c},1000`);
    });
  }
  writeFileSync(join(here, "fix-stk.csv"), lines.join("\n") + "\n");
  console.log(`fix-stk.csv: ${lines.length - 1} bars`);
}

{
  const lines = ["ts,open,high,low,close,volume,contract"];
  for (const [date, contract, bars] of FUT) {
    bars.forEach((bar, i) => {
      const [o, h, l, c] = bar;
      lines.push(`${epochMs(date, i)},${o},${h},${l},${c},500,${contract}`);
    });
  }
  writeFileSync(join(here, "fix-fut.csv"), lines.join("\n") + "\n");
  console.log(`fix-fut.csv: ${lines.length - 1} bars`);
}
