/**
 * Team Highlights — every milestone performance (centuries, wicket hauls,
 * maidens, hat-tricks, fielding feats) any of this squad's own players put
 * in while actually locked in the XI. Powers the Leaderboard screen's
 * Table/Progress/Team Stats/Highlights toggle.
 *
 * Ported from db.js's deriveHighlightTags()/getSquadHighlights() (web) —
 * same milestone thresholds, reusing getSquadTeamStats' own fetch (already
 * tournament-scoped and filtered to matches the player's team actually
 * played) instead of re-querying. Hat-tricks come straight off
 * bowling.hattrick on that same log entry: the scraper flags any 3+ wicket
 * haul as a "potential" hat-trick in potential_hattricks, but that only
 * gets written back onto the player's own player_match_stats row
 * (bowling.hattrick = true) once an admin confirms it via the web Review
 * tab — verified against production data, so no second query is needed
 * here either.
 *
 * NOTE on cross-platform sharing: intentionally duplicated from db.js
 * rather than imported from a shared file — same convention getSquadTeamStats
 * itself follows in this directory (see its own header comment).
 */

import { getSquadTeamStats, TeamStatsLogEntry } from './teamStats';
import { BattingInnings, BowlingSpell, FieldingStats } from '../types';

export type HighlightTag = {
  key: string;
  icon: string;
  label: string;
};

export type SquadHighlight = {
  matchId: string;
  matchNumber: number | null;
  playedOn: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  playerId: string;
  name: string;
  teamId: string | null;
  batting?: BattingInnings;
  bowling?: BowlingSpell;
  fielding?: FieldingStats;
  tags: HighlightTag[];
};

/**
 * Derive the highlight badges a single match performance earns from the
 * same batting/bowling/fielding stat objects Team Stats' match log already
 * carries per entry. Pure and stateless.
 */
export function deriveHighlightTags(
  batting?: BattingInnings | null,
  bowling?: BowlingSpell | null,
  fielding?: FieldingStats | null,
): HighlightTag[] {
  const tags: HighlightTag[] = [];

  if (batting) {
    const runs = Number(batting.runs ?? 0);
    if (runs >= 100) {
      tags.push({ key: 'century', icon: '💯', label: 'Century' });
    } else if (runs >= 50) {
      tags.push({ key: 'half_century', icon: '🏏', label: 'Half-century' });
    } else if (batting.isDismissed === true && runs === 0) {
      tags.push({ key: 'duck', icon: '🦆', label: 'Duck' });
    }
  }

  if (bowling) {
    const wkts = Number(bowling.wickets ?? 0);
    if (wkts >= 5) {
      tags.push({ key: 'five_wkt', icon: '🔥', label: '5-wkt haul' });
    } else if (wkts === 4) {
      tags.push({ key: 'four_wkt', icon: '🎯', label: '4-wkt haul' });
    } else if (wkts === 3) {
      tags.push({ key: 'three_wkt', icon: '👌', label: '3-wkt haul' });
    }
    if (Number(bowling.maidens ?? 0) >= 1) {
      tags.push({ key: 'maiden', icon: '0️⃣', label: 'Maiden' });
    }
    if (bowling.hattrick === true) {
      tags.push({ key: 'hattrick', icon: '🎩', label: 'Hat-trick' });
    }
  }

  if (fielding) {
    const catches = Number(fielding.catches ?? 0);
    if (catches >= 3) {
      tags.push({ key: 'three_catches', icon: '🙌', label: `${catches} catches` });
    }
    if (Number(fielding.stumpings ?? 0) >= 1) {
      tags.push({ key: 'stumping', icon: '🧤', label: 'Stumping' });
    }
    if (Number(fielding.runOutDirect ?? 0) >= 1) {
      tags.push({ key: 'direct_runout', icon: '💥', label: 'Run out' });
    }
    if (Number(fielding.runOutIndirect ?? 0) >= 1) {
      tags.push({ key: 'indirect_runout', icon: '🤝', label: 'Run out (assist)' });
    }
  }

  return tags;
}

export async function getSquadHighlights(squadId: string): Promise<{ highlights: SquadHighlight[] }> {
  const stats = await getSquadTeamStats(squadId);
  if (!stats.leaderboard.length) return { highlights: [] };

  const highlights: SquadHighlight[] = [];
  stats.leaderboard.forEach(p => {
    p.log.forEach((m: TeamStatsLogEntry) => {
      const tags = deriveHighlightTags(m.batting, m.bowling, m.fielding);
      if (!tags.length) return;
      highlights.push({
        matchId: m.matchId,
        matchNumber: m.matchNumber,
        playedOn: m.playedOn,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        playerId: p.playerId,
        name: p.name,
        teamId: p.teamId,
        batting: m.batting,
        bowling: m.bowling,
        fielding: m.fielding,
        tags,
      });
    });
  });

  highlights.sort((a, b) => (b.matchNumber ?? 0) - (a.matchNumber ?? 0));
  return { highlights };
}
