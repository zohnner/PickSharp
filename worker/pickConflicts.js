// Guards PickSharp's published record against contradicting itself on one game --
// generation runs independently per slot (and on different days for the same future
// game), so without this it published Giants +6.5 and Rams -6.5 on the same game.
// Rule: at most one spread, one moneyline and one total per game, and the spread and
// moneyline must back the same team. Props are out of scope.

const SIDE_TYPES = new Set(['spread', 'moneyline']);

// Same matchup at a different kickoff (a later-season rematch) is a different game.
// Generated picks are canonicalized to the odds feed's game label and commence_time
// before this runs; the timestamp is still normalized so "...:00Z" and "...:00.000Z" match.
function gameKey(pick) {
  const time = new Date(pick.game_time_utc).getTime();
  return `${(pick.game || '').toLowerCase()}|${Number.isNaN(time) ? pick.game_time_utc : time}`;
}

// Returns the team from "Away @ Home" that pick_text leads with, or null if neither.
function pickedTeam(pick) {
  const text = (pick.pick_text || '').toLowerCase();
  const teams = (pick.game || '').split(' @ ').map((t) => t.trim().toLowerCase());
  return teams.find((team) => team && text.startsWith(team)) || null;
}

function conflicts(candidate, accepted) {
  return accepted.some((other) => {
    if (gameKey(other) !== gameKey(candidate)) return false;
    if (other.pick_type === candidate.pick_type) return true;
    if (SIDE_TYPES.has(candidate.pick_type) && SIDE_TYPES.has(other.pick_type)) {
      const team = pickedTeam(candidate);
      // An unidentifiable side can't be proven consistent, so it loses to the existing pick.
      return team === null || team !== pickedTeam(other);
    }
    return false;
  });
}

// `existing` = PickSharp picks already in the DB; candidates are checked in order, so an
// earlier candidate in the same batch wins over a later one that contradicts it.
export function dropConflictingPicks(candidates, existing) {
  const accepted = existing.filter((p) => p.pick_type !== 'prop');
  const kept = [];
  const dropped = [];
  for (const candidate of candidates) {
    if (candidate.pick_type !== 'prop' && conflicts(candidate, accepted)) {
      dropped.push(candidate);
    } else {
      kept.push(candidate);
      if (candidate.pick_type !== 'prop') accepted.push(candidate);
    }
  }
  return { kept, dropped };
}
