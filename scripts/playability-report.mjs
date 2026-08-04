'use strict';

/**
 * 再生可能性インデックス(data/playability.json)の前回比レポート。
 * I/O は持たず、CLI(compare-playability.mjs)とテストの両方から使う。
 *
 * 目的は「静かな崩壊」の検出。実際に 2026-08-04 の 3 連続実行で
 *   01:39 playable 5,846 → 05:28 playable 751 → 06:23 playable 5,428
 * という取りこぼしが起き(総 URL 数 17,968 は 3 回とも同一)、
 * 壊れたインデックスがそのままコミット・デプロイされた。
 * 健全な実行同士の変動は -7.2% だったのに対し、この事故は -87.2% で、
 * 両者は 1 桁違う。既定のしきい値はこの実測値から決めている:
 *
 *   fail  … 再生可能率が前回の 50% 未満(事故 -87% は捕捉、通常変動 -7% とは 43pt の余裕)
 *   warn  … 20% 以上の低下(fail させず注意喚起だけ。通常変動との余裕は 13pt)
 *
 * 総 URL 数(上流 streams.json の規模)にも同じ比率を当てる。上流が縮んで
 * playable が減るのは正常なので、判定は「率」で行い、上流の異常縮小は
 * 総数側のチェックで別に捕まえる。
 */

export const DEFAULTS = {
  failDropRatio: 0.5,
  warnDropRatio: 0.2,
};

// data/playability.json の status 値 → 表示名(scripts/probe-streams.mjs と対応)
export const STATUS_LABELS = {
  1: '再生可能 (1)',
  2: '混在コンテンツ (2)',
  3: 'CORS なし (3)',
  0: '応答なし (0)',
};

const STATUS_ORDER = [1, 2, 3, 0];

function countsOf(index) {
  const counts = {};
  const raw = index && index.counts ? index.counts : {};
  for (const status of STATUS_ORDER) {
    const n = Number(raw[status]);
    counts[status] = Number.isFinite(n) ? n : 0;
  }
  return counts;
}

function totalOf(index, counts) {
  const n = Number(index && index.total);
  if (Number.isFinite(n) && n > 0) return n;
  return STATUS_ORDER.reduce((sum, s) => sum + counts[s], 0);
}

/** 相対変化 (next - prev) / prev。prev が 0 のときは比較不能として null */
function ratio(prev, next) {
  if (!prev) return null;
  return (next - prev) / prev;
}

/** 前回から見た低下率。増えていれば 0。比較不能なら null */
function dropOf(prev, next) {
  const r = ratio(prev, next);
  return r === null ? null : Math.max(0, -r);
}

function statusMap(index) {
  return index && index.status && typeof index.status === 'object' ? index.status : null;
}

/**
 * status マップ同士を突き合わせ、新規死亡・復活・URL の増減を数える。
 * どちらかに status が無ければ null(算出不能)。
 */
function churnOf(prev, next) {
  const a = statusMap(prev);
  const b = statusMap(next);
  if (!a || !b) return null;
  let newlyDead = 0;
  let revived = 0;
  let added = 0;
  let removed = 0;
  for (const url of Object.keys(b)) {
    if (!(url in a)) {
      added++;
      continue;
    }
    if (a[url] === 1 && b[url] === 0) newlyDead++;
    else if (a[url] === 0 && b[url] === 1) revived++;
  }
  for (const url of Object.keys(a)) {
    if (!(url in b)) removed++;
  }
  return { newlyDead, revived, added, removed };
}

/**
 * 前回と今回のインデックスを比較する。
 * @param {object|null} prev 前回の playability.json(初回は null)
 * @param {object} next 今回の playability.json
 * @param {object} opts {failDropRatio, warnDropRatio}
 */
export function comparePlayability(prev, next, opts = {}) {
  const failDropRatio = opts.failDropRatio ?? DEFAULTS.failDropRatio;
  const warnDropRatio = opts.warnDropRatio ?? DEFAULTS.warnDropRatio;
  const hasPrev = Boolean(prev && prev.counts);

  const nextCounts = countsOf(next);
  const prevCounts = hasPrev ? countsOf(prev) : null;
  const nextTotal = totalOf(next, nextCounts);
  const prevTotal = hasPrev ? totalOf(prev, prevCounts) : 0;

  const rows = STATUS_ORDER.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    prev: hasPrev ? prevCounts[status] : null,
    next: nextCounts[status],
    delta: hasPrev ? nextCounts[status] - prevCounts[status] : null,
    ratio: hasPrev ? ratio(prevCounts[status], nextCounts[status]) : null,
  }));

  const nextRate = nextTotal ? nextCounts[1] / nextTotal : 0;
  const prevRate = hasPrev && prevTotal ? prevCounts[1] / prevTotal : 0;

  const checks = [];

  // 上流(streams.json)の規模が急に縮むのも壊れたインデックスの兆候
  const totalDrop = hasPrev ? dropOf(prevTotal, nextTotal) : null;
  if (totalDrop !== null && totalDrop > failDropRatio) {
    checks.push({
      id: 'total',
      level: 'error',
      message: `プローブ対象 URL が ${pct(totalDrop)} 減りました (${fmt(prevTotal)} → ${fmt(nextTotal)})`,
    });
  } else if (totalDrop !== null && totalDrop > warnDropRatio) {
    checks.push({
      id: 'total',
      level: 'warn',
      message: `プローブ対象 URL が ${pct(totalDrop)} 減りました (${fmt(prevTotal)} → ${fmt(nextTotal)})`,
    });
  }

  // 主判定。上流の規模変動に引きずられないよう「率」で見る
  const rateDrop = hasPrev ? dropOf(prevRate, nextRate) : null;
  if (rateDrop !== null && rateDrop > failDropRatio) {
    checks.push({
      id: 'playable-rate',
      level: 'error',
      message:
        `再生可能率が ${pct(rateDrop)} 低下しました (${pct(prevRate)} → ${pct(nextRate)})。` +
        `プローブ環境の異常が疑われるため、壊れたインデックスを配信しないよう中断します`,
    });
  } else if (rateDrop !== null && rateDrop > warnDropRatio) {
    checks.push({
      id: 'playable-rate',
      level: 'warn',
      message: `再生可能率が ${pct(rateDrop)} 低下しました (${pct(prevRate)} → ${pct(nextRate)})`,
    });
  }

  // 前回が無い初回でも、全滅は無条件に異常として扱う
  if (nextTotal > 0 && nextCounts[1] === 0) {
    checks.push({
      id: 'empty',
      level: 'error',
      message: '再生可能なストリームが 1 件もありません',
    });
  }

  return {
    hasPrev,
    rows,
    total: {
      prev: hasPrev ? prevTotal : null,
      next: nextTotal,
      delta: hasPrev ? nextTotal - prevTotal : null,
      ratio: hasPrev ? ratio(prevTotal, nextTotal) : null,
    },
    rate: { prev: hasPrev ? prevRate : null, next: nextRate },
    churn: hasPrev ? churnOf(prev, next) : null,
    checks,
    ok: !checks.some((c) => c.level === 'error'),
    thresholds: { failDropRatio, warnDropRatio },
  };
}

// ---- 表示 -------------------------------------------------------------------

/** ロケール設定に左右されない 3 桁区切り */
export function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(n) {
  if (n === 0) return '±0';
  return n > 0 ? `+${fmt(n)}` : `-${fmt(-n)}`;
}

function deltaCell(row) {
  if (row.delta === null) return '—';
  if (row.delta === 0 || row.ratio === null) return signed(row.delta);
  return `${signed(row.delta)} (${row.ratio >= 0 ? '+' : ''}${(row.ratio * 100).toFixed(1)}%)`;
}

/** GitHub Actions のジョブサマリ用 Markdown */
export function formatSummary(report, meta = {}) {
  const lines = ['## 再生可能性インデックス'];
  if (meta.generatedAt) lines.push('', `生成: \`${meta.generatedAt}\``);
  lines.push('', '| 区分 | 前回 | 今回 | 差分 |', '|---|---:|---:|---:|');
  for (const row of report.rows) {
    lines.push(
      `| ${row.label} | ${row.prev === null ? '—' : fmt(row.prev)} | ${fmt(row.next)} | ${deltaCell(row)} |`
    );
  }
  const t = report.total;
  lines.push(`| **合計** | ${t.prev === null ? '—' : fmt(t.prev)} | ${fmt(t.next)} | ${deltaCell(t)} |`);

  lines.push('');
  if (report.hasPrev) {
    const diffPt = (report.rate.next - report.rate.prev) * 100;
    lines.push(
      `再生可能率: ${pct(report.rate.prev)} → ${pct(report.rate.next)} ` +
        `(${diffPt >= 0 ? '+' : ''}${diffPt.toFixed(1)}pt)`
    );
  } else {
    lines.push(`再生可能率: ${pct(report.rate.next)}(前回のインデックスが無いため比較なし)`);
  }

  if (report.churn) {
    const c = report.churn;
    lines.push(
      '',
      `内訳: 新規に応答なし ${fmt(c.newlyDead)} ・ 復活 ${fmt(c.revived)} ・ ` +
        `新規 URL ${fmt(c.added)} ・ 消滅 ${fmt(c.removed)}`
    );
  }

  lines.push('');
  if (!report.checks.length) {
    lines.push('✅ 前回比の急落はありません');
  } else {
    for (const check of report.checks) {
      lines.push(`${check.level === 'error' ? '❌' : '⚠️'} ${check.message}`);
    }
  }
  lines.push(
    '',
    `<sub>しきい値: fail ${pct(report.thresholds.failDropRatio)} / ` +
      `warn ${pct(report.thresholds.warnDropRatio)}(前回比の低下率)</sub>`
  );
  return lines.join('\n') + '\n';
}

/** GitHub Actions のログ注釈(::error:: / ::warning::) */
export function formatAnnotations(report) {
  return report.checks.map(
    (c) => `::${c.level === 'error' ? 'error' : 'warning'}::${c.message.replace(/\r?\n/g, ' ')}`
  );
}
