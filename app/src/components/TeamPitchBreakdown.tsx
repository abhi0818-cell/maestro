/**
 * TeamPitchBreakdown — read-only pitch view of a scored MatchTeam: same
 * WK/BAT/AR/BOWL field layout as CricketPitch.tsx (My XI), but each jersey
 * shows this match's scored points underneath instead of the credits pill,
 * and there's no captaincy/remove interaction. Mirrors web's
 * histPitchHtml/histPitchToken exactly — same field background, same
 * jersey/badge/decor primitives CricketPitch.tsx already uses for the
 * editable pitch, just wired to scored MatchTeam data.
 *
 * This is the "Overview" half of TeamDetailModal's Overview/Detail toggle —
 * "Detail" is the existing BAT/BWL/FLD/BON row list, untouched.
 *
 * seasonHistory.ts's MatchPlayer only carries name/team/role/stats — no team
 * color, overseas flag, or photo (those come from a `players`/`teams` join
 * the history query doesn't do). Resolved here via a name+team lookup
 * against the currently-loaded tournament player pool (useTeamStore), same
 * best-effort fallback web's histPitchToken uses (playerById) for the exact
 * same reason — and the same "assumes the pool is loaded for the SAME
 * tournament this match belongs to" caveat web's own comment calls out.
 * When there's no match (wrong tournament loaded, or a squad player who's
 * since left the pool), the tile just falls back to a plain grey jersey and
 * no overseas badge rather than showing anything actually wrong.
 */
import React, { useState } from 'react';
import { Image, LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, {
  Defs,
  RadialGradient,
  LinearGradient as SvgLinearGradient,
  Stop,
  ClipPath,
  Ellipse,
  Rect,
  Line,
  G,
} from 'react-native-svg';
import BoosterIcon from './BoosterIcon';
import Jersey from './Jersey';
import { PlayerRole } from '../types';
import { useTeamStore } from '../store/teamStore';
import { getTileBoosterDecor } from '../store/boosterStore';
import { MatchPlayer, MatchTeam } from '../lib/seasonHistory';

const ROLE_ICON: Record<PlayerRole, number> = {
  wk:   require('../../assets/role-icons/wk.png'),
  bat:  require('../../assets/role-icons/bat.png'),
  ar:   require('../../assets/role-icons/ar.png'),
  bowl: require('../../assets/role-icons/bowl.png'),
};
const ROLE_ORDER: PlayerRole[] = ['wk', 'bat', 'ar', 'bowl'];

const WRAP_BG = '#1a5c1a';

// ─── Adaptive jersey sizing — mirrors CricketPitch.tsx's fitTileSize exactly
// (duplicated rather than imported since it's module-local there; a crowded
// BAT/BOWL row still needs to shrink its tiles the same way My XI's pitch does).
const TSZ_MIN = 26;
const TSZ_MAX = 44;
const TILE_GAP    = 4;
const TILE_ROWPAD = 4;
const JERSEY_FRACTION = 0.6;

function fitTileSize(availWidth: number, count: number): number {
  if (count <= 0 || availWidth <= 0) return TSZ_MAX;
  const perTile = (availWidth - TILE_ROWPAD - TILE_GAP * (count - 1)) / count;
  const jerseySize = perTile * JERSEY_FRACTION;
  return Math.min(TSZ_MAX, Math.max(TSZ_MIN, Math.floor(jerseySize)));
}

// ─── Field background (SVG) — identical to CricketPitch.tsx's FieldBackground ──
const MOW_STRIPE_Y: number[] = [];
for (let y = 0; y < 460; y += 48) MOW_STRIPE_Y.push(y);

function FieldBackground() {
  return (
    <Svg
      viewBox="0 0 304 460"
      preserveAspectRatio="none"
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      <Defs>
        <RadialGradient id="histFieldGrad" cx="152" cy="230" r="220" gradientUnits="userSpaceOnUse">
          <Stop offset="0%"   stopColor="#4ec94e" />
          <Stop offset="22%"  stopColor="#3aad3a" />
          <Stop offset="45%"  stopColor="#2b8f2b" />
          <Stop offset="65%"  stopColor="#1d6e1d" />
          <Stop offset="85%"  stopColor="#0f470f" />
          <Stop offset="100%" stopColor="#09300d" />
        </RadialGradient>
        <SvgLinearGradient id="histPitchGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%"   stopColor="#b8893a" />
          <Stop offset="40%"  stopColor="#d4a85a" />
          <Stop offset="60%"  stopColor="#d4a85a" />
          <Stop offset="100%" stopColor="#b8893a" />
        </SvgLinearGradient>
        <ClipPath id="histFieldClip">
          <Ellipse cx="152" cy="230" rx="148" ry="226" />
        </ClipPath>
      </Defs>

      <Ellipse cx="152" cy="230" rx="148" ry="226" fill="url(#histFieldGrad)" />

      <G clipPath="url(#histFieldClip)">
        {MOW_STRIPE_Y.map(y => (
          <Rect key={y} x="0" y={y + 24} width="304" height="24" fill="rgba(255,255,255,0.035)" />
        ))}
      </G>

      <Ellipse cx="152" cy="230" rx="145" ry="220" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={2} strokeDasharray="7 5" />
      <Rect x="134" y="140" width="36" height="180" rx="5" fill="url(#histPitchGrad)" opacity={0.72} />
      <Line x1="120" y1="165" x2="184" y2="165" stroke="rgba(255,255,255,0.6)" strokeWidth={2} />
      <Line x1="120" y1="295" x2="184" y2="295" stroke="rgba(255,255,255,0.6)" strokeWidth={2} />
      <Line x1="147" y1="155" x2="147" y2="167" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="152" y1="155" x2="152" y2="167" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="157" y1="155" x2="157" y2="167" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="147" y1="293" x2="147" y2="305" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="152" y1="293" x2="152" y2="305" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
      <Line x1="157" y1="293" x2="157" y2="305" stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
    </Svg>
  );
}

// ─── Player tile ────────────────────────────────────────────────────────────

function PitchToken({ player, boosterKey, tsz }: { player: MatchPlayer; boosterKey: string | null; tsz: number }) {
  const isCap = player.captaincy === 'captain';
  const isVC  = player.captaincy === 'vice_captain';

  // Best-effort cosmetic lookup only — see file header. Falls back to a
  // plain grey jersey / no overseas badge, never to a wrong-but-confident one.
  const pool = useTeamStore(s => s.players);
  const poolMatch = pool.find(p => p.name === player.name && p.team === player.team)
                 ?? pool.find(p => p.name === player.name);
  const overseas = poolMatch?.overseas ?? false;

  const decor = getTileBoosterDecor(player.captaincy, overseas, boosterKey);

  const rawPts   = player.bat + player.bowl + player.field + player.bonus;
  const finalPts = Math.round(rawPts * player.multiplier * 10) / 10;

  // "Virat Kohli" → "V. Kohli" — same convention as CricketPitch.tsx's My XI tile.
  const words     = player.name.trim().split(' ');
  const shortName = words.length > 1
    ? `${words[0][0]}. ${words.slice(1).join(' ')}`
    : words[0];

  const badgeSize     = tsz * 0.44;
  const capTopOffset  = -tsz * 0.15;
  const sideOffset    = -tsz * 0.18;
  const capFontSize   = Math.max(7, tsz * 0.24);
  const sideFontSize  = Math.max(8, tsz * 0.3);
  const tileWidth     = tsz / JERSEY_FRACTION;
  const nameFontSize  = Math.max(8, tsz * 0.26);
  const ptsFontSize   = Math.max(8, tsz * 0.235);

  return (
    <View style={[styles.tile, { width: tileWidth }]}>
      <View style={styles.avatarWrap}>
        {(isCap || isVC) && (
          <View style={[
            styles.capBadge,
            isCap ? styles.capBadgeC : styles.capBadgeVC,
            { width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2, top: capTopOffset, right: sideOffset },
          ]}>
            <Text style={[styles.capBadgeText, isCap ? styles.capBadgeTextC : styles.capBadgeTextVC, { fontSize: capFontSize }]}>
              {decor.badgeIcon ?? (isCap ? 'C' : 'VC')}
            </Text>
          </View>
        )}

        {overseas && (
          <View style={[styles.osBadge, { width: badgeSize, height: badgeSize, top: sideOffset, left: sideOffset }]}>
            <Text style={{ fontSize: sideFontSize }}>✈️</Text>
          </View>
        )}

        {decor.bottomLeftIcon && (
          <View style={[styles.bottomLeftBadge, { width: badgeSize, height: badgeSize, left: sideOffset }]}>
            <BoosterIcon icon={decor.bottomLeftIcon} size={sideFontSize} />
          </View>
        )}

        <Jersey
          code={player.team}
          color1={poolMatch?.teamColor}
          color2={poolMatch?.teamColor2}
          jerseySvg={poolMatch?.teamJerseySvg}
          photoUrl={poolMatch?.photoUrl}
          size={tsz}
          variant="pitch"
          boosted={decor.boosted}
        />

        <Image
          source={ROLE_ICON[player.role]}
          style={[styles.roleIcon, { width: badgeSize, height: badgeSize, right: sideOffset }]}
          resizeMode="contain"
        />
      </View>

      <Text
        style={[styles.tileName, { fontSize: nameFontSize }]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
      >
        {shortName}
      </Text>

      <Text style={[styles.ptsTag, { fontSize: ptsFontSize }]} numberOfLines={1}>
        {finalPts.toFixed(1)}
      </Text>
    </View>
  );
}

// ─── Role row ─────────────────────────────────────────────────────────────────

function RoleRow({ role, players, boosterKey, contentWidth }: {
  role: PlayerRole; players: MatchPlayer[]; boosterKey: string | null; contentWidth: number;
}) {
  if (players.length === 0) return null;
  const tsz = fitTileSize(contentWidth, players.length);
  return (
    <View style={styles.row}>
      {players.map((p, i) => (
        <PitchToken key={i} player={p} boosterKey={boosterKey} tsz={tsz} />
      ))}
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TeamPitchBreakdown({ team }: { team: MatchTeam }) {
  // Only one booster is ever effective per match — mirrors TeamStatTiles /
  // getTileBoosterDecor's single-boosterKey contract.
  const boosterKey = team.boosters[0]?.id ?? null;

  const groups: Record<PlayerRole, MatchPlayer[]> = { wk: [], bat: [], ar: [], bowl: [] };
  team.players.forEach(p => groups[p.role].push(p));

  const [ovalWidth, setOvalWidth] = useState(0);
  const onOvalLayout = (e: LayoutChangeEvent) => setOvalWidth(e.nativeEvent.layout.width);
  const contentWidth = Math.max(0, ovalWidth - 28); // oval's own horizontal padding

  return (
    <View style={styles.wrap}>
      <View style={styles.oval} onLayout={onOvalLayout}>
        <FieldBackground />
        {ROLE_ORDER.map(role => (
          <RoleRow key={role} role={role} players={groups[role]} boosterKey={boosterKey} contentWidth={contentWidth} />
        ))}
      </View>

      <View style={styles.totalBar}>
        <Text style={styles.totalLabel}>Total points</Text>
        <Text style={styles.totalValue}>{team.pts}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: WRAP_BG,
  },
  oval: {
    position:        'relative',
    marginHorizontal: 14,
    marginTop:        14,
    height:           360,
    borderRadius:     9999,
    overflow:         'hidden',
    justifyContent:   'space-evenly',
    paddingVertical:  16,
    paddingHorizontal: 14,
  },

  row: {
    flexDirection:  'row',
    justifyContent: 'center',
    flexWrap:       'nowrap',
    gap:            9,
    zIndex:         2,
  },

  tile: {
    alignItems:      'center',
    justifyContent:  'center',
    gap:             2,
  },
  avatarWrap: {
    position: 'relative',
  },
  tileName: {
    color:            '#ffffff',
    fontWeight:       '700',
    textAlign:        'center',
    letterSpacing:    0.2,
    textShadowColor:  'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  ptsTag: {
    color:            '#FFD966',
    fontWeight:       '800',
    textShadowColor:  'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  roleIcon: {
    position: 'absolute',
    bottom:   2,
    zIndex:   10,
  },
  capBadge: {
    position:       'absolute',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         10,
    shadowColor:    '#000',
    shadowOffset:   { width: 0, height: 1 },
    shadowOpacity:  0.5,
    shadowRadius:   2,
    elevation:      3,
  },
  capBadgeC:  { backgroundColor: '#C9A84C' },
  capBadgeVC: { backgroundColor: '#ffffffee' },
  capBadgeText:   { fontWeight: '900' },
  capBadgeTextC:  { color: '#1C1F26' },
  capBadgeTextVC: { color: '#7a5500' },
  osBadge: {
    position:       'absolute',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         10,
  },
  bottomLeftBadge: {
    position:       'absolute',
    bottom:         -2,
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         10,
  },

  totalBar: {
    flexDirection:     'row',
    justifyContent:    'space-between',
    alignItems:        'center',
    paddingHorizontal: 14,
    paddingTop:        4,
    paddingBottom:     12,
  },
  totalLabel: {
    color:         'rgba(255,255,255,0.55)',
    fontSize:      11,
    fontWeight:    '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  totalValue: {
    color:      '#FFD966',
    fontSize:   13,
    fontWeight: '800',
    textShadowColor:  'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
});
