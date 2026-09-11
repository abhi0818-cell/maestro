/**
 * MyLiveTeamModal — shows the CURRENT USER's own fantasy team(s) with live
 * per-player points for the currently-live match. Replaces LiveScorecardModal
 * (which showed the raw CricAPI scorecard) per the actual feature intent:
 * mirror web's renderDailyLiveTab()/renderSlLiveTab(), not a generic
 * scorecard viewer.
 *
 * Reuses the same data pipelines and row-rendering already built for
 * history/leaderboard drill-downs (getDailyUserHistory / getSquadSeasonHistory
 * + TeamPointsBreakdown) rather than re-deriving live points from scratch —
 * both already compute the exact bat/bowl/field/bonus + multiplier breakdown
 * per match, they just needed the live match's status ('live') to be included,
 * which isMatchPlayed() now is (see matchLock.ts).
 *
 * Shows whichever of Daily / SL applies for this user — both if they have
 * teams in both contest types for the live match, one if only one applies,
 * or an empty state if neither.
 *
 * Each section gets the same Overview/Detail toggle as LeaderboardScreen's
 * TeamDetailModal: Overview (TeamPitchBreakdown — pitch layout, tap a player
 * for their points breakup) is the default, Detail (TeamPointsBreakdown's
 * BAT/BWL/FLD/BON row list, itself now tap-to-expand) is one tap away. One
 * toggle per section — keyed by section.key — so Daily and Season Squad can
 * be in different view modes when both are shown for the same live match.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fontSize, radius, spacing } from '../theme';
import { getDailyUserHistory } from '../lib/dailyLeaderboard';
import { getSquadSeasonHistory, MatchTeam, MatchWeek } from '../lib/seasonHistory';
import TeamPointsBreakdown from './TeamPointsBreakdown';
import TeamPitchBreakdown from './TeamPitchBreakdown';

const G = {
  bg:    ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  modal: ['rgba(245,240,224,0.99)', 'rgba(237,232,213,0.99)'] as const,
};

const C = {
  text:   '#1C1F26',
  muted:  '#7A7060',
  accent: '#C9A84C',
  live:   '#C0392B',
  border: 'rgba(201,168,76,0.25)',
};

interface Props {
  visible:         boolean;
  matchId:         string | null;
  title?:          string;
  dailyContestId?: string | null;
  squadId?:        string | null;
  userId?:         string | null;
  onClose:         () => void;
}

type Section = { key: string; label: string; team: MatchTeam; mw: MatchWeek };

export default function MyLiveTeamModal({
  visible, matchId, title, dailyContestId, squadId, userId, onClose,
}: Props) {
  const [sections, setSections] = useState<Section[]>([]);
  const [loading,  setLoading]  = useState(false);
  // Overview/Detail toggle, one entry per section (keyed by section.key) so
  // Daily and Season Squad can independently be pitch or row view. Overview
  // is the default, same as LeaderboardScreen's TeamDetailModal.
  const [teamView, setTeamView] = useState<Record<string, 'pitch' | 'rows'>>({});
  const viewFor = (key: string) => teamView[key] ?? 'pitch';

  useEffect(() => {
    if (!visible || !matchId) { setSections([]); return; }
    let cancelled = false;
    setLoading(true);

    const fetchDaily = (dailyContestId && userId)
      ? getDailyUserHistory(dailyContestId, userId)
      : Promise.resolve({ matchWeeks: [] as MatchWeek[], history: [] as MatchTeam[] });
    const fetchSl = squadId
      ? getSquadSeasonHistory(squadId)
      : Promise.resolve({ matchWeeks: [] as MatchWeek[], history: [] as MatchTeam[] });

    Promise.all([fetchDaily, fetchSl])
      .then(([daily, sl]) => {
        if (cancelled) return;
        const out: Section[] = [];
        const dailyTeam = daily.history.find(t => t.mwId === matchId);
        const dailyMw   = daily.matchWeeks.find(w => w.id === matchId);
        if (dailyTeam && dailyMw) out.push({ key: 'daily', label: 'Daily Contest', team: dailyTeam, mw: dailyMw });
        const slTeam = sl.history.find(t => t.mwId === matchId);
        const slMw   = sl.matchWeeks.find(w => w.id === matchId);
        if (slTeam && slMw) out.push({ key: 'sl', label: 'Season Squad', team: slTeam, mw: slMw });
        setSections(out);
      })
      .catch(err => {
        console.warn('[MyLiveTeamModal] fetch failed:', err);
        if (!cancelled) setSections([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [visible, matchId, dailyContestId, squadId, userId]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>

          <LinearGradient colors={G.modal} style={styles.header}>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              <View style={styles.liveRow}>
                <View style={styles.liveDot} />
                <Text style={styles.liveLabel}>LIVE · MY TEAM</Text>
              </View>
              <Text style={styles.headerTitle} numberOfLines={1}>{title ?? 'Live match'}</Text>
            </View>
          </LinearGradient>

          {loading ? (
            <View style={styles.center}><ActivityIndicator size="large" color={C.accent} /></View>
          ) : sections.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.emptyText}>You don't have a saved team for this match.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
              {sections.map(s => {
                const view = viewFor(s.key);
                return (
                  <View key={s.key} style={styles.section}>
                    <View style={styles.sectionHeaderRow}>
                      <Text style={styles.sectionLabel}>{s.label}</Text>
                      <Text style={styles.sectionPts}>{s.team.pts} pts</Text>
                    </View>

                    <View style={styles.teamViewToggleRow}>
                      <Text style={styles.teamViewToggleLabel}>View as</Text>
                      <View style={styles.teamViewSeg}>
                        <Pressable
                          style={[styles.teamViewSegBtn, view === 'pitch' && styles.teamViewSegBtnOn]}
                          onPress={() => setTeamView(prev => ({ ...prev, [s.key]: 'pitch' }))}
                        >
                          <Text style={[styles.teamViewSegText, view === 'pitch' && styles.teamViewSegTextOn]}>Overview</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.teamViewSegBtn, view === 'rows' && styles.teamViewSegBtnOn]}
                          onPress={() => setTeamView(prev => ({ ...prev, [s.key]: 'rows' }))}
                        >
                          <Text style={[styles.teamViewSegText, view === 'rows' && styles.teamViewSegTextOn]}>Detail</Text>
                        </Pressable>
                      </View>
                    </View>

                    {view === 'pitch' ? (
                      <TeamPitchBreakdown team={s.team} />
                    ) : (
                      <View style={styles.sectionPanel}>
                        <TeamPointsBreakdown team={s.team} footerLabel={`${s.mw.label} · ${s.mw.match} · Team Total`} />
                      </View>
                    )}
                  </View>
                );
              })}
            </ScrollView>
          )}

        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F5F0E0' },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  closeBtn: {
    width: 34, height: 34, borderRadius: radius.md,
    backgroundColor: 'rgba(0,0,0,0.05)', borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  closeBtnText: { color: C.text, fontSize: fontSize.base, fontWeight: '700' },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.live },
  liveLabel: { color: C.live, fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 0.6 },
  headerTitle: { color: C.text, fontSize: fontSize.base, fontWeight: '800', marginTop: 2 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: C.muted, fontSize: fontSize.base, textAlign: 'center' },

  body: { paddingBottom: spacing.xxl, gap: spacing.lg },

  section: { marginTop: spacing.lg },
  sectionHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, marginBottom: spacing.sm,
  },
  sectionLabel: {
    color: C.text, fontSize: fontSize.base, fontWeight: '800',
  },
  sectionPts: { color: C.text, fontSize: fontSize.base, fontWeight: '800' },
  sectionPanel: {
    borderTopWidth: 1, borderTopColor: C.border,
    borderBottomWidth: 1, borderBottomColor: C.border,
    backgroundColor: 'rgba(255,255,255,0.4)',
  },

  // Overview / Detail toggle — mirrors LeaderboardScreen's TeamDetailModal.
  teamViewToggleRow: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical:   7,
    marginBottom:      spacing.sm,
    backgroundColor:   'rgba(0,0,0,0.03)',
    borderTopWidth:    1,
    borderTopColor:    C.border,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  teamViewToggleLabel: {
    color:         C.muted,
    fontSize:      10,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  teamViewSeg: {
    flexDirection:   'row',
    backgroundColor: 'rgba(28,31,38,0.06)',
    borderRadius:    radius.full,
    padding:         2,
    gap:             2,
  },
  teamViewSegBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical:   5,
    borderRadius:      radius.full,
  },
  teamViewSegBtnOn: {
    backgroundColor: '#ffffff',
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 1 },
    shadowOpacity:   0.15,
    shadowRadius:    3,
    elevation:       1,
  },
  teamViewSegText: {
    color:      C.muted,
    fontSize:   fontSize.xs,
    fontWeight: '700',
  },
  teamViewSegTextOn: {
    color: C.text,
  },
});
