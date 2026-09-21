/**
 * TeamStatsPlayerSheet — match-by-match log for one player within the
 * Leaderboard's Team Stats tab. Visually and structurally mirrors
 * PlayerStatsModal (same bottom-sheet Modal pattern, same Match/
 * Performance/Pts table shape and hairline-row styling) per the plan
 * decision to keep this drilldown consistent with how player detail
 * already opens elsewhere in the app — including the batting/bowling/
 * fielding breakdown per appearance, which the reviewed prototype's
 * drilldown always showed (formatted with the same
 * formatBattingLine/formatBowlingLine/formatFieldingLine PlayerStatsModal
 * uses) — but it renders data it's handed (one TeamStatsPlayer's `log`,
 * already fetched by getSquadTeamStats, batting/bowling/fielding included)
 * rather than running its own query, since the whole Team Stats
 * leaderboard is fetched once up front.
 */

import React from 'react';
import {
  Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import { fontSize, radius, spacing } from '../theme';
import { TeamStatsPlayer } from '../lib/teamStats';
import { getBoosterMeta } from '../store/boosterStore';
import {
  formatBattingLine, formatBowlingLine, formatFieldingLine,
} from '../lib/playerHistory';

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  accent: '#C9A84C',
  gold:   '#92650A',
  border: 'rgba(201,168,76,0.22)',
  boostBg: '#FBEFC9',
  boostBorder: '#E9D28F',
  boostText: '#8A5A00',
} as const;

interface Props {
  visible: boolean;
  player:  TeamStatsPlayer | null;
  onClose: () => void;
}

// Temporary, visible build marker — bump this string with every fix to
// this file so a screenshot can confirm at a glance whether a given EAS
// Update actually reached the device, instead of guessing from behavior
// alone. Safe to delete once the scroll issue is confirmed fixed.
const BUILD_MARKER = 'build: ts-fix-7';

export default function TeamStatsPlayerSheet({ visible, player, onClose }: Props) {
  const log = player ? [...player.log].sort((a, b) => (b.matchNumber ?? 0) - (a.matchNumber ?? 0)) : [];

  // A definite pixel height for the ScrollView, computed from the actual
  // window size, rather than flex:1 (ambiguous — Yoga has no definite main
  // size to grow against inside a shrink-to-fit, maxHeight-only sheet, and
  // was collapsing the list to zero height) or a hardcoded pixel maxHeight
  // (didn't account for the header/subtitle actually rendered, or for
  // screen size — could exceed the room really left in the sheet's 80% cap
  // and make the list unscrollable). hasSubtitle tracks whether the
  // Captain/VC line below the header is present, since it takes real space.
  const { height: winH } = useWindowDimensions();
  const hasSubtitle = !!player && (player.timesCaptain > 0 || player.timesVc > 0);
  const chromeReserve = hasSubtitle ? 180 : 150; // header + padding (+ subtitle line)
  const scrollMaxHeight = Math.max(220, Math.round(winH * 0.8) - chromeReserve);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        {/* Backdrop-only dismiss layer, absolutely positioned behind the
            sheet rather than wrapping it. The previous version wrapped the
            whole sheet — including the ScrollView — in a Pressable just to
            swallow taps so they wouldn't bubble up and close the modal; on
            Android that outer Pressable was winning the touch-responder
            negotiation before the ScrollView could recognize a vertical
            drag, so the list rendered but never scrolled. A plain View for
            the sheet (rendered on top of this layer, so it naturally
            intercepts touches over its own bounds) removes that
            competition entirely. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {player?.name ?? ''} — Match log
            </Text>
            <Text style={styles.buildMarker}>{BUILD_MARKER}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </View>

          {player && (player.timesCaptain > 0 || player.timesVc > 0) && (
            <Text style={styles.subtitle}>
              {player.timesCaptain > 0 ? `Captain ×${player.timesCaptain}` : ''}
              {player.timesCaptain > 0 && player.timesVc > 0 ? ' · ' : ''}
              {player.timesVc > 0 ? `Vice-Captain ×${player.timesVc}` : ''}
            </Text>
          )}

          {log.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>No match log yet for this player.</Text>
            </View>
          ) : (
            <ScrollView style={[styles.scroll, { maxHeight: scrollMaxHeight }]} showsVerticalScrollIndicator={false}>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.th, styles.colMatch]}>Match</Text>
                <Text style={[styles.th, styles.colPerf]}>Performance</Text>
                <Text style={[styles.th, styles.colPts]}>Pts</Text>
              </View>
              {log.map(m => {
                const roleTag   = m.isCaptain ? ' (C)' : (m.isVc ? ' (VC)' : '');
                const boostMeta = m.booster ? getBoosterMeta(m.booster) : undefined;

                const lines = [
                  formatBattingLine(m.batting ?? null),
                  formatBowlingLine(m.bowling ?? null),
                  formatFieldingLine(m.fielding ?? null),
                ].filter(Boolean);
                // formatBattingLine always returns something ("Did not bat"
                // when there's no batting row), so `lines` is only ever
                // empty when this player has no batting/bowling/fielding
                // row at all for the match (a genuine DNP) — same convention
                // PlayerStatsModal uses for r.played === false.
                const perf = lines.length ? lines.join('\n') : 'Did not contribute';

                return (
                  <View key={m.matchId} style={styles.row}>
                    <View style={styles.colMatch}>
                      <Text style={styles.cellPrimary}>M{m.matchNumber ?? '?'}{roleTag}</Text>
                    </View>
                    <Text style={[styles.cellPrimary, styles.colPerf]}>{perf}</Text>
                    <View style={styles.colPts}>
                      <Text style={styles.cellPts}>{m.totalPoints}</Text>
                      <Text style={styles.cellMult}>{m.basePoints ?? 0} ×{m.multiplier}</Text>
                      {boostMeta && (
                        <View style={styles.boostTag}>
                          <Text style={styles.boostTagText}>{boostMeta.icon} {boostMeta.name}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent:  'flex-end',
  },
  sheet: {
    backgroundColor:      '#FFFFFF',
    borderTopLeftRadius:  radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal:    spacing.lg,
    paddingTop:           spacing.lg,
    paddingBottom:        spacing.xl,
    maxHeight:            '80%',
  },
  header: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   spacing.xs,
  },
  title: {
    color:      C.text,
    fontSize:   fontSize.base,
    fontWeight: '700',
    flex:       1,
    marginRight: spacing.sm,
  },
  closeText: { color: C.muted, fontSize: fontSize.lg },
  buildMarker: { color: '#C9A84C', fontSize: 9, marginRight: spacing.sm },
  subtitle:  { color: C.muted, fontSize: fontSize.xs, fontWeight: '600', marginBottom: spacing.md },

  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
  emptyText: { color: C.muted, fontSize: fontSize.sm, textAlign: 'center' },

  // Base style only — the actual maxHeight is computed per-render from
  // the window size (see scrollMaxHeight above) and merged in via the
  // style array on the ScrollView.
  scroll: {},

  tableHeaderRow: {
    flexDirection:     'row',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingBottom:     spacing.xs,
    marginBottom:      spacing.xs,
  },
  th: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  colMatch: { flex: 1 },
  colPerf:  { flex: 1.5 },
  // Widened from 62 — 4-figure point totals (e.g. "1,112") plus the
  // "<base> x<mult>" line beneath were getting clipped against the right
  // edge in this column at 62.
  colPts:   { width: 74, alignItems: 'flex-end' },

  row: {
    flexDirection:     'row',
    paddingVertical:   spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.12)',
  },
  cellPrimary: { color: C.text, fontSize: fontSize.sm, lineHeight: 17, fontWeight: '600' },
  cellMuted:   { color: C.muted, fontSize: fontSize.xs, marginTop: 1 },
  cellPts:     { color: C.text, fontSize: fontSize.sm, fontWeight: '700', textAlign: 'right' },
  cellMult:    { color: C.muted, fontSize: fontSize.xs, marginTop: 1, textAlign: 'right' },

  boostTag: {
    alignSelf:          'flex-end',
    marginTop:          3,
    backgroundColor:    C.boostBg,
    borderWidth:        1,
    borderColor:        C.boostBorder,
    borderRadius:       radius.sm,
    paddingHorizontal:  6,
    paddingVertical:    2,
  },
  boostTagText: { color: C.boostText, fontSize: 9, fontWeight: '700' },
});
