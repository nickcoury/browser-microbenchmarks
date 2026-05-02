/**
 * Shared benchmark runner for browser-microbenchmarks.
 *
 * Usage:
 *   const runner = new BenchmarkRunner();
 *   runner.add('Variant A', () => { /* code */ });
 *   runner.add('Variant B', () => { /* code */ });
 *   const results = await runner.run();
 */

class BenchmarkRunner {
  constructor(options = {}) {
    this.variants = [];
    this.warmupMs = options.warmupMs ?? 100;
    this.minRuns = options.minRuns ?? 5;
    this.maxRuns = options.maxRuns ?? 100;
    this.minTimeMs = options.minTimeMs ?? 1000;
    this.outlierSigma = options.outlierSigma ?? 2;
    this.logEl = options.logEl ?? null;
  }

  add(name, fn, opts = {}) {
    this.variants.push({ name, fn, setup: opts.setup || null, teardown: opts.teardown || null });
  }

  log(msg) {
    if (this.logEl) {
      this.logEl.textContent += msg + '\n';
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
    // eslint-disable-next-line no-console
    console.log(msg);
  }

  async _runVariant(variant) {
    const { name, fn, setup, teardown } = variant;
    this.log(`  Warming up "${name}" ...`);

    // Warmup
    const warmupEnd = performance.now() + this.warmupMs;
    while (performance.now() < warmupEnd) {
      if (setup) setup();
      fn();
      if (teardown) teardown();
    }

    // Measurement
    const times = [];
    let totalTime = 0;
    let runs = 0;

    while ((runs < this.minRuns || totalTime < this.minTimeMs) && runs < this.maxRuns) {
      if (setup) setup();
      const t0 = performance.now();
      fn();
      const t1 = performance.now();
      if (teardown) teardown();
      const dt = t1 - t0;
      times.push(dt);
      totalTime += dt;
      runs++;
    }

    // Remove outliers beyond N sigma
    const stats = this._stats(times);
    const filtered = times.filter(t => Math.abs(t - stats.mean) <= this.outlierSigma * stats.std);
    const finalStats = this._stats(filtered);

    this.log(`    ${runs} runs, ${filtered.length} kept, avg ${finalStats.mean.toFixed(3)} ms`);

    return {
      name,
      meanMs: finalStats.mean,
      medianMs: finalStats.median,
      stdMs: finalStats.std,
      minMs: finalStats.min,
      maxMs: finalStats.max,
      runs: filtered.length,
      opsPerSec: 1000 / finalStats.mean,
    };
  }

  async run() {
    this.log('Starting benchmark suite...');
    const results = [];
    for (const v of this.variants) {
      results.push(await this._runVariant(v));
      // Allow UI to breathe between variants
      await new Promise(r => requestAnimationFrame(r));
    }

    // Sort by ops/sec descending
    results.sort((a, b) => b.opsPerSec - a.opsPerSec);
    const best = results[0].opsPerSec;
    for (const r of results) {
      r.relative = r.opsPerSec / best;
    }

    this.log('Done.\n');
    return results;
  }

  _stats(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    const variance = sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const median = n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[Math.floor(n / 2)];
    return { mean, median, std, min: sorted[0], max: sorted[n - 1] };
  }
}

/**
 * Render results into a table and optional chart.
 */
function renderResults(results, tableEl, chartEl) {
  // Table
  let html = `<table class="results-table">
    <thead>
      <tr><th class="rank">#</th><th>Variant</th><th class="ops">ops/sec</th>
      <th class="relative">relative</th><th class="bar-cell"></th></tr>
    </thead><tbody>`;
  results.forEach((r, i) => {
    const pct = (r.relative * 100).toFixed(1);
    const ops = r.opsPerSec >= 1e6
      ? `${(r.opsPerSec / 1e6).toFixed(2)}M`
      : r.opsPerSec >= 1e3
        ? `${(r.opsPerSec / 1e3).toFixed(2)}k`
        : r.opsPerSec.toFixed(2);
    html += `<tr>
      <td class="rank">${i + 1}</td>
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td class="ops">${ops}</td>
      <td class="relative">${pct}%</td>
      <td class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div></td>
    </tr>`;
  });
  html += '</tbody></table>';
  tableEl.innerHTML = html;

  // Simple canvas bar chart
  if (chartEl) {
    drawBarChart(chartEl, results);
  }
}

function drawBarChart(canvas, results) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 24, right: 16, bottom: 48, left: 56 };
  const W = rect.width - pad.left - pad.right;
  const H = rect.height - pad.top - pad.bottom;

  ctx.clearRect(0, 0, rect.width, rect.height);

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, rect.width, rect.height);

  // Grid lines
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  const maxOps = results[0].opsPerSec;
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const y = pad.top + H - (i / steps) * H;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + W, y);
    ctx.stroke();

    const label = formatOps(maxOps * (i / steps));
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px SFMono-Regular, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pad.left - 8, y);
  }

  // Bars
  const barGap = 12;
  const barW = (W - barGap * (results.length - 1)) / results.length;
  results.forEach((r, i) => {
    const h = (r.opsPerSec / maxOps) * H;
    const x = pad.left + i * (barW + barGap);
    const y = pad.top + H - h;

    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, '#58a6ff');
    grad.addColorStop(1, '#1f6feb');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, barW, h);

    // Label
    ctx.save();
    ctx.translate(x + barW / 2, pad.top + H + 10);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.name, 0, 0);
    ctx.restore();
  });
}

function formatOps(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(0);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

// Expose globally
window.BenchmarkRunner = BenchmarkRunner;
window.renderResults = renderResults;
window.drawBarChart = drawBarChart;
