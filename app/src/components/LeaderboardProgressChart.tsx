/**
 * LeaderboardProgressChart
 *
 * SVG line chart showing cumulative points per team over the season.
 * Features:
 *   - Top-N cap selector (Top 3 / Top 5 / Top 10 / All) — resets manual overrides
 *   - Your team always pinned (gold line, not toggleable)
 *   - Tappable legend rows — show/hide individual team lines
 *   - Booster markers on the line at the match they were used
 *   - Right-side labels with Y de-collision
 *   - ▶ Trace button to animate the chart path on demand (⏸ Pause / ▶ Resume / ◼ Stop)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, {
  Circle,
  G,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from 'react-native-svg';
import { LeaderboardHistory } from '../lib/leaderboardHistory';
import { fontSize, spacing, radius } from '../theme';

// ── Constants ─────────────────────────────────────────────────────────────────

const MY_COLOR = '#C9A84C';
const PALETTE  = ['#2563EB','#7C3AED','#059669','#DC2626','#D97706','#0891B2','#BE185D','#064E3B'];

const CAP_OPTIONS = [
  { n: 3,   label: 'Top 3'  },
  { n: 5,   label: 'Top 5'  },
  { n: 10,  label: 'Top 10' },
  { n: 999, label: 'All'    },
];

const STEP_MS  = 350;
const PAUSE_MS = 70;
const CYCLE    = STEP_MS + PAUSE_MS;

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  accent: '#C9A84C',
  border: 'rgba(201,168,76,0.25)',
};

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  history:   LeaderboardHistory;
  myUserId:  string | undefined | null;
  width:     number;               // available pixel width (screen width − outer padding)
}

export function LeaderboardProgressChart({ history, myUserId, width }: Props) {
  const { squads, series, boosters } = history;

  const [cap,          setCap]          = useState(5);
  const [manualHidden, setManualHidden] = useState<Set<string>>(new Set());
  const [manualShown,  setManualShown]  = useState<Set<string>>(new Set());

  // Animation state: null = static final view, number = current fractional match index
  const [animFrac, setAnimFrac] = useState<number | null>(null);
  const [paused,   setPaused]   = useState(false);
  const [tipIdx,   setTipIdx]   = useState<number | null>(null);  // tapped booster dot
  const [zoom,     setZoom]     = useState(1);                     // horizontal zoom (1×–4×)
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef   = useRef<number>(0);   // ms of animation played so far (survives pause)
  const lastTickRef  = useRef<number>(0);

  // ── Derived from props ─────────────────────────────────────────────────────

  const mySquadIds = useMemo(
    () => new Set(squads.filter(s => s.userId === myUserId).map(s => s.squadId)),
    [squads, myUserId],
  );

  const colorMap = useMemo(() => {
    const map: Record<string, string> = {};
    let pi = 0;
    squads.forEach(sq => {
      map[sq.squadId] = mySquadIds.has(sq.squadId) ? MY_COLOR : PALETTE[pi++ % PALETTE.length];
    });
    return map;
  }, [squads, mySquadIds]);

  // Ranked best → worst (for cap selection + legend order)
  const squadsByRank = useMemo(() =>
    [...squads].sort((a, b) =>
      ((series[b.squadId] || []).slice(-1)[0]?.cumulative ?? 0) -
      ((series[a.squadId] || []).slice(-1)[0]?.cumulative ?? 0)
    ),
    [squads, series],
  );

  const matchNumbers = useMemo(() => {
    const set = new Set<number>();
    squads.forEach(sq => (series[sq.squadId] || []).forEach(e => set.add(e.matchNumber)));
    return [...set].sort((a, b) => a - b);
  }, [squads, series]);

  const maxPts = useMemo(() => {
    const vals = Object.values(series).flatMap(s => s.map(e => e.cumulative));
    return vals.length ? Math.max(...vals) * 1.12 : 100;
  }, [series]);

  const N = matchNumbers.length;

  // ── Vis state ──────────────────────────────────────────────────────────────

  const getVisible = useCallback((): Set<string> => {
    const topN = new Set(squadsByRank.slice(0, cap).map(s => s.squadId));
    const result = new Set<string>();
    squads.forEach(sq => {
      if (manualHidden.has(sq.squadId)) return;
      if (mySquadIds.has(sq.squadId) || topN.has(sq.squadId) || manualShown.has(sq.squadId))
        result.add(sq.squadId);
    });
    return result;
  }, [squads, squadsByRank, cap, manualHidden, manualShown, mySquadIds]);

  const visible = getVisible();

  const switchCap = (n: number) => {
    stopTrace();
    setTipIdx(null);
    setCap(n);
    setManualHidden(new Set());
    setManualShown(new Set());
  };

  const toggleSquad = (squadId: string) => {
    if (visible.has(squadId)) {
      setManualHidden(prev => { const s = new Set(prev); s.add(squadId); return s; });
      setManualShown( prev => { const s = new Set(prev); s.delete(squadId); return s; });
    } else {
      setManualShown( prev => { const s = new Set(prev); s.add(squadId); return s; });
      setManualHidden(prev => { const s = new Set(prev); s.delete(squadId); return s; });
    }
  };

  // ── Chart geometry ─────────────────────────────────────────────────────────

  const W  = width * zoom;
  const H  = 200;
  const ML = 36, MR = 14, MT = 10, MB = 22;
  const PW = W - ML - MR, PH = H - MT - MB;

  const pxOf = (i: number)  => ML + (N > 1 ? (i * PW) / (N - 1) : PW / 2);
  const pyOf = (v: number)  => MT + PH - (v / maxPts) * PH;
  const mxi  = (mn: number) => matchNumbers.indexOf(mn);

  // Nice Y-axis step (targets ~5 lines)
  const _rawStep = maxPts / 5;
  const _mag     = Math.pow(10, Math.floor(Math.log10(_rawStep)));
  const _norm    = _rawStep / _mag;
  const yStep    = (_norm <= 1.5 ? 1 : _norm <= 3.5 ? 2 : _norm <= 7.5 ? 5 : 10) * _mag;
  const yLines   = [];
  for (let v = yStep; v < maxPts; v += yStep) yLines.push(v);

  // Label every k-th match so labels stay ≥ ~30px apart (more labels as you zoom in)
  const xSkip = Math.max(1, Math.ceil(30 / (N > 1 ? PW / (N - 1) : PW)));

  // Build full SVG path d for a squad
  const buildPath = (squadId: string): string => {
    const pts = series[squadId] || [];
    return pts.map((e, i) => {
      const x = pxOf(mxi(e.matchNumber));
      const y = pyOf(e.cumulative);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };

  // Build partial path up to fractional match index `frac`
  const buildPathUpTo = (squadId: string, frac: number): string => {
    const pts = series[squadId] || [];
    const segs: [number, number][] = [];
    for (let j = 0; j < pts.length; j++) {
      const xi = mxi(pts[j].matchNumber);
      if (xi <= frac) {
        segs.push([pxOf(xi), pyOf(pts[j].cumulative)]);
      } else {
        const prevXi = j > 0 ? mxi(pts[j - 1].matchNumber) : xi;
        const range  = xi - prevXi;
        if (range > 0 && frac > prevXi) {
          const f  = (frac - prevXi) / range;
          const x0 = j > 0 ? pxOf(prevXi) : pxOf(xi);
          const y0 = j > 0 ? pyOf(pts[j - 1].cumulative) : pyOf(0);
          segs.push([x0 + (pxOf(xi) - x0) * f, y0 + (pyOf(pts[j].cumulative) - y0) * f]);
        }
        break;
      }
    }
    return segs.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  };

  // Render order: others first, "you" on top
  const sortedSquads = useMemo(() =>
    [...squads].sort((a, b) =>
      mySquadIds.has(a.squadId) ? 1 : mySquadIds.has(b.squadId) ? -1 : 0
    ),
    [squads, mySquadIds],
  );

  // ── Trace animation (start / pause / resume / stop) ────────────────────────

  const clearTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const stopTrace = useCallback(() => {
    clearTimer();
    elapsedRef.current = 0;
    setPaused(false);
    setAnimFrac(null);
  }, []);

  const runTimer = useCallback(() => {
    clearTimer();
    const TOTAL_MS = N * CYCLE;
    lastTickRef.current = Date.now();

    timerRef.current = setInterval(() => {
      const now = Date.now();
      elapsedRef.current += now - lastTickRef.current;
      lastTickRef.current = now;
      const elapsed = elapsedRef.current;
      if (elapsed >= TOTAL_MS) {
        stopTrace(); // finished → back to static
        return;
      }
      const cycleN  = Math.floor(elapsed / CYCLE);
      const inCycle = elapsed % CYCLE;
      const frac    = cycleN + (1 - Math.pow(1 - Math.min(inCycle / STEP_MS, 1), 2));
      setAnimFrac(frac);
    }, 33);
  }, [N, stopTrace]);

  const startTrace = useCallback(() => {
    elapsedRef.current = 0;
    setPaused(false);
    setAnimFrac(0);
    runTimer();
  }, [runTimer]);

  const pauseTrace = useCallback(() => {
    clearTimer();
    setPaused(true);           // animFrac stays where it is → chart freezes
  }, []);

  const resumeTrace = useCallback(() => {
    setPaused(false);
    runTimer();
  }, [runTimer]);

  // Cleanup on unmount
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const isAnimating = animFrac !== null;

  if (!N || !squads.length) return null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View>
      {/* Cap selector + trace button */}
      <View style={s.capBar}>
        <View style={s.capBarLeft}>
          <Text style={s.capBarLabel}>Show</Text>
          <View style={s.capPills}>
            {CAP_OPTIONS.map(opt => (
              <Pressable
                key={opt.n}
                onPress={() => switchCap(opt.n)}
                style={[s.capPill, cap === opt.n && s.capPillActive]}
              >
                <Text style={[s.capPillText, cap === opt.n && s.capPillTextActive]}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={s.traceBtns}>
          {isAnimating && (
            <Pressable onPress={stopTrace} style={s.traceBtn}>
              <Text style={s.traceBtnText}>◼ Stop</Text>
            </Pressable>
          )}
          <Pressable
            onPress={!isAnimating ? startTrace : paused ? resumeTrace : pauseTrace}
            style={s.traceBtn}
          >
            <Text style={s.traceBtnText}>
              {!isAnimating ? '▶ Trace' : paused ? '▶ Resume' : '⏸ Pause'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* SVG chart */}
      {/* Zoom controls */}
      <View style={s.zoomRow}>
        <Text style={s.capBarLabel}>Zoom</Text>
        <Pressable onPress={() => setZoom(z => Math.max(1, z - 1))} style={[s.zoomBtn, zoom <= 1 && s.zoomBtnOff]}>
          <Text style={s.traceBtnText}>−</Text>
        </Pressable>
        <Text style={s.zoomVal}>{zoom}×</Text>
        <Pressable onPress={() => setZoom(z => Math.min(4, z + 1))} style={[s.zoomBtn, zoom >= 4 && s.zoomBtnOff]}>
          <Text style={s.traceBtnText}>+</Text>
        </Pressable>
        {zoom > 1 && <Text style={s.zoomHint}>swipe chart sideways</Text>}
      </View>

      {/* SVG chart (scrolls sideways when zoomed) */}
      <ScrollView
        horizontal
        nestedScrollEnabled
        scrollEnabled={zoom > 1}
        showsHorizontalScrollIndicator={zoom > 1}
      >
      <Svg width={W} height={H}>
        {/* Tap empty chart area to dismiss booster tooltip */}
        <Rect x={0} y={0} width={W} height={H} fill="#000" fillOpacity={0.001} onPress={() => setTipIdx(null)} />
        {/* Y grid lines */}
        {yLines.map(v => {
          const y = pyOf(v);
          return (
            <G key={v}>
              <Line x1={ML} x2={W - MR} y1={y} y2={y} stroke="rgba(0,0,0,0.08)" strokeWidth={1} />
              <SvgText x={ML - 4} y={y + 3} fontSize={7.5} fill="#aaa" textAnchor="end">{v}</SvgText>
            </G>
          );
        })}

        {/* Vertical guide at every match (labels are skipped on some, so these fill the gaps) */}
        {N > 1 && matchNumbers.map((mn, i) => (
          <Line
            key={`vg-${mn}`}
            x1={pxOf(i)} x2={pxOf(i)}
            y1={MT}      y2={MT + PH}
            stroke="rgba(0,0,0,0.06)" strokeWidth={0.8}
          />
        ))}

        {/* X baseline */}
        <Line x1={ML} x2={W - MR} y1={MT + PH} y2={MT + PH} stroke="rgba(201,168,76,0.3)" strokeWidth={1} />

        {/* X labels */}
        {matchNumbers.map((mn, i) => {
          if (i % xSkip !== 0 && i !== N - 1) return null;
          return (
            <SvgText key={mn} x={pxOf(i)} y={MT + PH + 14} fontSize={8} fill="#aaa" textAnchor="middle">
              M{mn}
            </SvgText>
          );
        })}

        {/* Team lines */}
        {sortedSquads.map(sq => {
          if (!visible.has(sq.squadId)) return null;
          const me    = mySquadIds.has(sq.squadId);
          const color = colorMap[sq.squadId];
          const d     = isAnimating
            ? buildPathUpTo(sq.squadId, animFrac!)
            : buildPath(sq.squadId);
          if (!d) return null;
          return (
            <G key={sq.squadId}>
              {me && (
                <Path
                  d={d}
                  fill="none"
                  stroke="rgba(201,168,76,0.12)"
                  strokeWidth={5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              <Path
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={me ? 2 : 1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={me ? 1 : 0.85}
              />
            </G>
          );
        })}

        {/* Booster markers — small solid dot on the line; tap for icon + details */}
        {boosters.map((b, idx) => {
          if (!visible.has(b.squadId)) return null;
          const ci  = mxi(b.matchNumber);
          if (ci < 0) return null;
          // During animation, only show if we've reached that match
          if (isAnimating && ci > animFrac!) return null;
          const cum = (series[b.squadId] || []).find(e => e.matchNumber === b.matchNumber)?.cumulative;
          if (cum == null) return null;
          const cx    = pxOf(ci);
          const cy    = pyOf(cum);
          const color = colorMap[b.squadId] || '#888';
          return (
            <G key={idx}>
              <Circle cx={cx} cy={cy} r={2.8} fill={color} stroke="white" strokeWidth={1} />
              {/* generous tap target — near-zero opacity (not 'transparent') so it's hit-testable on iOS/Android */}
              <Circle
                cx={cx} cy={cy} r={12}
                fill="#000" fillOpacity={0.01}
                onPress={() => setTipIdx(tipIdx === idx ? null : idx)}
              />
            </G>
          );
        })}

        {/* Booster tooltip for the tapped dot */}
        {(() => {
          if (tipIdx === null || isAnimating) return null;
          const b = boosters[tipIdx];
          if (!b || !visible.has(b.squadId)) return null;
          const ci  = mxi(b.matchNumber);
          const cum = (series[b.squadId] || []).find(e => e.matchNumber === b.matchNumber)?.cumulative;
          if (ci < 0 || cum == null) return null;
          const sqName = squads.find(q => q.squadId === b.squadId)?.squadName ?? '';
          const text   = `${b.booster} ${sqName.length > 14 ? sqName.slice(0, 13) + '…' : sqName} · M${b.matchNumber}`;
          const tw     = text.length * 5.2 + 12, th = 18;
          const tx     = Math.min(Math.max(pxOf(ci) - tw / 2, 2), W - tw - 2);
          const ty     = Math.max(pyOf(cum) - th - 8, 2);
          return (
            <G pointerEvents="none">
              <Rect x={tx} y={ty} width={tw} height={th} rx={5} fill="#1C1F26" />
              <SvgText x={tx + tw / 2} y={ty + 12} fontSize={9.5} fill="#fff" textAnchor="middle">{text}</SvgText>
            </G>
          );
        })()}

      </Svg>
      </ScrollView>

      {/* Legend */}
      <View style={s.legend}>
        {squadsByRank.map(sq => {
          const me       = mySquadIds.has(sq.squadId);
          const color    = colorMap[sq.squadId];
          const finalPts = (series[sq.squadId] || []).slice(-1)[0]?.cumulative ?? 0;
          const hidden   = !visible.has(sq.squadId);

          return (
            <Pressable
              key={sq.squadId}
              onPress={me ? undefined : () => toggleSquad(sq.squadId)}
              style={[s.legRow, hidden && s.legRowHidden, me && s.legRowYou]}
            >
              <View style={[s.legSwatch, { backgroundColor: color }, me && { shadowColor: color, shadowRadius: 3, shadowOpacity: 0.4, shadowOffset: { width: 0, height: 0 } }]} />
              <Text style={[s.legName, hidden && s.legTextHidden]} numberOfLines={1}>
                {sq.squadName}
                {me ? <Text style={s.youBadge}> YOU</Text> : null}
              </Text>
              <Text style={[s.legPts, hidden && s.legTextHidden]}>{finalPts} pts</Text>
              {!me && (
                <Text style={[s.legEye, hidden && s.legEyeHidden]}>
                  {hidden ? '○' : '●'}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // Cap bar
  capBar: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   spacing.sm,
  },
  capBarLeft: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
  },
  capBarLabel: {
    color:    C.muted,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  capPills: {
    flexDirection: 'row',
    gap:           4,
  },
  capPill: {
    paddingHorizontal: 9,
    paddingVertical:   3,
    borderRadius:      radius.full,
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.25)',
    backgroundColor:   'transparent',
  },
  capPillActive: {
    backgroundColor: 'rgba(201,168,76,0.12)',
    borderColor:     'rgba(201,168,76,0.45)',
  },
  capPillText: {
    color:      C.muted,
    fontSize:   10,
    fontWeight: '600',
  },
  capPillTextActive: {
    color: C.accent,
  },
  zoomRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           8,
    marginBottom:  spacing.xs,
  },
  zoomBtn: {
    width:           26,
    height:          22,
    alignItems:      'center',
    justifyContent:  'center',
    borderRadius:    radius.sm,
    borderWidth:     1,
    borderColor:     'rgba(201,168,76,0.35)',
    backgroundColor: 'rgba(201,168,76,0.08)',
  },
  zoomBtnOff: { opacity: 0.35 },
  zoomVal:    { color: C.text, fontSize: 11, fontWeight: '600', minWidth: 20, textAlign: 'center' },
  zoomHint:   { color: C.muted, fontSize: 9, marginLeft: 4 },
  traceBtns: {
    flexDirection: 'row',
    gap:           6,
  },
  traceBtn: {
    paddingHorizontal: 10,
    paddingVertical:   3,
    borderRadius:      radius.sm,
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.35)',
    backgroundColor:   'rgba(201,168,76,0.08)',
  },
  traceBtnText: {
    color:      C.accent,
    fontSize:   10,
    fontWeight: '600',
  },

  // Legend
  legend: {
    marginTop:         spacing.sm,
    paddingTop:        spacing.sm,
    borderTopWidth:    1,
    borderTopColor:    'rgba(201,168,76,0.2)',
    gap:               2,
  },
  legRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           8,
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
  },
  legRowHidden: {
    opacity: 0.35,
  },
  legRowYou: {
    // no extra style — just blocks the press handler
  },
  legSwatch: {
    width:        20,
    height:       3,
    borderRadius: 2,
    flexShrink:   0,
  },
  legName: {
    flex:       1,
    color:      C.text,
    fontSize:   fontSize.xs,
    fontWeight: '500',
  },
  legTextHidden: {
    // handled by parent opacity
  },
  legPts: {
    color:      C.muted,
    fontSize:   fontSize.xs,
    minWidth:   44,
    textAlign:  'right',
  },
  legEye: {
    color:    C.accent,
    fontSize: 10,
    width:    14,
    textAlign: 'center',
  },
  legEyeHidden: {
    color: C.muted,
  },
  youBadge: {
    fontSize:   8,
    fontWeight: '800',
    color:      C.accent,
  },
});
