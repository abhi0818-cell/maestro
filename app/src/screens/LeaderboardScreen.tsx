/**
 * LeaderboardScreen — gradient-first redesign (Pass 1)
 * Rankings by contest. Tap any row to see that player's team for each
 * matchweek, per-player points breakdown (bat / bowl / field / bonus)
 * with C / VC multipliers, and any boosters applied that week.
 * Requires: expo-linear-gradient  →  npx expo install expo-linear-gradient
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import BoosterIcon from '../components/BoosterIcon';
import TeamPitchBreakdown from '../components/TeamPitchBreakdown';
import PlayerBreakdownPanel from '../components/PlayerBreakdownPanel';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { PlayerRole, CaptaincyRole, RootTabParamList } from '../types';
import { fontSize, radius, spacing, shadow } from '../theme';
import { useContestStore } from '../store/contestStore';
import { useLeaderboardStore, LBEntry } from '../store/leaderboardStore';
import { useAuthStore } from '../store/authStore';
import { useTournamentStore } from '../store/tournamentStore';
import { getSquadSeasonHistory, MatchWeek, MatchPlayer, MatchTeam } from '../lib/seasonHistory';
import { TRANSFER_BOOSTERS } from '../store/boosterStore';
import {
  getDailyMatchOptions, loadDailyLeaderboard, getDailyUserHistory,
  DailyMatchOption,
} from '../lib/dailyLeaderboard';
import { useLiveMatch } from '../lib/liveScore';
import { getLeaderboardHistory, LeaderboardHistory } from '../lib/leaderboardHistory';
import { LeaderboardProgressChart } from '../components/LeaderboardProgressChart';

// ─── Domain types ─────────────────────────────────────────────────────────────

type ContestTab = {
  id: string; label: string; icon: string; type: 'daily' | 'sl' | 'private';
};

// Re-alias so existing code doesn't need changes
type LeaderboardEntry = LBEntry;

// ─── Gradient palette ─────────────────────────────────────────────────────────

const G = {
  bg:       ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  header:   ['rgba(245,240,224,0.98)', 'rgba(237,232,213,0.95)'] as const,
  tabOn:    ['#1C1F26', '#2A2E38'] as const,
  highlight:['rgba(201,168,76,0.12)', 'rgba(245,240,224,0.9)'] as const,
  rowMe:    ['rgba(201,168,76,0.1)', 'rgba(245,240,224,0.85)'] as const,
  // Podium
  gold:     ['rgba(201,168,76,0.3)', 'rgba(146,101,10,0.12)'] as const,
  silver:   ['rgba(122,112,96,0.2)', 'rgba(90,80,70,0.08)'] as const,
  bronze:   ['rgba(168,90,30,0.2)', 'rgba(130,60,15,0.08)'] as const,
  // Modal
  modal:    ['rgba(245,240,224,0.99)', 'rgba(237,232,213,0.99)'] as const,
  mwTabOn:  ['rgba(201,168,76,0.2)', 'rgba(245,240,224,0.7)'] as const,
  mwFooter: ['rgba(201,168,76,0.1)', 'rgba(245,240,224,0.85)'] as const,
} as const;

const C = {
  text:    '#1C1F26',
  muted:   '#7A7060',
  accent:  '#C9A84C',
  gold:    '#92650A',
  silver:  '#5A6070',
  good:    '#2D6A35',
  bad:     '#C0392B',
  border:  'rgba(201,168,76,0.25)',
  borderA: 'rgba(201,168,76,0.5)',
} as const;

// ─── Role constants ───────────────────────────────────────────────────────────

const ROLE_COLOR: Record<PlayerRole, string> = {
  wk: '#C9A84C', bat: '#1A2744', ar: '#2D6A35', bowl: '#7A3012',
};
const ROLE_LABEL: Record<PlayerRole, string> = {
  wk: 'WK', bat: 'BAT', ar: 'AR', bowl: 'BOWL',
};
// Display order for the player list — WK, Bat, AR, Bowl — independent of
// whatever order the XI rows come back from the DB in.
const ROLE_ORDER: Record<PlayerRole, number> = { wk: 0, bat: 1, ar: 2, bowl: 3 };

// ─── Point helpers ────────────────────────────────────────────────────────────

function capMult(p: MatchPlayer): number {
  // Real, booster-aware multiplier from the scores view (handles triple
  // captain / team double / etc., not just plain captain/VC).
  if (p.multiplier != null) return p.multiplier;
  return p.captaincy === 'captain' ? 2 : p.captaincy === 'vice_captain' ? 1.5 : 1;
}
function rawPts(p: MatchPlayer): number {
  return p.bat + p.bowl + p.field + p.bonus;
}
// 1-decimal precision — matches the footer total's rounding (seasonHistory.ts's
// `Math.round(net * 10) / 10`), so the rows visibly sum to the total instead
// of each independently rounding to a whole number first.
function finalPts(p: MatchPlayer): number {
  return Math.round(rawPts(p) * capMult(p) * 10) / 10;
}

function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

function podiumGrad(rank: number) {
  if (rank === 1) return G.gold;
  if (rank === 2) return G.silver;
  if (rank === 3) return G.bronze;
  return null;
}

// buildTabs is now driven by real contests — see LeaderboardScreen below
function buildFallbackTabs(): ContestTab[] {
  return [
    { id: 'daily', label: 'Daily',       icon: '📅', type: 'daily' },
    { id: 'sl',    label: 'Season Long', icon: '🏅', type: 'sl'    },
  ];
}

const CONTEST_ICONS_LB: Record<string, string> = {
  daily: '📅', sl: '🏅', private: '🔒',
};

// ─── Team Detail Modal ────────────────────────────────────────────────────────

interface TeamDetailModalProps {
  entry:        LeaderboardEntry | null;
  onClose:      () => void;
  contestId:    string;                          // needed for Daily's user-history lookup
  contestType:  'daily' | 'sl' | 'private';
  initialMwId?: string;                           // Daily: default to the match tapped from, not "latest"
}

function TeamDetailModal({ entry, onClose, contestId, contestType, initialMwId }: TeamDetailModalProps) {
  const [matchWeeks, setMatchWeeks] = useState<MatchWeek[]>([]);
  const [history, setHistory]       = useState<MatchTeam[]>([]);
  const [loadingHist, setLoadingHist] = useState(false);
  const [mwId, setMwId]             = useState<string>('');
  // Overview (pitch) is the default team-detail view; Detail (the full
  // BAT/BWL/FLD/BON row list) is one tap away, not gone.
  const [teamView, setTeamView]     = useState<'pitch' | 'rows'>('pitch');
  // Which row's points breakup (PlayerBreakdownPanel) is open in the Detail
  // view, if any — mirrors the selection TeamPitchBreakdown keeps for its
  // own pitch tiles, just for the row list instead. Reset below whenever
  // the matchweek changes, so it can't silently point at the wrong XI.
  const [rowsSelectedIdx, setRowsSelectedIdx] = useState<number | null>(null);
  // Tabs run oldest → newest left-to-right; scroll to the end by default so
  // the active (most recent) tab is visible without an extra manual swipe.
  const mwScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    setRowsSelectedIdx(null);
  }, [mwId]);

  useEffect(() => {
    if (!entry) {
      setMatchWeeks([]);
      setHistory([]);
      setMwId('');
      return;
    }
    // Daily has no persistent squad — pull this user's full pick history
    // across every match instead (mirrors web's getMatchHistoryDetailed).
    // SL/private keep the squad/season model.
    const fetchHistory = contestType === 'daily'
      ? getDailyUserHistory(contestId, entry.userId)
      : getSquadSeasonHistory(entry.squadId);

    setLoadingHist(true);
    fetchHistory
      .then(({ matchWeeks: mws, history: hist }) => {
        setMatchWeeks(mws);
        setHistory(hist);
        const fallback = mws[mws.length - 1]?.id ?? '';
        setMwId(initialMwId && mws.some(w => w.id === initialMwId) ? initialMwId : fallback);
      })
      .catch(err => {
        console.warn('[LeaderboardScreen] history fetch failed:', err);
        setMatchWeeks([]);
        setHistory([]);
      })
      .finally(() => setLoadingHist(false));
  }, [entry?.userId, entry?.squadId, contestId, contestType]);

  if (!entry) return null;

  const team = history.find(t => t.mwId === mwId);
  const mw   = matchWeeks.find(m => m.id === mwId);
  // Sorted once and reused by both the row list below and the breakup panel
  // lookup, so `rowsSelectedIdx` (an index into this array) always resolves
  // to the same player in both places.
  const sortedPlayers = team ? [...team.players].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) : [];

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />

        <SafeAreaView style={styles.modalSafe} edges={['top', 'bottom']}>

          {/* ── Header ── */}
          <LinearGradient colors={G.modal} style={styles.modalHeader}>
            <Pressable style={styles.modalClose} onPress={onClose}>
              <Text style={styles.modalCloseText}>✕</Text>
            </Pressable>
            <View style={styles.modalMeta}>
              <Text style={styles.modalName} numberOfLines={1}>{entry.teamName}</Text>
              <Text style={styles.modalTeamName} numberOfLines={1}>{entry.displayName}</Text>
            </View>
            <View style={styles.modalTotalBox}>
              <Text style={styles.modalTotalPts}>{entry.points.toLocaleString()}</Text>
              <Text style={styles.modalTotalSub}>{contestType === 'daily' ? 'match pts' : 'total pts'}</Text>
            </View>
          </LinearGradient>

          {/* ── Matchweek tabs ── */}
          <ScrollView
            ref={mwScrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.mwTabsScroll}
            contentContainerStyle={styles.mwTabs}
            onContentSizeChange={() => mwScrollRef.current?.scrollToEnd({ animated: false })}
          >
            {matchWeeks.map(w => {
              const mt      = history.find(t => t.mwId === w.id);
              const active  = mwId === w.id;
              // Flags the tile gold when a booster was used in that match, so
              // it's visible while scrolling through past matches without
              // having to open each one — mirrors statTileValueLit below.
              const boosted = !!mt && mt.boosters.length > 0;
              return active ? (
                <LinearGradient
                  key={w.id}
                  colors={G.mwTabOn}
                  style={[styles.mwTab, styles.mwTabActive]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 0, y: 1 }}
                >
                  <Text style={[styles.mwTabLabel, styles.mwTabLabelActive]}>{w.label}</Text>
                  <Text style={[styles.mwTabMatch, styles.mwTabMatchActive]}>{w.match}</Text>
                  <Text style={[styles.mwTabPts, styles.mwTabPtsActive, boosted && styles.mwTabPtsLit]}>{mt ? `${mt.pts} pts` : '—'}</Text>
                </LinearGradient>
              ) : (
                <Pressable
                  key={w.id}
                  style={styles.mwTab}
                  onPress={() => setMwId(w.id)}
                >
                  <Text style={styles.mwTabLabel}>{w.label}</Text>
                  <Text style={styles.mwTabMatch}>{w.match}</Text>
                  <Text style={[styles.mwTabPts, boosted && styles.mwTabPtsLit]}>{mt ? `${mt.pts} pts` : '—'}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* ── Body ── */}
          {loadingHist ? (
            <View style={styles.spinnerWrap}>
              <ActivityIndicator size="large" color="#C9A84C" />
            </View>
          ) : team && mw ? (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={styles.teamBody}
              showsVerticalScrollIndicator={false}
            >

              {/* Match/season transfer + booster stat tiles — SL/private only,
                  daily has neither system so it keeps the plain booster line. */}
              {contestType === 'daily' ? (
                <View style={styles.boosterBar}>
                  <Text style={styles.boosterBarLabel}>Boosters</Text>
                  {team.boosters.length > 0
                    ? team.boosters.map((b, i) => (
                        <View key={i} style={styles.boosterPill}>
                          <BoosterIcon icon={b.icon} size={12} style={styles.boosterPillIcon} />
                          <Text style={styles.boosterPillName}>{b.name}</Text>
                        </View>
                      ))
                    : <Text style={styles.boosterNone}>None used</Text>
                  }
                </View>
              ) : (
                <TeamStatTiles team={team} />
              )}

              {/* Overview / Detail toggle — Overview (pitch) is the default;
                  Detail is today's full BAT/BWL/FLD/BON row list, unchanged
                  below, just gated behind the toggle instead of always-on. */}
              <View style={styles.teamViewToggleRow}>
                <Text style={styles.teamViewToggleLabel}>View as</Text>
                <View style={styles.teamViewSeg}>
                  <Pressable
                    style={[styles.teamViewSegBtn, teamView === 'pitch' && styles.teamViewSegBtnOn]}
                    onPress={() => setTeamView('pitch')}
                  >
                    <Text style={[styles.teamViewSegText, teamView === 'pitch' && styles.teamViewSegTextOn]}>Overview</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.teamViewSegBtn, teamView === 'rows' && styles.teamViewSegBtnOn]}
                    onPress={() => setTeamView('rows')}
                  >
                    <Text style={[styles.teamViewSegText, teamView === 'rows' && styles.teamViewSegTextOn]}>Detail</Text>
                  </Pressable>
                </View>
              </View>

              {teamView === 'pitch' && <TeamPitchBreakdown team={team} />}

              {teamView === 'rows' && (
              <>
              {/* Column headers */}
              <View style={styles.colHeaders}>
                <Text style={[styles.colHdr, { flex: 1 }]}>Player</Text>
                <Text style={[styles.colHdr, { width: 30, textAlign: 'center' }]}>BAT</Text>
                <Text style={[styles.colHdr, { width: 30, textAlign: 'center' }]}>BWL</Text>
                <Text style={[styles.colHdr, { width: 30, textAlign: 'center' }]}>FLD</Text>
                <Text style={[styles.colHdr, { width: 30, textAlign: 'center' }]}>BON</Text>
                <Text style={[styles.colHdr, { width: 44, textAlign: 'right'  }]}>PTS</Text>
              </View>

              {/* Player rows — WK, Bat, AR, Bowl. Tapping a row opens its
                  points breakup below the footer (see PlayerBreakdownPanel
                  below) — tapping the same row again closes it. */}
              {sortedPlayers.map((p, i) => {
                const isCap = p.captaincy === 'captain';
                const isVC  = p.captaincy === 'vice_captain';
                const mult  = capMult(p);
                const fp    = finalPts(p);

                return (
                  <Pressable
                    key={i}
                    onPress={() => setRowsSelectedIdx(prev => (prev === i ? null : i))}
                    style={[
                      styles.playerRow,
                      i % 2 === 1 && styles.playerRowAlt,
                      rowsSelectedIdx === i && styles.playerRowSelected,
                    ]}
                  >
                    <View style={[styles.roleStripe, { backgroundColor: ROLE_COLOR[p.role] }]} />

                    <View style={styles.playerNameCell}>
                      <View style={styles.playerNameRow}>
                        {(isCap || isVC) && (
                          <View style={[styles.capBadge, isCap ? styles.capC : styles.capVC]}>
                            <Text style={styles.capBadgeText}>{isCap ? 'C' : 'VC'}</Text>
                          </View>
                        )}
                        <Text style={styles.playerName} numberOfLines={1}>{p.name}</Text>
                      </View>
                      <View style={styles.playerMeta}>
                        <View style={[styles.rolePill, { borderColor: ROLE_COLOR[p.role] + '55' }]}>
                          <Text style={[styles.rolePillText, { color: ROLE_COLOR[p.role] }]}>
                            {ROLE_LABEL[p.role]}
                          </Text>
                        </View>
                        <Text style={styles.playerTeamText}>{p.team}</Text>
                        {mult > 1 && (
                          <View style={[styles.multBadge, isCap ? styles.multC : styles.multVC]}>
                            <Text style={styles.multText}>×{mult}</Text>
                          </View>
                        )}
                      </View>
                    </View>

                    <Text style={[styles.statCol, p.bat   > 0 && styles.statColLit]}>{p.bat   || '—'}</Text>
                    <Text style={[styles.statCol, p.bowl  > 0 && styles.statColLit]}>{p.bowl  || '—'}</Text>
                    <Text style={[styles.statCol, p.field > 0 && styles.statColLit]}>{p.field || '—'}</Text>
                    <Text style={[styles.statCol, p.bonus > 0 && styles.statColLit]}>{p.bonus || '—'}</Text>

                    <Text style={[
                      styles.finalPts,
                      isCap && styles.finalPtsCap,
                      isVC  && styles.finalPtsVC,
                    ]}>
                      {fp % 1 === 0 ? fp : fp.toFixed(1)}
                    </Text>
                  </Pressable>
                );
              })}

              {/* Matchweek total */}
              <LinearGradient colors={G.mwFooter} style={styles.mwFooter} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
                <Text style={styles.mwFooterMatch}>{mw.label} · {mw.match} · Team Total</Text>
                <Text style={styles.mwFooterPts}>{team.pts} pts</Text>
              </LinearGradient>

              {/* Fills the space BELOW the footer only — rows above keep
                  their positions, nothing shifts or gets covered. */}
              {rowsSelectedIdx !== null && sortedPlayers[rowsSelectedIdx] && (
                <PlayerBreakdownPanel
                  player={sortedPlayers[rowsSelectedIdx]}
                  onClose={() => setRowsSelectedIdx(null)}
                />
              )}
              </>
              )}

            </ScrollView>
          ) : (
            <View style={styles.noData}>
              <Text style={styles.noDataText}>
                {matchWeeks.length === 0 ? 'No scored matches yet' : 'No data for this matchweek yet'}
              </Text>
            </View>
          )}

        </SafeAreaView>
      </View>
    </Modal>
  );
}

// ─── Match/season transfer + booster stat tiles ────────────────────────────────
// Replaces the old "Boosters — None used" line for SL/private contests with
// four compact tiles: this match's transfer count and booster pick, plus the
// season-to-date transfer budget and booster tally (same figures already
// shown on the leaderboard rows via entry.transferCount/boosterCount, so the
// numbers always agree with what's visible outside the modal).

function TeamStatTiles({ team }: { team: MatchTeam }) {
  // Wildcard/Free Hit make that match's swaps free and unlimited — they're
  // deliberately never logged to user_transfers (see checkAndLogTransfers),
  // so team.xferCount reads 0 even when the whole XI changed. Showing that
  // raw 0 would read as "no changes made" instead of "nothing was charged".
  const isUnlimitedXfer = team.boosters.some(b => TRANSFER_BOOSTERS.has(b.id));
  const matchXferValue  = isUnlimitedXfer ? 'Unlimited' : String(team.xferCount);
  const matchBoosterValue = team.boosters[0]?.name ?? 'None';

  // "As of this matchweek" running totals — recomputed per tab (seasonHistory.ts),
  // so these change as you flip between matchweeks instead of repeating
  // today's single season figure on every tab.
  const totalXferValue = team.seasonXferAllowed == null
    ? '∞'
    : `${Math.max(0, team.seasonXferAllowed - team.seasonXferUsed)}/${team.seasonXferAllowed}`;
  const totalBoosterValue = team.seasonBoosterAllowed
    ? `${team.seasonBoosterUsed}/${team.seasonBoosterAllowed}`
    : '—';

  const lit = team.boosters.length > 0;

  return (
    <View style={styles.statTilesRow}>
      <View style={[styles.statTile, lit && styles.statTileLit]}>
        <Text style={[styles.statTileLabel, lit && styles.statTileLabelLit]} numberOfLines={1} adjustsFontSizeToFit>🎯 Match</Text>
        <Text style={[styles.statTileValue, lit && styles.statTileValueLit]} numberOfLines={1} adjustsFontSizeToFit>{matchBoosterValue}</Text>
      </View>
      <View style={[styles.statTile, lit && styles.statTileLit]}>
        <Text style={[styles.statTileLabel, lit && styles.statTileLabelLit]} numberOfLines={1} adjustsFontSizeToFit>⇄ Match</Text>
        <Text style={[styles.statTileValue, lit && styles.statTileValueLit]} numberOfLines={1} adjustsFontSizeToFit>{matchXferValue}</Text>
      </View>
      <View style={styles.statTile}>
        <Text style={styles.statTileLabel} numberOfLines={1} adjustsFontSizeToFit>🎯 Total</Text>
        <Text style={styles.statTileValue} numberOfLines={1} adjustsFontSizeToFit>{totalBoosterValue}</Text>
      </View>
      <View style={styles.statTile}>
        <Text style={styles.statTileLabel} numberOfLines={1} adjustsFontSizeToFit>⇄ Total</Text>
        <Text style={styles.statTileValue} numberOfLines={1} adjustsFontSizeToFit>{totalXferValue}</Text>
      </View>
    </View>
  );
}

// ─── User highlight card ──────────────────────────────────────────────────────

function UserHighlight({ entry, showSlCols }: { entry: LeaderboardEntry | undefined; showSlCols: boolean }) {
  if (!entry) return null;
  const boosterLabel = entry.boosterAllowed ? `${entry.boosterCount ?? 0}/${entry.boosterAllowed}` : '—';
  const xferLabel     = entry.transfersAllowed == null
    ? '-'
    : `${Math.max(0, entry.transfersAllowed - (entry.transferCount ?? 0))}/${entry.transfersAllowed}`;
  return (
    <LinearGradient
      colors={G.highlight}
      style={styles.highlight}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
    >
      <Text style={styles.highlightLabel}>Your ranking</Text>
      <View style={styles.highlightRow}>
        <Text style={styles.highlightRank}>{rankMedal(entry.rank)}</Text>
        <View style={styles.highlightMeta}>
          <Text style={styles.highlightTeam}>{entry.teamName}</Text>
          <Text style={styles.highlightPts}>{entry.points.toLocaleString()} pts</Text>
          {showSlCols && (
            <View style={styles.slColsRow}>
              <Text style={styles.slColTextOnHighlight}>🎯 {boosterLabel}</Text>
              <Text style={styles.slColTextOnHighlight}>⇄ {xferLabel}</Text>
            </View>
          )}
        </View>
      </View>
    </LinearGradient>
  );
}

// ─── Entry row ────────────────────────────────────────────────────────────────

interface EntryRowProps {
  entry:   LeaderboardEntry;
  onPress: () => void;
  showSlCols?: boolean; // SL/private contests only — mirrors web's Booster/Xfer columns
}

function EntryRow({ entry, onPress, showSlCols }: EntryRowProps) {
  const isTop3    = entry.rank <= 3;
  const podGrad   = podiumGrad(entry.rank);
  const boosterLabel = entry.boosterAllowed ? `${entry.boosterCount ?? 0}/${entry.boosterAllowed}` : '—';
  const xferLabel     = entry.transfersAllowed == null
    ? '-'
    : `${Math.max(0, entry.transfersAllowed - (entry.transferCount ?? 0))}/${entry.transfersAllowed}`;

  const inner = (
    <View style={styles.rowInner}>
      {/* Rank */}
      <View style={[styles.rankBox, isTop3 && styles.rankBoxTop]}>
        {isTop3 ? (
          <Text style={styles.rankMedal}>{rankMedal(entry.rank)}</Text>
        ) : (
          <Text style={[styles.rankNum, entry.isCurrentUser && styles.rankNumMe]}>
            {entry.rank}
          </Text>
        )}
      </View>

      {/* Avatar — initial of the team name, since that's now the headline identity */}
      <View style={[styles.avatar, entry.isCurrentUser && styles.avatarMe]}>
        <Text style={styles.avatarText}>{entry.teamName.charAt(0).toUpperCase()}</Text>
      </View>

      {/* Names — team name is the headline (bold), user's display name is the subline. */}
      <View style={styles.nameBlock}>
        <Text style={[styles.displayName, entry.isCurrentUser && styles.displayNameMe]}>
          {entry.teamName}
          {entry.isCurrentUser && <Text style={styles.youBadge}> (you)</Text>}
        </Text>
        <Text style={styles.teamName}>{entry.displayName}</Text>
        {showSlCols && (
          <View style={styles.slColsRow}>
            <Text style={styles.slColText}>🎯 {boosterLabel}</Text>
            <Text style={styles.slColText}>⇄ {xferLabel}</Text>
          </View>
        )}
      </View>

      {/* Points */}
      <Text style={[styles.pts, entry.isCurrentUser && styles.ptsMe]}>
        {entry.points.toLocaleString()}
        <Text style={styles.ptsSuffix}> pts</Text>
      </Text>

      <Text style={styles.rowArrow}>›</Text>
    </View>
  );

  // Top-3 get a subtle podium gradient background; current user gets purple tint
  return (
    <Pressable
      style={({ pressed }) => [styles.rowWrap, pressed && styles.rowPressed]}
      onPress={onPress}
    >
      {podGrad ? (
        <LinearGradient colors={podGrad} style={styles.row} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
          {inner}
        </LinearGradient>
      ) : entry.isCurrentUser ? (
        <LinearGradient colors={G.rowMe} style={[styles.row, styles.rowMe]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
          {inner}
        </LinearGradient>
      ) : (
        <View style={styles.row}>{inner}</View>
      )}
    </Pressable>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

type Props = BottomTabScreenProps<RootTabParamList, 'Leaderboard'>;

export default function LeaderboardScreen({ route }: Props) {
  const { user }                                         = useAuthStore();
  const { contests }                                     = useContestStore();
  const { entries: sbEntries, loading,
          loadLeaderboard, setCurrentUser }              = useLeaderboardStore();
  const { selectedTournamentId }                         = useTournamentStore();
  const { width: screenWidth }                           = useWindowDimensions();

  const liveMatch = useLiveMatch(selectedTournamentId);

  // Build tabs from real contests, fall back to hardcoded placeholders
  const tabs: ContestTab[] = useMemo(() => {
    if (contests.length > 0) {
      return contests.map(c => ({
        id:    c.id,
        label: c.name,
        icon:  CONTEST_ICONS_LB[c.contestType] ?? '🏏',
        type:  c.contestType,
      }));
    }
    return buildFallbackTabs();
  }, [contests]);

  const [activeTab, setActiveTab]         = useState<string>(tabs[0]?.id ?? 'daily');
  const [selectedEntry, setSelectedEntry] = useState<LeaderboardEntry | null>(null);

  // ── Progress chart view state ────────────────────────────────────────────────
  const [viewMode,       setViewMode]       = useState<'table' | 'chart'>('table');
  const [chartHistory,   setChartHistory]   = useState<LeaderboardHistory | null>(null);
  const [chartLoading,   setChartLoading]   = useState(false);
  const [chartError,     setChartError]     = useState<string | null>(null);

  // ── Daily-only state ────────────────────────────────────────────────────────
  // Daily has no persistent squad, so it ranks ONE match at a time (mirrors
  // web's getLeaderboardDaily) instead of the squad/season aggregate SL and
  // private leagues use — see dailyLeaderboard.ts for why.
  const [dailyMatchOptions, setDailyMatchOptions] = useState<DailyMatchOption[]>([]);
  const [selectedDailyMatchId, setSelectedDailyMatchId] = useState<string>('');
  const [dailyEntries, setDailyEntries] = useState<LeaderboardEntry[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  // Newest match is the rightmost chip — scroll there by default so the
  // user doesn't have to manually swipe right to see the active selection.
  const dailyChipsScrollRef = useRef<ScrollView>(null);

  // Sync active tab when contests load for the first time, or jump straight
  // to a specific contest's tab when navigated here with a contestId (e.g.
  // tapping a shared private league on Home routes directly to its
  // leaderboard instead of MyXI's picker — see HomeScreen's NestedLeagueRow).
  useEffect(() => {
    const requestedId = route.params?.contestId;
    if (requestedId && tabs.find(t => t.id === requestedId)) {
      if (activeTab !== requestedId) setActiveTab(requestedId);
      return;
    }
    if (tabs.length > 0 && !tabs.find(t => t.id === activeTab)) {
      setActiveTab(tabs[0].id);
    }
  }, [tabs, route.params?.contestId]);

  // Keep the store aware of who's logged in so it can flag isCurrentUser
  useEffect(() => {
    setCurrentUser(user?.id ?? null);
  }, [user?.id]);

  const activeContestType = tabs.find(t => t.id === activeTab)?.type;
  const isDailyTab = activeContestType === 'daily';

  // Load leaderboard whenever tab changes (only for real contest UUIDs)
  useEffect(() => {
    const isRealUuid = activeTab.includes('-'); // UUID contains hyphens; mock keys don't
    if (!isRealUuid) return;
    if (isDailyTab) return; // handled by the match-options effect below
    loadLeaderboard(activeTab);
  }, [activeTab, isDailyTab]);

  // Daily: fetch which match-days have any entries, default to the most
  // recent one. Re-runs whenever the Daily tab itself is selected.
  // getDailyMatchOptions returns oldest → newest, so the newest match is
  // the LAST entry — default to that, not the first.
  useEffect(() => {
    if (!isDailyTab) { setDailyMatchOptions([]); setSelectedDailyMatchId(''); return; }
    const isRealUuid = activeTab.includes('-');
    if (!isRealUuid) return;
    getDailyMatchOptions(activeTab)
      .then(opts => {
        setDailyMatchOptions(opts);
        setSelectedDailyMatchId(opts[opts.length - 1]?.id ?? '');
      })
      .catch(err => {
        console.warn('[LeaderboardScreen] getDailyMatchOptions failed:', err);
        setDailyMatchOptions([]);
        setSelectedDailyMatchId('');
      });
  }, [activeTab, isDailyTab]);

  // Daily: load the ranked entries for whichever match is selected.
  useEffect(() => {
    if (!isDailyTab || !selectedDailyMatchId) { setDailyEntries([]); return; }
    setDailyLoading(true);
    loadDailyLeaderboard(selectedDailyMatchId, user?.id ?? null)
      .then(rows => {
        // Adapt DailyEntry → LBEntry shape so EntryRow/UserHighlight/the modal
        // can render either contest type with no branching of their own.
        setDailyEntries(rows.map(r => ({
          rank:          r.rank,
          userId:        r.userId,
          squadId:       r.teamId,   // N/A for Daily — only used as a key elsewhere
          displayName:   r.displayName,
          teamName:      r.teamName,
          points:        r.points,
          isCurrentUser: r.isCurrentUser,
        })));
      })
      .catch(err => {
        console.warn('[LeaderboardScreen] loadDailyLeaderboard failed:', err);
        setDailyEntries([]);
      })
      .finally(() => setDailyLoading(false));
  }, [selectedDailyMatchId, isDailyTab, user?.id]);

  // Reset to table view when switching to Daily (no history for Daily)
  useEffect(() => {
    if (isDailyTab && viewMode === 'chart') {
      setViewMode('table');
      setChartHistory(null);
    }
  }, [isDailyTab]);

  // Fetch history when entering chart mode for an SL/private tab
  useEffect(() => {
    if (viewMode !== 'chart' || isDailyTab) return;
    const isRealUuid = activeTab.includes('-');
    if (!isRealUuid) return;
    setChartLoading(true);
    setChartError(null);
    getLeaderboardHistory(activeTab)
      .then(h => setChartHistory(h))
      .catch(err => setChartError(err.message ?? 'Failed to load chart'))
      .finally(() => setChartLoading(false));
  }, [viewMode, activeTab, isDailyTab]);

  const entries = isDailyTab ? dailyEntries : (sbEntries[activeTab] ?? []);
  const myEntry = entries.find(e => e.isCurrentUser);
  const listLoading = isDailyTab ? dailyLoading : loading;
  // SL and private leagues share the squad/booster/transfer system — daily
  // contests don't, so only they get the Booster/Xfer columns (mirrors
  // web's `contestType === 'season_long'` check in renderInlineLeaderboard).
  const showSlCols = activeContestType === 'sl' || activeContestType === 'private';

  return (
    <View style={styles.container}>
      {/* Full-screen gradient background */}
      <LinearGradient colors={G.bg} style={StyleSheet.absoluteFill} />

      <SafeAreaView style={styles.safe} edges={['top']}>

      {/* ── Header ── */}
      <LinearGradient colors={G.header} style={styles.pageHeader}>
        <View style={styles.headerLeft}>
          <View style={styles.headerDot} />
          <View>
            <Text style={styles.pageTitle}>Leaderboard</Text>
            <Text style={styles.pageSubtitle}>Tap any player to view their team</Text>
          </View>
        </View>
      </LinearGradient>

      {/* ── Contest tabs ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabs}
        style={styles.tabsScroll}
      >
        {tabs.map(tab => (
          activeTab === tab.id ? (
            <LinearGradient
              key={tab.id}
              colors={G.tabOn}
              style={[styles.tab, styles.tabActive]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
            >
              <Text style={styles.tabIcon}>{tab.icon}</Text>
              <Text style={[styles.tabLabel, styles.tabLabelActive]}>{tab.label}</Text>
            </LinearGradient>
          ) : (
            <Pressable
              key={tab.id}
              style={styles.tab}
              onPress={() => setActiveTab(tab.id)}
            >
              <Text style={styles.tabIcon}>{tab.icon}</Text>
              <Text style={styles.tabLabel}>{tab.label}</Text>
            </Pressable>
          )
        ))}
      </ScrollView>

      {/* ── Table / Progress toggle — SL and private tabs only ── */}
      {!isDailyTab && (
        <View style={styles.viewToggle}>
          <Pressable
            style={[styles.viewPill, viewMode === 'table' && styles.viewPillActive]}
            onPress={() => setViewMode('table')}
          >
            <Text style={[styles.viewPillText, viewMode === 'table' && styles.viewPillTextActive]}>
              📋 Table
            </Text>
          </Pressable>
          <Pressable
            style={[styles.viewPill, viewMode === 'chart' && styles.viewPillActive]}
            onPress={() => setViewMode('chart')}
          >
            <Text style={[styles.viewPillText, viewMode === 'chart' && styles.viewPillTextActive]}>
              📈 Progress
            </Text>
          </Pressable>
        </View>
      )}

      {/* ── Daily match selector — Daily ranks one match at a time, never a
            season aggregate, so this picker IS the equivalent of "which
            matchweek" for this tab. ── */}
      {isDailyTab && dailyMatchOptions.length > 0 && (
        <ScrollView
          ref={dailyChipsScrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.mwTabs}
          onContentSizeChange={() => dailyChipsScrollRef.current?.scrollToEnd({ animated: false })}
        >
          {dailyMatchOptions.map(opt => {
            const isLive = liveMatch?.id === opt.id;
            return (
              <Pressable
                key={opt.id}
                style={[styles.mwTab, selectedDailyMatchId === opt.id && styles.mwTabActive]}
                onPress={() => setSelectedDailyMatchId(opt.id)}
              >
                <Text style={[styles.mwTabLabel, selectedDailyMatchId === opt.id && styles.mwTabLabelActive]}>
                  {isLive ? '🔴 ' : ''}{opt.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* ── Chart view ── */}
      {viewMode === 'chart' ? (
        <ScrollView contentContainerStyle={styles.chartScroll} showsVerticalScrollIndicator={false}>
          {chartLoading ? (
            <View style={styles.spinnerWrap}>
              <ActivityIndicator size="large" color="#C9A84C" />
            </View>
          ) : chartError ? (
            <Text style={styles.empty}>{chartError}</Text>
          ) : chartHistory && chartHistory.squads.length > 0 ? (
            <LeaderboardProgressChart
              history={chartHistory}
              myUserId={user?.id}
              width={screenWidth - spacing.lg * 2}
            />
          ) : chartHistory ? (
            <Text style={styles.empty}>No match data yet for this contest</Text>
          ) : null}
        </ScrollView>
      ) : (
        <>
          {/* ── User highlight ── */}
          {myEntry && <UserHighlight entry={myEntry} showSlCols={showSlCols} />}

          {/* ── Section label ── */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>All Rankings</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* ── Rankings list ── */}
          {listLoading && entries.length === 0 ? (
            <View style={styles.spinnerWrap}>
              <ActivityIndicator size="large" color="#C9A84C" />
            </View>
          ) : (
            <FlatList
              data={entries}
              keyExtractor={item => item.userId}
              renderItem={({ item }) => (
                <EntryRow
                  entry={item}
                  onPress={() => setSelectedEntry(item)}
                  showSlCols={showSlCols}
                />
              )}
              contentContainerStyle={styles.list}
              ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
              ListEmptyComponent={
                <Text style={styles.empty}>
                  {isDailyTab && dailyMatchOptions.length === 0
                    ? 'No locked Daily matches yet'
                    : 'No leaderboard data yet for this contest'}
                </Text>
              }
              showsVerticalScrollIndicator={false}
            />
          )}
        </>
      )}

      {/* ── Team detail modal ── */}
      {selectedEntry && (
        <TeamDetailModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          contestId={activeTab}
          contestType={isDailyTab ? 'daily' : (activeContestType === 'private' ? 'private' : 'sl')}
          initialMwId={isDailyTab ? selectedDailyMatchId : undefined}
        />
      )}

      </SafeAreaView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F0E0',
  },
  safe: {
    flex: 1,
  },

  // Page header
  pageHeader: {
    paddingHorizontal: spacing.xl,
    paddingTop:        spacing.lg,
    paddingBottom:     spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.1)',
    flexDirection:     'row',
    alignItems:        'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
  },
  headerDot: {
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: '#C9A84C',
    shadowColor:     '#C9A84C',
    shadowOffset:    { width: 0, height: 0 },
    shadowOpacity:   0.9,
    shadowRadius:    6,
  },
  pageTitle: {
    color:      C.text,
    fontSize:   fontSize.xl,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  pageSubtitle: {
    color:    C.muted,
    fontSize: fontSize.xs,
    marginTop: 1,
  },

  // Contest tabs
  tabsScroll: {
    flexShrink:        0,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.1)',
  },
  tabs: {
    flexDirection:     'row',
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
    gap:               spacing.sm,
  },
  tab: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.xs,
    height:            36, // fixed — clips instead of growing if a label is long
    paddingHorizontal: spacing.md,
    borderRadius:      radius.full,
    backgroundColor:   'rgba(0,0,0,0.04)',
    borderWidth:       1,
    borderColor:       C.border,
    overflow:          'hidden',
  },
  tabActive: {
    borderColor: 'transparent',
  },
  tabIcon:        { fontSize: 14 },
  tabLabel:       { color: C.text, fontSize: fontSize.sm, fontWeight: '600' },
  tabLabelActive: { color: '#fff', fontWeight: '700' },

  // User highlight
  highlight: {
    margin:        spacing.lg,
    marginBottom:  spacing.xs,
    borderWidth:   1,
    borderColor:   'rgba(201,168,76,0.28)',
    borderRadius:  radius.xl,
    padding:       spacing.lg,
    gap:           spacing.xs,
    ...shadow.card,
  },
  highlightLabel: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  highlightRow:  { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  highlightRank: { fontSize: 28 },
  highlightMeta: { gap: 2 },
  highlightTeam: { color: C.text, fontSize: fontSize.base, fontWeight: '700' },
  highlightPts:  { color: C.text, fontSize: fontSize.sm, fontWeight: '600' },

  // Section divider
  divider: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
  },
  dividerLine: {
    flex:            1,
    height:          1,
    backgroundColor: 'rgba(28,31,38,0.1)',
  },
  dividerText: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  // Entry list
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom:     spacing.xxl,
  },

  // Entry row
  rowWrap:    {},
  rowPressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
  row: {
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderWidth:     1,
    borderColor:     C.border,
    borderRadius:    radius.lg,
    overflow:        'hidden',
    ...shadow.card,
  },
  rowMe: {
    borderColor: 'rgba(201,168,76,0.45)',
  },
  rowInner: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.md,
    padding:       spacing.md,
  },

  rankBox:    { width: 36, height: 36, borderRadius: radius.md, backgroundColor: 'rgba(0,0,0,0.05)', alignItems: 'center', justifyContent: 'center' },
  rankBoxTop: { backgroundColor: 'transparent' },
  rankMedal:  { fontSize: 22 },
  rankNum:    { color: C.muted, fontSize: fontSize.sm, fontWeight: '700' },
  rankNumMe:  { color: C.text },

  avatar:   { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.06)', borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  avatarMe: { backgroundColor: 'rgba(201,168,76,0.18)', borderColor: 'rgba(201,168,76,0.5)' },
  avatarText: { color: C.text, fontSize: fontSize.base, fontWeight: '700' },

  nameBlock:     { flex: 1, gap: 2 },
  displayName:   { color: C.text, fontSize: fontSize.sm, fontWeight: '600' },
  displayNameMe: { color: C.text, fontWeight: '800' },
  youBadge:      { color: C.muted, fontSize: fontSize.xs, fontWeight: '500' },
  teamName:      { color: C.muted, fontSize: fontSize.xs },

  // SL/private-only Booster/Xfer pills — mirrors web's leaderboard columns
  slColsRow:     { flexDirection: 'row', gap: spacing.sm, marginTop: 2 },
  slColText:     { color: C.muted, fontSize: fontSize.xs, fontWeight: '600' },
  slColTextOnHighlight: { color: C.muted, fontSize: fontSize.xs, fontWeight: '700' },

  pts:           { color: C.text, fontSize: fontSize.base, fontWeight: '700' },
  ptsMe:         { color: C.text, fontWeight: '800' },
  ptsSuffix:     { color: C.muted, fontSize: fontSize.xs, fontWeight: '400' },
  rowArrow:      { color: C.muted, fontSize: fontSize.lg, fontWeight: '400', marginLeft: -4 },

  empty: { color: C.muted, fontSize: fontSize.base, textAlign: 'center', marginTop: spacing.xxl },

  // Table / Progress toggle
  viewToggle: {
    flexDirection:     'row',
    gap:               4,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.08)',
    backgroundColor:   'rgba(245,240,224,0.6)',
  },
  viewPill: {
    paddingHorizontal: spacing.md,
    paddingVertical:   5,
    borderRadius:      radius.full,
    borderWidth:       1,
    borderColor:       C.border,
    backgroundColor:   'transparent',
  },
  viewPillActive: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    borderColor:     'rgba(201,168,76,0.5)',
  },
  viewPillText: {
    color:      C.muted,
    fontSize:   fontSize.sm,
    fontWeight: '600',
  },
  viewPillTextActive: {
    color: C.text,
    fontWeight: '700',
  },

  // Chart scroll wrapper
  chartScroll: {
    padding:       spacing.lg,
    paddingBottom: spacing.xxl,
  },

  // ── Team Detail Modal ─────────────────────────────────────────────────────

  modalRoot: {
    flex:            1,
    backgroundColor: '#F5F0E0',
  },
  modalSafe: {
    flex: 1,
  },

  // Modal header
  modalHeader: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  modalClose: {
    width:          34,
    height:         34,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  modalCloseText: { color: C.muted, fontSize: 22, fontWeight: '400' },
  modalMeta:      { flex: 1, gap: 2 },
  modalName:      { color: C.text, fontSize: fontSize.base, fontWeight: '800' },
  modalTeamName:  { color: C.muted, fontSize: fontSize.xs },
  modalTotalBox:  { alignItems: 'flex-end' },
  modalTotalPts:  { color: C.text, fontSize: fontSize.lg, fontWeight: '800' },
  modalTotalSub:  { color: C.muted, fontSize: fontSize.xs, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },

  // Matchweek tabs
  mwTabsScroll: {
    flexShrink:        0,
    maxHeight:         80,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  mwTabs: {
    flexDirection:     'row',
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.xs,
    gap:               spacing.sm,
    alignItems:        'center',
  },
  mwTab: {
    alignItems:        'center',
    paddingHorizontal: spacing.md,
    paddingVertical:   6,
    borderRadius:      radius.md,
    borderWidth:       1,
    borderColor:       C.border,
    backgroundColor:   'rgba(0,0,0,0.03)',
    minWidth:          76,
    gap:               1,
  },
  mwTabActive:       { borderColor: C.borderA },
  mwTabLabel:        { color: C.text, fontSize: fontSize.xs, fontWeight: '800' },
  mwTabLabelActive:  { color: C.text },
  mwTabMatch:        { color: C.muted, fontSize: fontSize.xs },
  mwTabMatchActive:  { color: C.muted },
  mwTabPts:          { color: C.muted, fontSize: fontSize.xs, fontWeight: '700' },
  mwTabPtsActive:    { color: C.text },
  mwTabPtsLit:       { color: C.accent },

  // Body
  teamBody: {
    paddingBottom: spacing.xl,
  },

  // Booster bar
  boosterBar: {
    flexDirection:   'row',
    alignItems:      'center',
    flexWrap:        'wrap',
    gap:             spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm,
    backgroundColor:   'rgba(0,0,0,0.03)',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  boosterBarLabel: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  boosterPill: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               4,
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    backgroundColor:   'rgba(201,168,76,0.10)',
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.3)',
    borderRadius:      radius.full,
  },
  boosterPillIcon: { fontSize: 12 },
  boosterPillName: { color: C.accent, fontSize: fontSize.xs, fontWeight: '700' },
  boosterNone:     { color: C.muted, fontSize: fontSize.xs, fontStyle: 'italic' },

  // Match/season transfer + booster stat tiles — one row, four equal-width
  // tiles. Labels are short enough to sit on one line at this font size on
  // any phone width we support; if a label ever does wrap to two lines the
  // tile just grows a bit taller, it won't push a tile onto a second row.
  statTilesRow: {
    flexDirection:     'row',
    flexWrap:           'nowrap',
    gap:                6,
    paddingHorizontal:  spacing.lg,
    paddingVertical:    spacing.sm,
    backgroundColor:    'rgba(0,0,0,0.03)',
    borderBottomWidth:  1,
    borderBottomColor:  C.border,
  },
  statTile: {
    flex:              1,
    minWidth:          0,
    alignItems:        'center',
    paddingVertical:   6,
    paddingHorizontal: 4,
    borderRadius:      radius.md,
    backgroundColor:   'rgba(28,31,38,0.04)',
  },
  statTileLit: {
    backgroundColor: 'rgba(201,168,76,0.12)',
  },
  statTileLabel: {
    color:         C.muted,
    fontSize:      10,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.2,
    marginBottom:  2,
    textAlign:     'center',
  },
  statTileLabelLit: { color: C.accent },
  statTileValue: {
    color:      C.text,
    fontSize:   fontSize.xs,
    fontWeight: '800',
    textAlign:  'center',
  },
  statTileValueLit: { color: C.accent },

  // Overview / Detail toggle — sits where colHeaders used to start; Detail
  // still renders colHeaders/rows/footer exactly as before, just gated.
  teamViewToggleRow: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical:   7,
    backgroundColor:   'rgba(0,0,0,0.03)',
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

  // Column headers
  colHeaders: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: spacing.md,
    paddingVertical:   6,
    backgroundColor:   'rgba(0,0,0,0.03)',
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  colHdr: {
    color:         C.muted,
    fontSize:      fontSize.xs,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Player rows
  playerRow: {
    flexDirection:   'row',
    alignItems:      'center',
    paddingRight:    spacing.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(28,31,38,0.08)',
    backgroundColor:   'transparent',
  },
  playerRowAlt: {
    backgroundColor: 'rgba(0,0,0,0.02)',
  },
  playerRowSelected: {
    backgroundColor: 'rgba(201,168,76,0.08)',
  },

  roleStripe: {
    width:         3,
    alignSelf:     'stretch',
    marginRight:   spacing.sm,
    borderRadius:  2,
    marginVertical: 4,
  },

  playerNameCell: {
    flex: 1,
    gap:  3,
    paddingRight: 4,
  },
  playerNameRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           5,
  },
  playerName: {
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '700',
    flexShrink: 1,
  },
  playerMeta: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           5,
  },
  playerTeamText: {
    color:    C.muted,
    fontSize: fontSize.xs,
  },

  capBadge: {
    width:          16,
    height:         16,
    borderRadius:    8,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  capC:          { backgroundColor: '#C9A84C' },
  capVC:         { backgroundColor: '#7A7060' },
  capBadgeText:  { color: '#1C1F26', fontSize: 8, fontWeight: '900' },

  rolePill: {
    borderWidth:       1,
    borderRadius:      radius.full,
    paddingHorizontal: 4,
    paddingVertical:   1,
  },
  rolePillText: { fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 0.4 },

  multBadge: {
    paddingHorizontal: 5,
    paddingVertical:   1,
    borderRadius:      radius.full,
    borderWidth:       1,
  },
  multC:    { borderColor: '#C9A84C44', backgroundColor: 'rgba(201,168,76,0.15)' },
  multVC:   { borderColor: '#7A706044', backgroundColor: 'rgba(122,112,96,0.15)' },
  multText: { color: C.text, fontSize: fontSize.xs, fontWeight: '800' },

  statCol: {
    width:      30,
    textAlign:  'center',
    color:      C.muted,
    fontSize:   fontSize.xs,
    fontWeight: '500',
  },
  statColLit: {
    color:      C.text,
    fontWeight: '600',
  },

  finalPts: {
    width:      44,
    textAlign:  'right',
    color:      C.text,
    fontSize:   fontSize.sm,
    fontWeight: '800',
  },
  finalPtsCap: { color: '#C9A84C' },
  finalPtsVC:  { color: '#7A7060' },

  // Matchweek footer
  mwFooter: {
    flexDirection:    'row',
    justifyContent:   'space-between',
    alignItems:       'center',
    marginTop:        spacing.md,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    borderRadius:      radius.lg,
    borderWidth:       1,
    borderColor:       C.border,
  },
  mwFooterMatch: { color: C.muted, fontSize: fontSize.xs },
  mwFooterPts:   { color: C.text, fontSize: fontSize.base, fontWeight: '800' },

  noData:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  noDataText:  { color: C.muted, fontSize: fontSize.base },
  spinnerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
