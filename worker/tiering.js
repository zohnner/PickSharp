function americanToImpliedProbability(price) {
  return price >= 0 ? 100 / (price + 100) : -price / (-price + 100);
}

export function findMatchingGame(pick, oddsGames) {
  if (!pick.game_time_utc) return null;
  const pickTime = new Date(pick.game_time_utc).getTime();
  if (Number.isNaN(pickTime)) return null;
  const toleranceMs = 3 * 60 * 60 * 1000;
  const gameText = (pick.game || '').toLowerCase();

  return (
    oddsGames.find((g) => {
      const commence = new Date(g.commence_time).getTime();
      if (Number.isNaN(commence) || Math.abs(commence - pickTime) > toleranceMs) return false;
      const home = (g.home_team || '').toLowerCase();
      const away = (g.away_team || '').toLowerCase();
      return Boolean(home) && Boolean(away) && gameText.includes(home) && gameText.includes(away);
    }) || null
  );
}

function findOutcomePrice(game, marketKey, pick) {
  const text = (pick.pick_text || '').toLowerCase();
  const home = (game.home_team || '').toLowerCase();
  const away = (game.away_team || '').toLowerCase();
  let side = null;
  if (home && text.includes(home)) side = game.home_team;
  else if (away && text.includes(away)) side = game.away_team;
  if (!side) return null;

  for (const bookmaker of game.bookmakers || []) {
    const market = bookmaker.markets?.find((m) => m.key === marketKey);
    const outcome = market?.outcomes?.find((o) => o.name === side);
    if (outcome) return outcome.price;
  }
  return null;
}

export function computeConfidenceFromOdds(pick, oddsGames) {
  const game = findMatchingGame(pick, oddsGames);
  if (!game) return 'medium';

  const marketKey = pick.pick_type === 'moneyline' ? 'h2h' : pick.pick_type === 'spread' ? 'spreads' : null;
  if (!marketKey) return 'medium';

  const price = findOutcomePrice(game, marketKey, pick);
  if (price === null || price === undefined) return 'medium';

  const impliedProbability = americanToImpliedProbability(price);
  if (impliedProbability >= 0.6) return 'high';
  if (impliedProbability >= 0.45) return 'medium';
  return 'low';
}
