/**
 * PlayerBreakdownPanel — itemized points breakup for ONE player, shown when
 * they're tapped in either half of TeamDetailModal's Overview/Detail toggle
 * (a pitch tile in TeamPitchBreakdown, or a row in the Detail list back in
 * LeaderboardScreen.tsx). Mirrors web's histBreakdownRowHtml/hist-bd-detail
 * format exactly — same line labels and order (Runs/Fours/Sixes + batting
 * bonuses, Wickets + bowling bonuses, Catches/run-outs), a bold "Raw total"
 * line, and a "×N (Captain/Vice-Captain/Booster)" line — just single-player
 * and tap-triggered here instead of web's always-visible per-player
 * accordion list (mobile doesn't have the side-by-side room for that).
 *
 * Deliberately renders as a plain block the CALLER appends after its own
 * content (the pitch oval + total-points bar, or the row list + footer) —
 * it never overlays or resizes anything above it, it only ever fills the
 * space below. See TeamPitchBreakdown.tsx and LeaderboardScreen.tsx for the
 * two call sites and their own tap-state/selection handling.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Jersey from './Jersey';
import { MatchPlayer } from '../lib/seasonHistory';
import { PlayerRole } from '../types';
import { useTeamStore } from '../store/teamStore';

const ROLE_LABEL: Record<PlayerRole, string> = { wk: 'WK', bat: 'BAT', ar: 'AR', bowl: 'BOWL' };

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

export default function PlayerBreakdownPanel({ player, onClose }: { player: MatchPlayer; onClose: () => void }) {
  const isCap = player.captaincy === 'captain';
  const isVC  = player.captaincy === 'vice_captain';

  // Same best-effort cosmetic lookup TeamPitchBreakdown's PitchToken uses —
  // MatchPlayer itself carries no team color/jersey art, only name/team.
  const pool = useTeamStore(s => s.players);
  const poolMatch = pool.find(p => p.name === player.name && p.team === player.team)
                 ?? pool.find(p => p.name === player.name);

  // Raw total is bat+bowl+field+bonus — the SAME pre-multiplier sum the
  // pitch tile's points-tag and the Detail row's PTS column already use, so
  // this can never show a different number than either of them.
  const raw      = player.bat + player.bowl + player.field + player.bonus;
  const finalPts = Math.round(raw * player.multiplier * 10) / 10;

  const multLabel = player.multiplier === 1 ? null
    : isCap ? `×${player.multiplier} (Captain)`
    : isVC  ? `×${player.multiplier} (Vice-Captain)`
    : `×${player.multiplier} (Booster)`;

  return (
    <View style={styles.panel}>
      <View style={styles.summary}>
        <View style={styles.avatar}>
          <Jersey
            code={player.team}
            color1={poolMatch?.teamColor}
            color2={poolMatch?.teamColor2}
            jerseySvg={poolMatch?.teamJerseySvg}
            photoUrl={poolMatch?.photoUrl}
            size={28}
            variant="pitch"
            boosted={false}
          />
        </View>

        <View style={styles.nameWrap}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>{player.name}</Text>
            {(isCap || isVC) && (
              <View style={[styles.badge, isCap ? styles.badgeC : styles.badgeVC]}>
                <Text style={[styles.badgeText, isCap ? styles.badgeTextC : styles.badgeTextVC]}>
                  {isCap ? 'C' : 'VC'}
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {ROLE_LABEL[player.role]}{player.statLine ? ` · ${player.statLine}` : ''}
          </Text>
        </View>

        <Text style={styles.pts}>{fmt(finalPts)}</Text>

        <Pressable style={styles.close} onPress={onClose} hitSlop={8}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.lines}>
        {player.breakdown.length > 0 ? (
          player.breakdown.map((l, i) => (
            <View key={i} style={styles.line}>
              <Text style={styles.lineLabel}>{l.label}</Text>
              <Text style={styles.lineValue}>{l.value >= 0 ? '+' : ''}{fmt(l.value)}</Text>
            </View>
          ))
        ) : (
          <View style={styles.line}>
            <Text style={styles.lineLabel}>No stats recorded</Text>
            <Text style={styles.lineValue}>—</Text>
          </View>
        )}

        <View style={[styles.line, styles.lineTotal]}>
          <Text style={styles.lineTotalText}>Raw total</Text>
          <Text style={styles.lineTotalText}>{fmt(raw)}</Text>
        </View>

        {multLabel && (
          <View style={[styles.line, styles.lineMult]}>
            <Text style={styles.lineMultText}>{multLabel}</Text>
            <Text style={styles.lineMultText}>{fmt(finalPts)}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(28,31,38,0.08)',
  },

  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 10,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.08)',
  },
  avatar: { width: 28 },
  nameWrap: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  name: { fontSize: 13, fontWeight: '700', color: '#1C1F26', flexShrink: 1 },
  meta: { fontSize: 11, color: '#7A7060', marginTop: 1 },
  badge: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  badgeC:  { backgroundColor: 'rgba(201,168,76,0.15)' },
  badgeVC: { backgroundColor: 'rgba(28,31,38,0.06)' },
  badgeText: { fontSize: 10, fontWeight: '800' },
  badgeTextC:  { color: '#C9A84C' },
  badgeTextVC: { color: '#7a5500' },
  pts: { fontSize: 15, fontWeight: '800', color: '#C9A84C', flexShrink: 0 },
  close: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(28,31,38,0.06)',
  },
  closeText: { fontSize: 12, color: '#7A7060' },

  lines: {},
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 2,
  },
  lineLabel: { fontSize: 12, color: '#7A7060', flexShrink: 1 },
  lineValue: { fontSize: 12, color: '#7A7060' },
  lineTotal: {
    marginTop: 5,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(28,31,38,0.1)',
  },
  lineTotalText: { fontSize: 12, fontWeight: '700', color: '#1C1F26' },
  lineMult: {},
  lineMultText: { fontSize: 12, fontWeight: '700', color: '#C9A84C' },
});
