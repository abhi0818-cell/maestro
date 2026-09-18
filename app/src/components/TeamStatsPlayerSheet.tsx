/**
 * TeamStatsPlayerSheet — match-by-match log for one player within the
 * Leaderboard's Team Stats tab. Visually and structurally mirrors
 * PlayerStatsModal (same bottom-sheet Modal pattern, same header/table/
 * hairline-row styling) per the plan decision to keep this drilldown
 * consistent with how player detail already opens elsewhere in the app —
 * but it renders data it's handed (one TeamStatsPlayer's `log`, already
 * fetched by getSquadTeamStats) rather than running its own query, since
 * the whole Team Stats leaderboard is fetched once up front.
 */

import React from 'react';
import {
  Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { fontSize, radius, spacing } from '../theme';
import { TeamStatsPlayer } from '../lib/teamStats';
import { getBoosterMeta } from '../store/boosterStore';

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

export default function TeamStatsPlayerSheet({ visible, player, onClose }: Props) {
  const log = player ? [...player.log].sort((a, b) => (b.matchNumber ?? 0) - (a.matchNumber ?? 0)) : [];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {player?.name ?? ''} — Match log
            </Text>
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
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
              <View style={styles.tableHeaderRow}>
                <Text style={[styles.th, styles.colMatch]}>Match</Text>
                <Text style={[styles.th, styles.colBoost]}>Booster</Text>
                <Text style={[styles.th, styles.colPts]}>Pts</Text>
              </View>
              {log.map(m => {
                const roleTag  = m.isCaptain ? ' (C)' : (m.isVc ? ' (VC)' : '');
                const boostMeta = m.booster ? getBoosterMeta(m.booster) : undefined;
                return (
                  <View key={m.matchId} style={styles.row}>
                    <View style={styles.colMatch}>
                      <Text style={styles.cellPrimary}>M{m.matchNumber ?? '?'}{roleTag}</Text>
                      <Text style={styles.cellMuted}>×{m.multiplier}</Text>
                    </View>
                    <View style={styles.colBoost}>
                      {boostMeta ? (
                        <View style={styles.boostTag}>
                          <Text style={styles.boostTagText}>{boostMeta.icon} {boostMeta.fullName}</Text>
                        </View>
                      ) : (
                        <Text style={styles.cellMuted}>—</Text>
                      )}
                    </View>
                    <Text style={[styles.cellPts, styles.colPts]}>{m.totalPoints}</Text>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
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
  subtitle:  { color: C.muted, fontSize: fontSize.xs, fontWeight: '600', marginBottom: spacing.md },

  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
  emptyText: { color: C.muted, fontSize: fontSize.sm, textAlign: 'center' },

  scroll: { maxHeight: 380 },

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
  colBoost: { flex: 1.4, justifyContent: 'center' },
  colPts:   { width: 40, textAlign: 'right' },

  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingVertical:   spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(201,168,76,0.12)',
  },
  cellPrimary: { color: C.text, fontSize: fontSize.sm, lineHeight: 17, fontWeight: '600' },
  cellMuted:   { color: C.muted, fontSize: fontSize.xs, marginTop: 1 },
  cellPts:     { color: C.text, fontSize: fontSize.sm, fontWeight: '700' },

  boostTag: {
    alignSelf:          'flex-start',
    backgroundColor:    C.boostBg,
    borderWidth:        1,
    borderColor:        C.boostBorder,
    borderRadius:       radius.sm,
    paddingHorizontal:  6,
    paddingVertical:    2,
  },
  boostTagText: { color: C.boostText, fontSize: 9, fontWeight: '700' },
});
