// Game lines for the AI pick pipeline from ESPN's public scoreboard (DraftKings, free),
// reshaped into the Odds API's event shape so grounding, tiering and generation read it
// unchanged. The credit-billed Odds API is reserved for the edge engine.

// ESPN prices are American-odds strings: "-345", "+275", "EVEN"; "OFF" or blank means
// the line isn't posted.
function americanPrice(s) {
  if (typeof s !== 'string') return null;
  if (s.trim().toUpperCase() === 'EVEN') return 100;
  const n = Number(s.replace('+', ''));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// Totals lines carry an o/u prefix ("o50.5"); spreads are signed ("-7", "+7").
function linePoint(s) {
  const n = Number(String(s ?? '').replace(/^[ou]/i, ''));
  return String(s ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
}

// Both sides must be readable or the market is dropped -- a one-sided market would
// mislead the model and the tiering lookup.
function market(key, sides) {
  const outcomes = [];
  for (const { name, quote, withPoint } of sides) {
    const price = americanPrice(quote?.close?.odds);
    if (price === null) return null;
    const outcome = { name, price };
    if (withPoint) {
      const point = linePoint(quote?.close?.line);
      if (point === null) return null;
      outcome.point = point;
    }
    outcomes.push(outcome);
  }
  return { key, outcomes };
}

export function parseEspnOdds(json, sportKey) {
  const games = [];
  for (const ev of json?.events || []) {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === 'home')?.team?.displayName;
    const away = comp?.competitors?.find((c) => c.homeAway === 'away')?.team?.displayName;
    const commence = Date.parse(ev.date);
    if (!home || !away || Number.isNaN(commence)) continue;

    const odds = comp.odds?.[0];
    const markets = odds
      ? [
          market('h2h', [
            { name: home, quote: odds.moneyline?.home },
            { name: away, quote: odds.moneyline?.away },
          ]),
          market('spreads', [
            { name: home, quote: odds.pointSpread?.home, withPoint: true },
            { name: away, quote: odds.pointSpread?.away, withPoint: true },
          ]),
          market('totals', [
            { name: 'Over', quote: odds.total?.over, withPoint: true },
            { name: 'Under', quote: odds.total?.under, withPoint: true },
          ]),
        ].filter(Boolean)
      : [];
    const provider = odds?.provider?.name || 'DraftKings';

    games.push({
      id: `espn-${ev.id}`,
      sport_key: sportKey,
      commence_time: new Date(commence).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      home_team: home,
      away_team: away,
      bookmakers:
        markets.length > 0
          ? [{ key: provider.toLowerCase().replace(/[^a-z0-9]/g, ''), title: provider, markets }]
          : [],
    });
  }
  return games;
}
