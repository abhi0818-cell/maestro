/**
 * RulesScreen
 *
 * Tournament-specific rules page — tab next to Leaderboard.
 * Reads live from DB:
 *   • scoring_rules      (tournaments.scoring_rules JSONB)
 *   • available_boosters (contests.available_boosters JSONB map of
 *                         booster_key → uses-per-season — NOT an array)
 *   • transfer caps       (contests.total_transfers_allowed /
 *                         playoff_transfers_allowed / playoff_first_match_
 *                         unlimited, via lib/transferCap.ts)
 * Plus a static Private League concept section.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../lib/supabase';
import { useTournamentStore } from '../store/tournamentStore';
import { useContestStore }    from '../store/contestStore';
import { getBoosterMeta }     from '../store/boosterStore';
import { SCORING_RULES }      from '../engine/cricketScoringEngine';
import { useOnboardingStore } from '../store/onboardingStore';
import BoosterIcon            from '../components/BoosterIcon';
import WalkthroughSettingsSheet from '../components/WalkthroughSettingsSheet';
import {
  fetchContestTransferConfig,
  fetchTournamentMatches,
  type ContestTransferConfig,
} from '../lib/transferCap';
import { colors, fontSize, radius, spacing } from '../theme';

// ─── Gradient palette (matches rest of app) ───────────────────────────────────

const G = {
  bg:     ['#F5F0E0', '#EDE8D5', '#E8E2CE'] as const,
  header: ['rgba(245,240,224,0.98)', 'rgba(237,232,213,0.95)'] as const,
  card:   ['#FFFFFF', '#FAF8F2'] as const,
  accent: ['#C9A84C', '#B8912A'] as const,
};

// Bump this string on every walkthrough-related commit — see the build tag rendered under the Walkthrough card below.
const WALKTHROUGH_BUILD_TAG = 'WT-18';

// ─── Scoring rule display config ──────────────────────────────────────────────

type RuleRow = { label: string; key: string; unit?: string };

const BATTING_ROWS: RuleRow[] = [
  { label: 'Run scored',          key: 'run',            unit: 'per run' },
  { label: 'Boundary (4)',        key: 'boundary4',      unit: 'bonus' },
  { label: 'Six (6)',             key: 'boundary6',      unit: 'bonus' },
  { label: '30-run bonus',        key: 'thirty_run_bonus', unit: 'bonus' },
  { label: 'Half-century (50)',   key: 'half_century',   unit: 'bonus' },
  { label: 'Century (100)',       key: 'century',        unit: 'bonus' },
  { label: 'Duck (dismissed 0)',  key: 'duck',           unit: 'pts' },
  { label: 'SR > 170',           key: 'sr_above_170',   unit: 'bonus' },
  { label: 'SR 140–170',         key: 'sr_140_to_170',  unit: 'bonus' },
  { label: 'SR 70–100',          key: 'sr_70_to_100',   unit: 'pts' },
  { label: 'SR < 70',            key: 'sr_below_70',    unit: 'pts' },
];

const BOWLING_ROWS: RuleRow[] = [
  { label: 'Wicket',              key: 'wicket',           unit: 'per wkt' },
  { label: '3-wicket haul',       key: 'three_wicket_haul', unit: 'bonus' },
  { label: '4-wicket haul',       key: 'four_wicket_haul', unit: 'bonus' },
  { label: '5-wicket haul',       key: 'five_wicket_haul', unit: 'bonus' },
  { label: 'Hat-trick bonus',      key: 'hattrick_bonus',   unit: 'bonus' },
  { label: 'Maiden over',         key: 'maiden_over',      unit: 'bonus' },
  { label: 'Dot ball',            key: 'dot_ball',         unit: 'per dot' },
  { label: 'Economy < 5',         key: 'economy_below_5',  unit: 'bonus' },
  { label: 'Economy 5–6',         key: 'economy_5_to_6',   unit: 'bonus' },
  { label: 'Economy 10–11',       key: 'economy_10_to_11', unit: 'pts' },
  { label: 'Economy > 11',        key: 'economy_above_11', unit: 'pts' },
];

const FIELDING_ROWS: RuleRow[] = [
  { label: 'Catch',               key: 'catch',            unit: 'pts' },
  { label: 'Stumping',            key: 'stumping',         unit: 'pts' },
  { label: 'Run-out (direct)',    key: 'run_out_direct',   unit: 'pts' },
  { label: 'Run-out (indirect)',  key: 'run_out_indirect', unit: 'pts' },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title, icon }: { title: string; icon: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionIcon}>{icon}</Text>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function RuleTable({
  title,
  rows,
  rules,
}: {
  title:  string;
  rows:   RuleRow[];
  rules:  Record<string, number>;
}) {
  const visibleRows = rows.filter(r => rules[r.key] !== undefined && rules[r.key] !== 0);
  if (!visibleRows.length) return null;

  return (
    <View style={styles.ruleTable}>
      <Text style={styles.tableTitle}>{title}</Text>
      {visibleRows.map((row, i) => {
        const val = rules[row.key];
        const isNeg = val < 0;
        return (
          <View
            key={row.key}
            style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}
          >
            <Text style={styles.tableLabel}>{row.label}</Text>
            <Text style={[styles.tableValue, isNeg && styles.tableValueNeg]}>
              {isNeg ? '' : '+'}{val} {row.unit ?? 'pts'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function BoosterCard({ id, uses }: { id: string; uses: number }) {
  // fullName (not the short tile label like "2x"/"3xC") — same identity
  // shown in the mobile app's long-press info alert, so this section reads
  // consistently with what users already see when they tap-and-hold a
  // booster tile on My XI.
  const meta = getBoosterMeta(id) ?? { icon: '🎯', fullName: id, desc: 'Special booster — use once per season.' };
  return (
    <LinearGradient colors={G.card} style={styles.boosterCard}>
      <BoosterIcon icon={meta.icon} size={26} style={styles.boosterIcon} />
      <View style={styles.boosterBody}>
        <View style={styles.boosterNameRow}>
          <Text style={styles.boosterName}>{meta.fullName}</Text>
          <View style={styles.boosterUsesPill}>
            <Text style={styles.boosterUsesPillText}>{uses} use{uses !== 1 ? 's' : ''}</Text>
          </View>
        </View>
        <Text style={styles.boosterDesc}>{meta.desc}</Text>
      </View>
    </LinearGradient>
  );
}

function InfoCard({ children }: { children: React.ReactNode }) {
  return (
    <LinearGradient colors={G.card} style={styles.infoCard}>
      {children}
    </LinearGradient>
  );
}

// ─── Getting Started / Ground Rules building blocks ───────────────────────────
// (static, no DB-driven content — shared by both new sections below)

function NumberedStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepBadgeText}>{n}</Text>
      </View>
      <Text style={styles.stepText}>{children}</Text>
    </View>
  );
}

function BulletItem({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

function InfoTable({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <View style={styles.ruleTable}>
      <Text style={styles.tableTitle}>{title}</Text>
      {rows.map(([label, value], i) => (
        <View key={label} style={[styles.tableRow, i % 2 === 0 && styles.tableRowAlt]}>
          <Text style={styles.tableLabel}>{label}</Text>
          <Text style={styles.infoTableValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function RuleCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.ruleCard}>
      <Text style={styles.ruleCardTitle}>{title}</Text>
      <Text style={styles.ruleCardText}>{children}</Text>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function RulesScreen() {
  const { selectedTournamentId, tournaments } = useTournamentStore();
  const { contests } = useContestStore();
  const {
    walkthroughEnabled, setWalkthroughEnabled, skipMigrationCheck,
    hasSeenHomeTour, resetHomeTour, completeHomeTour,
    hasSeenPlayerPickerTips, resetPlayerPickerTips, completePlayerPickerTips,
    hasSeenBoostersTip, resetBoostersTip, completeBoostersTip,
    hasSeenCaptainVcTip, resetCaptainVcTip, completeCaptainVcTip,
  } = useOnboardingStore();

  // ── Walkthrough settings (on/off switches, not navigation) ─────────────
  const [walkthroughSheetOpen, setWalkthroughSheetOpen] = useState(false);
  const walkthroughSections = [
    {
      key: 'home', icon: '🏠', name: 'Home tour',
      meta: 'What each button on Home does',
      seen: hasSeenHomeTour,
      onToggle: (on: boolean) => (on ? resetHomeTour() : completeHomeTour()),
    },
    {
      key: 'picker', icon: '🎯', name: 'Player Picker tips',
      meta: 'Budget, My XI & Schedule',
      seen: hasSeenPlayerPickerTips,
      onToggle: (on: boolean) => (on ? resetPlayerPickerTips() : completePlayerPickerTips()),
    },
    {
      key: 'boosters', icon: '⚡', name: 'Boosters tip',
      meta: 'Shows on an SL/private squad',
      seen: hasSeenBoostersTip,
      onToggle: (on: boolean) => (on ? resetBoostersTip() : completeBoostersTip()),
    },
    {
      key: 'captainVc', icon: '🎖️', name: 'Captain & Vice-Captain tip',
      meta: 'Shows in Save/Confirm XI',
      seen: hasSeenCaptainVcTip,
      onToggle: (on: boolean) => (on ? resetCaptainVcTip() : completeCaptainVcTip()),
    },
  ];

  const tournament = tournaments.find(t => t.id === selectedTournamentId);

  const [rules, setRules]             = useState<Record<string, any> | null>(null);
  // available_boosters is a JSONB map of booster_key → uses-per-season (see
  // migration_v12_boosters.sql / migration_v47's max-uses trigger) — NOT a
  // plain array. Reading it as an array (the old behaviour here) silently
  // dropped the per-booster use count, so a booster configured for 2 uses
  // looked identical to one configured for 1.
  const [boostersMap, setBoostersMap] = useState<Record<string, number>>({});
  const [transferConfig, setTransferConfig]     = useState<ContestTransferConfig | null>(null);
  const [leagueMatchCount, setLeagueMatchCount] = useState<number | null>(null);
  const [playoffMatchCount, setPlayoffMatchCount] = useState<number | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  // dot_ball_enabled (migration_v30) — hide the Dot ball row below unless
  // this tournament has explicitly turned it on, regardless of whatever
  // numeric weight happens to be saved in scoring_rules. Mirrors the web's
  // Rules modal gate.
  const [dotBallEnabled, setDotBallEnabled] = useState(false);

  const fmt = (tournament?.format ?? 'T20').toUpperCase() === 'ODI' ? 'ODI' : 'T20';

  useEffect(() => {
    if (!selectedTournamentId) { setLoading(false); return; }
    load();
  }, [selectedTournamentId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // 1. Scoring rules from tournament
      const { data: tData, error: tErr } = await supabase
        .from('tournaments')
        .select('scoring_rules, dot_ball_enabled')
        .eq('id', selectedTournamentId!)
        .single();
      if (tErr) throw tErr;

      const fmtRules = tData?.scoring_rules?.[fmt] ?? null;
      setRules(fmtRules ? { ...SCORING_RULES[fmt], ...fmtRules } : null);
      setDotBallEnabled(!!tData?.dot_ball_enabled);

      // 2. Contest config — boosters + transfers.
      // Boosters/transfer caps only exist on season_long/private contests
      // (daily contests have no configurable options — see admin.js), so
      // prefer an 'sl'/'private' contest over 'daily' here, unlike the old
      // boosters-only fetch which matched 'daily' too and would silently
      // find nothing to show on tournaments that only run daily contests.
      let contestId: string | null = null;
      if (contests.length) {
        const slContest = contests.find(c => c.contestType === 'sl' || c.contestType === 'private');
        contestId = slContest?.id ?? null;
      }
      if (!contestId) {
        const { data: cRow } = await supabase
          .from('contests')
          .select('id')
          .eq('tournament_id', selectedTournamentId!)
          .eq('contest_type', 'season_long')
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();
        contestId = cRow?.id ?? null;
      }

      if (contestId) {
        const { data: cData } = await supabase
          .from('contests')
          .select('available_boosters')
          .eq('id', contestId)
          .single();
        const rawBoosters = cData?.available_boosters;
        setBoostersMap(
          rawBoosters && typeof rawBoosters === 'object' && !Array.isArray(rawBoosters)
            ? rawBoosters as Record<string, number>
            : {},
        );

        const { config, tournamentId } = await fetchContestTransferConfig(contestId);
        setTransferConfig(config);

        if (tournamentId && config.playoff_start_match_number != null) {
          const matches = await fetchTournamentMatches(tournamentId);
          const playoffStart = config.playoff_start_match_number;
          setLeagueMatchCount(matches.filter(m => (m.match_number ?? 0) > 0 && (m.match_number ?? 0) < playoffStart).length);
          setPlayoffMatchCount(matches.filter(m => (m.match_number ?? 0) >= playoffStart).length);
        } else {
          setLeagueMatchCount(null);
          setPlayoffMatchCount(null);
        }
      } else {
        setBoostersMap({});
        setTransferConfig(null);
        setLeagueMatchCount(null);
        setPlayoffMatchCount(null);
      }
    } catch (e: any) {
      setError(e.message ?? 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }

  // ── Default T20 rules (shown when tournament has none configured) ─────────────
  const DEFAULT_RULES: Record<string, number> = {
    run: 1, boundary4: 1, boundary6: 2,
    thirty_run_bonus: 4, half_century: 8, century: 16, duck: -2,
    sr_above_170: 6, sr_140_to_170: 4, sr_below_70: -6, sr_70_to_100: -4,
    wicket: 25, maiden_over: 8, dot_ball: 0,
    three_wicket_haul: 8, four_wicket_haul: 8, five_wicket_haul: 16, hattrick_bonus: 16,
    economy_below_5: 6, economy_5_to_6: 4, economy_10_to_11: -4, economy_above_11: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
  };

  const displayRules: Record<string, number> = rules ?? DEFAULT_RULES;
  const isDefault = !rules;

  return (
    <LinearGradient colors={G.bg} style={{ flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <LinearGradient colors={G.header} style={styles.header}>
          <Text style={styles.headerTitle}>Rules</Text>
          {tournament && (
            <Text style={styles.headerSub}>
              {tournament.name} · {fmt}
            </Text>
          )}
        </LinearGradient>

        {loading ? (
          <View style={styles.centred}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        ) : error ? (
          <View style={styles.centred}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >

            {/* ── 0. Getting Started — static how-to-play flow, no DB content ── */}
            <SectionHeader title="Getting Started" icon="📝" />

            <InfoCard>
              <Text style={styles.infoNote}>
                New to Maestro? Here's the flow from joining a contest to your squad locking in for a match.
              </Text>
            </InfoCard>

            <Pressable
              style={({ pressed }) => [styles.replayCard, pressed && { opacity: 0.85 }]}
              onPress={() => { skipMigrationCheck(); setWalkthroughSheetOpen(true); }}
            >
              <Text style={styles.replayIcon}>🎓</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.replayTitle}>Walkthrough</Text>
                <Text style={styles.replaySub}>Turn onboarding tips on or off, by section</Text>
              </View>
              <Text style={styles.replayArrow}>›</Text>
            </Pressable>
            {/* Temporary build tag — lets us confirm in-app which JS bundle
                is actually live, since EAS Update only applies on the NEXT
                cold start after download (a "double relaunch" is easy to
                miss, and Expo Go always runs fresh source, so the two can
                silently disagree). Safe to remove once walkthrough rollout
                is confirmed stable. */}
            <Text style={styles.buildTag}>build {WALKTHROUGH_BUILD_TAG}</Text>

            <Text style={styles.subTitle}>Join a Contest</Text>
            <BulletItem>Pick the tournament you want to play from the <Text style={styles.infoEmph}>Home</Text> tab.</BulletItem>
            <BulletItem><Text style={styles.infoEmph}>Season Long</Text> is the main contest — one squad, scored across the whole tournament.</BulletItem>
            <BulletItem>
              Playing with friends? On <Text style={styles.infoEmph}>Home</Text>, open the <Text style={styles.infoEmph}>Season Long</Text> tile
              and tap <Text style={styles.infoEmph}>➕ Create or Join</Text> under Private Leagues to see leagues you're in, create one, or join one
              by invite code. Your XI is shared across the public contest and every standard-rules private league you're in — you only pick once.
            </BulletItem>

            <Text style={styles.subTitle}>Draft Your Squad</Text>
            <Text style={styles.infoNote}>Build your 11 from the full player pool. Limits while you pick:</Text>
            <InfoTable
              title="Squad Limits"
              rows={[
                ['Budget', '100 credits total'],
                ['Squad size', 'Exactly 11 players'],
                ['Players from one real team', 'Max 7'],
                ['Overseas players', 'Set per tournament — see Contest below'],
              ]}
            />
            <InfoTable
              title="Role Composition (Final XI)"
              rows={[
                ['Wicketkeeper (WK)', '1 – 4'],
                ['Batter (BAT)', '3 – 6'],
                ['All-rounder (AR)', '1 – 4'],
                ['Bowler (BOWL)', '3 – 6'],
              ]}
            />
            <Text style={styles.ruleNote}>
              The player pool won't let you make a pick that makes a valid XI impossible — so you can't build an invalid
              squad in the first place.
            </Text>

            <Text style={styles.subTitle}>Captain &amp; Vice-Captain</Text>
            <BulletItem><Text style={styles.infoEmph}>Captain</Text> — scores 2× their base points.</BulletItem>
            <BulletItem><Text style={styles.infoEmph}>Vice-Captain</Text> — scores 1.5× their base points.</BulletItem>

            <Text style={styles.subTitle}>Save Your XI &amp; Match Lock</Text>
            <NumberedStep n={1}>Review your picks, Captain/VC, and booster, then tap <Text style={styles.infoEmph}>Save XI</Text>.</NumberedStep>
            <NumberedStep n={2}>
              Every match has a <Text style={styles.infoEmph}>lock time</Text> — normally kickoff, though admins can push it
              earlier/later or mark a match <Text style={styles.infoEmph}>delayed</Text>.
            </NumberedStep>
            <NumberedStep n={3}>Right up until the lock time, you can keep editing — transfers, Captain/VC, and booster choice all stay open.</NumberedStep>
            <NumberedStep n={4}>Once the lock passes, that match's XI, Captain/VC, and booster are frozen. Editing re-opens for the <Text style={styles.infoEmph}>next</Text> match.</NumberedStep>
            <NumberedStep n={5}>If a match is delayed, the lock moves with it — you're free to keep editing until the new lock time.</NumberedStep>

            {/* ── 1. Contest — transfers + boosters overview ─────────────────── */}
            {(transferConfig || Object.keys(boostersMap).length > 0) && (
              <>
                <SectionHeader title="Contest" icon="🏆" />

                {transferConfig && (
                  <>
                    <Text style={styles.subTitle}>Transfers</Text>
                    <Text style={styles.infoNote}>
                      Transfers swap players in and out of your squad between matches. Your exact allowance is set for
                      this contest below.
                    </Text>
                    <InfoCard>
                      <Text style={styles.infoNote}>
                        <Text style={styles.infoEmph}>League Phase:</Text>{' '}
                        {transferConfig.total_transfers_allowed ?? 'Unlimited'} transfers
                        {leagueMatchCount != null ? ` for the ${leagueMatchCount} league matches` : ''} —
                        unlimited until your first match locks, then the cap applies.
                      </Text>
                    </InfoCard>
                    <InfoCard>
                      <Text style={styles.infoNote}>
                        <Text style={styles.infoEmph}>Playoffs:</Text>{' '}
                        {transferConfig.playoff_transfers_allowed ?? 'Unlimited'} transfers
                        {playoffMatchCount != null ? ` for the ${playoffMatchCount} playoff matches` : ''}
                        {transferConfig.playoff_first_match_unlimited
                          ? ' — unlimited until Qualifier 1 match locks, then the cap applies.'
                          : '.'}
                      </Text>
                    </InfoCard>
                  </>
                )}

                {Object.keys(boostersMap).length > 0 && (
                  <>
                    <Text style={styles.subTitle}>Boosters</Text>
                    <Text style={styles.infoNote}>
                      Boosters are optional, once-per-season power-ups. Only one can be active for any given match.
                    </Text>
                    <InfoCard>
                      <Text style={styles.infoNote}>
                        {Object.keys(boostersMap).length} booster{Object.keys(boostersMap).length !== 1 ? 's' : ''} available
                        this season. Only <Text style={styles.infoEmph}>one booster</Text> can be active per match, and each
                        can only be used the number of times shown below.
                      </Text>
                    </InfoCard>
                    {Object.entries(boostersMap).map(([id, uses]) => (
                      <BoosterCard key={id} id={id} uses={uses} />
                    ))}
                  </>
                )}
              </>
            )}

            {/* ── 2. Scoring ──────────────────────────────────────────────── */}
            <SectionHeader title="Scoring" icon="🏏" />

            {isDefault && (
              <View style={styles.defaultBadge}>
                <Text style={styles.defaultBadgeText}>
                  Showing default {fmt} scoring — admin can customise per tournament
                </Text>
              </View>
            )}

            <InfoCard>
              <Text style={styles.infoNote}>
                Each player earns points based on their in-match performance. Your XI total is the sum of all 11
                players — see <Text style={styles.infoEmph}>Getting Started</Text> for how Captain and Vice-Captain
                multipliers work.
              </Text>
            </InfoCard>

            <RuleTable title="Batting"  rows={BATTING_ROWS}  rules={displayRules} />
            <Text style={styles.ruleNote}>
              SR bonus/penalty only applies once the batter has faced 10+ balls.
            </Text>
            <RuleTable
              title="Bowling"
              rows={dotBallEnabled ? BOWLING_ROWS : BOWLING_ROWS.filter(r => r.key !== 'dot_ball')}
              rules={displayRules}
            />
            <Text style={styles.ruleNote}>
              Economy bonus/penalty only applies once the bowler has bowled more than 6 balls (past the 1st over).
            </Text>
            <RuleTable title="Fielding" rows={FIELDING_ROWS} rules={displayRules} />

            {/* ── 3. Ground Rules — static, hardcoded house rules ─────────────── */}
            <SectionHeader title="Ground Rules" icon="📜" />

            <RuleCard title="No points for the Super Over">
              Maestro only scores the main innings of a match. If a game is tied and goes to a Super Over, nobody
              gains or loses fantasy points for it — the result stands for the tournament table, but it has no
              effect on your squad's score.
            </RuleCard>
            <RuleCard title="A fixture called off before it locks doesn't count">
              If a match is cancelled or pulled from the schedule before its lock time, it's skipped entirely — it
              never locks, and everyone simply rolls forward to the next scheduled match. No points, transfers, or
              booster usage are affected.
            </RuleCard>
            <RuleCard title="A match abandoned or rained off after it's started is scored on the play that happened">
              If a match is interrupted or called off partway through (rain, bad light, etc.), it's scored from
              whatever overs/wickets were actually completed before it was called off — same scoring rules as a
              full match, just on a shorter innings. It is not excluded and does not get replayed for fantasy
              purposes, even if the real-world result is a "no result."
            </RuleCard>
            <RuleCard title="Transfers and boosters used for an abandoned match are not refunded">
              If your team had already locked for a match — even if it's later marked abandoned with no ball
              bowled — any transfer or booster you spent on that match stays spent. It still counts against your
              season/playoff transfer cap and your booster's once-per-season use, exactly as if the match had been
              played. There's no automatic refund for this today.
            </RuleCard>

            {/* ── 4. Private Leagues ──────────────────────────────────────── */}
            <SectionHeader title="Private Leagues" icon="🔒" />

            <InfoCard>
              <Text style={styles.infoNote}>
                Private leagues let you compete against a specific group of friends using
                a <Text style={styles.infoEmph}>shared player pool</Text> from this tournament.
              </Text>
            </InfoCard>

            {[
              {
                icon: '👥',
                heading: 'Standard leagues share your SL XI',
                body: 'Most private leagues (the ones you or a friend create) use the same scoring rules and boosters as Season Long — your SL squad is mirrored in automatically, pick once, compete everywhere. Joining late still shows your full history from the first match.',
              },
              {
                icon: '📋',
                heading: 'Custom-rules leagues are separate',
                body: 'An admin can also set up a league with its own scoring rules and boosters, different from Season Long — that one you pick your XI for independently, every match.',
              },
              {
                icon: '🔑',
                heading: 'Creating or joining',
                body: 'On Home, open the Season Long tile and tap "➕ Create or Join" under Private Leagues to see leagues you\'re in, create one, or join one. Creating makes a standard league (up to 3 members — an admin can raise that); joining just needs the invite code your friend shares.',
              },
            ].map(item => (
              <LinearGradient key={item.heading} colors={G.card} style={styles.conceptCard}>
                <Text style={styles.conceptIcon}>{item.icon}</Text>
                <View style={styles.conceptBody}>
                  <Text style={styles.conceptHeading}>{item.heading}</Text>
                  <Text style={styles.conceptText}>{item.body}</Text>
                </View>
              </LinearGradient>
            ))}

            <View style={{ height: 32 }} />
          </ScrollView>
        )}
      </SafeAreaView>

      <WalkthroughSettingsSheet
        visible={walkthroughSheetOpen}
        onDismiss={() => setWalkthroughSheetOpen(false)}
        walkthroughEnabled={walkthroughEnabled}
        onToggleWalkthrough={setWalkthroughEnabled}
        sections={walkthroughSections}
      />
    </LinearGradient>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  replayCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: 'rgba(201,168,76,0.1)',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  replayIcon: { fontSize: 20 },
  replayTitle: { color: colors.text, fontSize: fontSize.base, fontWeight: '700' },
  replaySub: { color: colors.muted, fontSize: fontSize.xs, marginTop: 2 },
  replayArrow: { color: colors.accent, fontSize: fontSize.lg, fontWeight: '700' },
  buildTag: { fontSize: 10, color: '#B4AA8E', textAlign: 'right', marginTop: -6, marginBottom: spacing.md },
  // Layout
  centred: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl,
  },
  scroll: { padding: spacing.lg, paddingTop: spacing.md, gap: spacing.md },

  // Header
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize:   fontSize.xl,
    fontWeight: '800',
    color:      colors.text,
  },
  headerSub: {
    fontSize:  fontSize.sm,
    color:     colors.muted,
    marginTop: 2,
  },

  // Section header
  sectionHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.sm,
    marginTop:      spacing.md,
    marginBottom:   spacing.xs,
  },
  sectionIcon:  { fontSize: 18 },
  sectionTitle: {
    fontSize:      fontSize.base,
    fontWeight:    '800',
    color:         colors.text,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  // Sub-heading within a section (e.g. "Transfers"/"Boosters" inside Contest)
  subTitle: {
    fontSize:      fontSize.sm,
    fontWeight:    '700',
    color:         colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop:     spacing.xs,
  },

  // Default badge
  defaultBadge: {
    backgroundColor: 'rgba(201,168,76,0.12)',
    borderWidth:     1,
    borderColor:     'rgba(201,168,76,0.3)',
    borderRadius:    radius.md,
    padding:         spacing.sm,
    marginBottom:    spacing.xs,
  },
  defaultBadgeText: {
    fontSize:  fontSize.sm,
    color:     colors.muted,
    textAlign: 'center',
  },

  // Info card
  infoCard: {
    borderRadius:  radius.lg,
    borderWidth:   1,
    borderColor:   colors.border,
    padding:       spacing.md,
    marginBottom:  spacing.xs,
  },
  infoNote: {
    fontSize:   fontSize.sm,
    color:      colors.muted,
    lineHeight: 18,
  },
  infoEmph: {
    fontWeight: '700',
    color:      colors.text,
  },

  // Rule table
  ruleTable: {
    borderRadius:  radius.lg,
    borderWidth:   1,
    borderColor:   colors.border,
    overflow:      'hidden',
    marginBottom:  spacing.xs,
  },
  tableTitle: {
    fontSize:          fontSize.sm,
    fontWeight:        '700',
    color:             colors.muted,
    textTransform:     'uppercase',
    letterSpacing:     0.8,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    backgroundColor:   'rgba(201,168,76,0.08)',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tableRow: {
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    backgroundColor:   '#FFFFFF',
  },
  tableRowAlt: {
    backgroundColor: '#FAF8F2',
  },
  tableLabel: {
    fontSize: fontSize.sm,
    color:    colors.text,
    flex:     1,
  },
  tableValue: {
    fontSize:   fontSize.sm,
    fontWeight: '700',
    color:      colors.good,
    minWidth:   72,
    textAlign:  'right',
  },
  tableValueNeg: {
    color: colors.bad,
  },
  ruleNote: {
    fontSize:   fontSize.sm - 1,
    color:      colors.muted,
    marginTop:  -spacing.xs,
    marginBottom: spacing.xs,
    paddingHorizontal: 2,
  },

  // Plain label/value table (Getting Started — Squad Limits, Role Composition)
  infoTableValue: {
    fontSize:   fontSize.sm,
    fontWeight: '700',
    color:      colors.text,
    minWidth:   72,
    textAlign:  'right',
  },

  // Numbered steps (Getting Started — Save Your XI & Match Lock)
  stepRow: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    gap:           spacing.sm,
    marginBottom:  spacing.xs,
    paddingHorizontal: 2,
  },
  stepBadge: {
    width:            18,
    height:           18,
    borderRadius:     9,
    backgroundColor:  'rgba(201,168,76,0.18)',
    borderWidth:       1,
    borderColor:       'rgba(201,168,76,0.4)',
    alignItems:        'center',
    justifyContent:    'center',
    marginTop:         1,
  },
  stepBadgeText: {
    fontSize:   fontSize.sm - 3,
    fontWeight: '800',
    color:      colors.text,
  },
  stepText: {
    flex:       1,
    fontSize:   fontSize.sm,
    color:      colors.text,
    lineHeight: 18,
  },

  // Bullet list (Getting Started — Join a Contest, Captain & Vice-Captain)
  bulletRow: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    gap:           spacing.sm,
    marginBottom:  spacing.xs,
    paddingHorizontal: 2,
  },
  bulletDot: {
    fontSize:   fontSize.sm,
    color:      colors.muted,
    lineHeight: 18,
  },
  bulletText: {
    flex:       1,
    fontSize:   fontSize.sm,
    color:      colors.text,
    lineHeight: 18,
  },

  // Ground Rules cards
  ruleCard: {
    borderRadius:      radius.lg,
    borderWidth:        1,
    borderColor:        'rgba(201,168,76,0.4)',
    backgroundColor:    'rgba(201,168,76,0.08)',
    padding:            spacing.md,
    marginBottom:       spacing.xs,
  },
  ruleCardTitle: {
    fontSize:   fontSize.sm,
    fontWeight: '700',
    color:      colors.text,
    marginBottom: 4,
  },
  ruleCardText: {
    fontSize:   fontSize.sm,
    color:      colors.muted,
    lineHeight: 18,
  },

  // Booster cards
  boosterCard: {
    flexDirection:  'row',
    alignItems:     'flex-start',
    gap:            spacing.md,
    padding:        spacing.md,
    borderRadius:   radius.lg,
    borderWidth:    1,
    borderColor:    colors.border,
    marginBottom:   spacing.xs,
  },
  boosterIcon: { fontSize: 26, marginTop: 2 },
  boosterBody: { flex: 1 },
  boosterNameRow: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            spacing.sm,
    marginBottom:   3,
  },
  boosterName: {
    fontSize:   fontSize.base,
    fontWeight: '700',
    color:      colors.text,
    flexShrink: 1,
  },
  boosterUsesPill: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    borderWidth:     1,
    borderColor:     'rgba(201,168,76,0.4)',
    borderRadius:    radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  boosterUsesPillText: {
    fontSize:   fontSize.sm - 2,
    fontWeight: '700',
    color:      colors.text,
  },
  boosterDesc: {
    fontSize:   fontSize.sm,
    color:      colors.muted,
    lineHeight: 18,
  },

  // Concept cards (Private League section)
  conceptCard: {
    flexDirection:  'row',
    alignItems:     'flex-start',
    gap:            spacing.md,
    padding:        spacing.md,
    borderRadius:   radius.lg,
    borderWidth:    1,
    borderColor:    colors.border,
    marginBottom:   spacing.xs,
  },
  conceptIcon:    { fontSize: 22, marginTop: 2 },
  conceptBody:    { flex: 1 },
  conceptHeading: {
    fontSize:   fontSize.base,
    fontWeight: '700',
    color:      colors.text,
    marginBottom: 3,
  },
  conceptText: {
    fontSize:   fontSize.sm,
    color:      colors.muted,
    lineHeight: 18,
  },

  errorText: { fontSize: fontSize.base, color: colors.bad, textAlign: 'center' },
});
