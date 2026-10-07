// The page. One bold thing: a thirty-second pass through a short tunnel,
// rendered live. Everything around it is the marginal information a good
// report carries — a text column, italic notes, and tables that hold the
// numbers. No view switchers, no camera buttons, nothing to configure.

import { Suspense, lazy, useEffect, useRef } from 'react'
import { SCENARIO, SCRIPT_SECONDS, stageOf, useRun } from './run'
import type { SimResult } from './lib/sim/engine'

const TunnelScene = lazy(() => import('./components/TunnelScene'))

const m = (v: number, d = 1) => `${v.toFixed(d)} m`
const pct = (v: number, d = 1) => `${v.toFixed(d)} %`

// ---------------------------------------------------------------------------
// The pass, as a live readout on the plate
// ---------------------------------------------------------------------------

function Readout({ run }: { run: ReturnType<typeof useRun> }) {
  const { sim, ui } = run
  const f = sim.frames[ui]
  const lost = f.gnss === 'LOST'
  return (
    <div className="on-dark pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 p-3 sm:p-4">
      <div className="flex items-baseline gap-3">
        <span className="text-[28px] leading-none font-light tabular-nums sm:text-[34px]">
          {((ui / Math.max(1, sim.frames.length - 1)) * SCRIPT_SECONDS).toFixed(1)}
          <span className="ml-1 text-[13px] text-white/50">s</span>
        </span>
        <span className="label max-w-[22ch] leading-tight">{stageOf(sim, f.s, f.gnss)}</span>
      </div>
      <dl className="flex gap-5 text-[12px] sm:gap-7 sm:text-[13px]">
        {(
          [
            ['Uncorrected DR', f.errDr, '#E0604F'],
            ['Standard ESKF', f.errStd, '#C79A3C'],
            ['AI + ESKF', f.errAi, '#7FD4C1'],
          ] as const
        ).map(([k, v, c]) => (
          <div key={k}>
            <dt className="flex items-center gap-1.5 text-[11px] tracking-[0.1em] text-white/50 uppercase">
              <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: c }} />
              {k}
            </dt>
            <dd className="mt-0.5 text-[17px] font-light tabular-nums sm:text-[19px]">{m(v)}</dd>
          </div>
        ))}
      </dl>
      <div
        className={`label border px-2 py-1 tracking-[0.18em] ${
          lost ? 'border-[#E0604F]/70 text-[#F0A79B]' : 'border-white/25 text-white/70'
        }`}
      >
        {lost ? 'GNSS DENIED' : `GNSS ${f.gnss}`}
      </div>
    </div>
  )
}

/** Where the three estimates are, seen from above. The whole claim in one mark. */
function PlanInset({ run }: { run: ReturnType<typeof useRun> }) {
  const { sim, ui } = run
  const cv = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = cv.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const W = (c.width = 268)
    const H = (c.height = 186)
    ctx.clearRect(0, 0, W, H)

    // Frame the denial window with a little road either side, because that is
    // where the three estimates actually separate.
    const pad = 90
    const s0 = Math.max(0, sim.entry - pad)
    const s1 = Math.min(sim.totalLen, sim.exit + pad)
    const win = sim.frames.filter((q) => q.s >= s0 && q.s <= s1)
    const xs = win.map((q) => q.x).concat(win.map((q) => q.drX), win.map((q) => q.aiX))
    const lo = Math.min(...xs) - 6
    const hi = Math.max(...xs) + 6
    const sx = (x: number) => ((x - lo) / Math.max(1, hi - lo)) * (W - 24) + 12
    const sy = (s: number) => H - 14 - ((s - s0) / Math.max(1, s1 - s0)) * (H - 26)

    // the bore, as a shaded band
    ctx.fillStyle = 'rgba(232,237,235,0.1)'
    ctx.fillRect(0, sy(sim.exit), W, sy(sim.entry) - sy(sim.exit))
    ctx.strokeStyle = 'rgba(232,237,235,0.34)'
    ctx.lineWidth = 1
    for (const s of [sim.entry, sim.exit]) {
      ctx.beginPath()
      ctx.moveTo(4, sy(s))
      ctx.lineTo(W - 4, sy(s))
      ctx.stroke()
    }

    const line = (get: (i: number) => [number, number], upTo: number, color: string, w: number, dash: number[]) => {
      ctx.save()
      ctx.setLineDash(dash)
      ctx.strokeStyle = color
      ctx.lineWidth = w
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let i = 0; i <= upTo; i += 2) {
        const [x, z] = get(i)
        if (i === 0) ctx.moveTo(sx(x), sy(z))
        else ctx.lineTo(sx(x), sy(z))
      }
      ctx.stroke()
      ctx.restore()
    }
    // the road the bike actually followed
    line((i) => [sim.frames[i].x, sim.frames[i].s], sim.frames.length - 1, 'rgba(232,237,235,0.5)', 2.5, [5, 4])
    const upTo = Math.min(sim.frames.length - 1, ui)
    line((i) => [sim.frames[i].drX, sim.frames[i].s], upTo, '#E0604F', 1.6, [])
    line((i) => [sim.frames[i].stdX, sim.frames[i].s], upTo, '#C79A3C', 1.6, [])
    line((i) => [sim.frames[i].aiX, sim.frames[i].s], upTo, '#7FD4C1', 2.1, [])

    // the bike
    const f = sim.frames[upTo]
    ctx.fillStyle = '#FFFFFF'
    ctx.beginPath()
    ctx.arc(sx(f.x), sy(f.s), 3.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.lineWidth = 1
    ctx.stroke()
  }, [sim, ui])

  return (
    <figure className="plan-panel on-dark m-0 w-[268px] shrink-0">
      <canvas ref={cv} className="block" style={{ width: 268, height: 186 }} />
      <figcaption className="label mt-1.5 leading-tight">
        Plan view · the denial window.
        <br />
        <span className="text-white/45">Dashed is the road. Shaded is the bore.</span>
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// Evidence — every number computed by this run, nothing typed in by hand
// ---------------------------------------------------------------------------

function Evidence({ sim }: { sim: SimResult }) {
  const g = sim.metrics
  const denied = sim.frames.filter((f) => f.gnss === 'LOST').length
  const rows: [string, string, string][] = [
    ['Keeps the estimate inside the bore', pct(g.driftReduction), `${m(g.rmseDr, 2)} RMSE uncorrected against ${m(g.rmseAi, 2)} with the model, over the whole ${m(sim.params.tunnelLengthM, 0)} bore.`],
    ['Worst moment of the outage', m(g.maxDr), `Peak uncorrected drift, against ${m(g.maxAi)} at the same instant for AI + ESKF.`],
    ['Holds heading while turning', `${(g.hdgRmseAi * 57.3).toFixed(2)}°`, `Heading RMSE through the curves, against ${(g.hdgRmseDr * 57.3).toFixed(2)}° uncorrected.`],
    ['Finds the wheel slipping', pct(g.slipAccuracy * 100), `Share of slip frames the Bi-LSTM flagged above 0.5 probability, across ${g.slipEvents} detected windows.`],
    ['Knows when it is guessing', pct(g.navConfMean * 100), `Mean confidence the filter reports, falling as covariance grows and no satellite update arrives.`],
  ]
  return (
    <div className="cols cols--wide">
      <div>
        <table className="evidence">
          <caption className="sr-only">Measured results from the run shown above</caption>
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Result</th>
              <th scope="col">How it was measured</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, v, how]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{v}</td>
                <td>{how}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note m-0 max-w-[62ch] text-[15px] leading-relaxed">
          The run holds for {denied} frames with no satellite fix — {pct((denied / sim.frames.length) * 100, 0)} of the
          whole pass. Every figure on this page is read out of that same simulation, so scrubbing the pass above moves
          the numbers with it.
        </p>
      </div>
      <aside className="margin">
        Nothing here is a target. The bias and slip the model is correcting are the ones the run actually injects, and
        the filter is never told what they are.
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function Seam() {
  const run = useRun()
  const { sim, playing, done, toggle, seek, replay, progressRef } = run
  const bar = useRef<HTMLInputElement>(null)

  // paint the scrub thumb from the rAF loop, so it tracks the 3D exactly
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = bar.current
      if (!el) return
      const v = String(Math.round(progressRef.current * 1000))
      if (el.value !== v) el.value = v
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [progressRef])

  return (
    <div className="min-h-screen bg-film">
      <header className="masthead">
        <a className="mark wide" href="#top">
          Seamless
        </a>
        <nav aria-label="Sections">
          <a href="#pass">The pass</a>
          <a href="#evidence">Evidence</a>
          <a href="#method">Method</a>
          <a href="#limits">Limits</a>
          <button type="button" className="go cursor-pointer border-0" onClick={replay}>
            {done ? 'Run it again' : 'Replay the pass'}
          </button>
        </nav>
      </header>

      <main id="top">
        {/* ---- the one bold thing ---- */}
        <section className="hero" aria-labelledby="heroTitle">
          <div className="hero-copy">
            <h1 id="heroTitle" className="wide">
              Thirty seconds.
              <br />
              No satellites.
            </h1>
            <p className="lede">
              A motorcycle enters a 400-metre tunnel. For the twenty-three seconds it takes to cross, there is no GPS fix
              at all — only the bike's own inertial sensors and wheel speeds. This is that pass, rendered live: the
              uncorrected estimate walks off the road, the corrected one does not.
            </p>          </div>

          <figure className="plate figure">
            <Suspense fallback={<div className="on-dark grid aspect-[3.1/1] place-items-center label">Cutting the bore…</div>}>
              <div className="stage">
                <TunnelScene sim={sim} idxRef={run.idxRef} progress={progressRef} />
              </div>
            </Suspense>

            {/* the plate's own furniture: a small plan view, and the numbers */}
            <div className="on-dark pointer-events-none absolute left-4 top-14 hidden sm:block">
              <PlanInset run={run} />
            </div>
            <Readout run={run} />

            <div className="on-dark absolute inset-x-0 top-0 flex justify-between p-3 sm:p-4">
              <span className="label border border-white/20 px-2 py-1">SIH 2026 · Problem 26168</span>
              <span className="label border border-white/20 px-2 py-1">
                {sim.frames[run.ui].gnss === 'LOST' ? 'Denial window' : 'Satellites available'}
              </span>
            </div>
          </figure>

          {/* the only control on the page */}
          <div className="wipe-controls">
            <button type="button" className="on-dark plain-btn border-white/30 text-white/90 hover:border-white" onClick={toggle}>
              {playing ? 'Pause' : done ? 'Play again' : 'Play'}
            </button>
            <input
              ref={bar}
              type="range"
              min={0}
              max={1000}
              defaultValue={0}
              step={1}
              aria-label="Scrub through the thirty-second pass"
              onChange={(e) => seek(Number(e.target.value) / 1000)}
            />
            <p className="note">
              {SCRIPT_SECONDS} seconds of wall clock over {sim.duration.toFixed(0)} seconds of simulated riding at{' '}
              {SCENARIO.bikeSpeedKmh} km/h. The wheel is turning faster than the road is passing; the estimators do not
              know.
            </p>
          </div>
        </section>

        {/* ---- the pass, in words ---- */}
        <section id="pass" className="band" aria-labelledby="passTitle">
          <h2 id="passTitle">The pass</h2>
          <div className="cols">
            <div className="prose">
              <p>
                Dead reckoning is the oldest trick in navigation: integrate acceleration twice and turn rate once, and you
                know where you went. It is also the reason a car that drives through a tunnel for a minute comes out
                pointing at a field. Small errors in the gyroscope and accelerometer compound, and without a satellite
                there is nothing to say otherwise.
              </p>
              <p>
                This system does two things about that. A Bi-LSTM reads the last few seconds of inertial data and
                predicts the biases it is riding on, and the probability that a wheel is slipping rather than rolling.
                A fifteen-state error-state Kalman filter then treats those predictions as priors: it is not told the
                answer, but it is told what shape the error is likely to take, and it re-weights its own corrections
                to match.
              </p>
              <p>
                The pass is 110 metres of open road, 400 metres of bore, and 90 metres of open road again. Satellites
                degrade at the portal, vanish for the whole crossing, and return at the far end — where every filter is
                re-anchored and the run is scored.
              </p>
            </div>
            <aside className="margin">
              Twenty-three seconds is not long. It is also the length of plenty of real urban tunnels, and long enough
              for an uncorrected estimate to end up two lanes away.
            </aside>
          </div>
        </section>

        {/* ---- what the numbers say ---- */}
        <section id="evidence" className="band" aria-labelledby="evidenceTitle">
          <h2 id="evidenceTitle">Evidence</h2>
          <p className="prose mb-6 max-w-[64ch] text-[17px] leading-relaxed">
            A number only counts if something outside the model checked it. These are all read out of the run above,
            against the same ground truth the bike actually followed.
          </p>
          <Evidence sim={sim} />
        </section>

        {/* ---- the pipeline, stage by stage ---- */}
        <section id="method" className="band" aria-labelledby="methodTitle">
          <h2 id="methodTitle">Method</h2>
          <div className="prose">
            <p>
              One sensor stream feeds all four trajectories. The simulation runs the real physics at 100 Hz — IMU rate —
              and writes frames at 10 Hz for the renderer. The uncorrected estimate is pure strapdown integration and is
              never touched. The standard filter adds a fixed-gain GNSS update that simply switches off underground. The
              third is the same filter with the network's predictions folded into its bias states.
            </p>
          </div>
          <ol className="log">
            {(
              [
                ['Ingest', 'IMU at 100 Hz, wheel speed at the same rate, GNSS sampled whenever a fix exists.', '—'],
                ['Raw DR', 'Strapdown integration of the measured values, uncorrected for the whole pass.', 'baseline'],
                ['Standard ESKF', 'Fifteen-state error-state filter, fixed gains, GNSS on or off.', 'comparison'],
                ['Bi-LSTM', 'Predicts gyro bias, accelerometer bias, drift rate and wheel-slip probability from the recent window.', 'ours'],
                ['Adaptive ESKF', 'Folds those predictions into the bias states and scales the corrections to match, so the wheel and the inertial solution stay consistent.', 'ours'],
                ['Score', 'Every frame is compared against the trajectory the bike actually followed. Nothing is hardcoded.', 'pass/fail'],
              ] as const
            ).map(([name, what, tag], i) => (
              <li key={name} style={{ ['--o' as string]: i / 5 }}>
                <b>{name}</b>
                <span>{what}</span>
                <i>{tag}</i>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- what it cannot do ---- */}
        <section id="limits" className="band" aria-labelledby="limitsTitle">
          <h2 id="limitsTitle">Limits</h2>
          <div className="cols">
            <ul className="prose limits">
              <li>
                <b>It is a simulation.</b> The sensor stream, the bias, the slip and the road are all generated, because a
                real run with surveyed ground truth was not available to us. The algorithms are real; the input is not.
              </li>
              <li>
                <b>The bore is short.</b> Four hundred metres. Long-haul tunnels are harder: the filter's uncertainty
                grows without a fix for the whole crossing, and no amount of prediction replaces a measurement.
              </li>
              <li>
                <b>It needs wheel speed.</b> A platform with no reliable velocity source — a drone, a pedestrian without
                a steady stride detector — has nothing to integrate, and the network's slip prediction has nothing to
                correct.
              </li>
              <li>
                <b>It is not a map.</b> This holds a position. It does not know which road it is on, what is at the
                next exit, or whether the tunnel has a service door.
              </li>
            </ul>
            <aside className="margin">
              We would rather show these than hide them. Every number above carries the assumption it was made under.
            </aside>
          </div>
        </section>
      </main>

      <footer className="colophon">
        <p>
          Seamless, for Smart India Hackathon 2026, problem statement SIH26168. Team Techminds_01.
        </p>
        <p className="note">
          Bi-LSTM sensor-bias and wheel-slip prediction fused with a fifteen-state adaptive error-state Kalman filter.
          Rendered with three.js; the tunnel, the road surface and the motorcycle are generated in the browser, so the
          page ships no textures and no models.
        </p>
      </footer>
    </div>
  )
}
