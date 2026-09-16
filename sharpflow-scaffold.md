# SharpFlow - NFL Picks Aggregator MVP Scaffolding

## Project Overview

**What:** Aggregates high-signal NFL picks from X accounts into a curated feed with sportsbook affiliate links.

**Why:** Retail bettors are actively looking for picks on X; comments show people begging for access. No centralized aggregator exists.

**How we make money:**
1. Affiliate commissions from DraftKings (20-50% rev share when users bet)
2. Premium subscription tier ($14.99/mo for advanced features)
3. Long-term: API access for other tools

**Success metrics (90 days):**
- Week 1-2: 20+ signups
- Week 3-4: 100+ signups, first affiliate commission
- Month 2: 200+ active users, $200-500 affiliate revenue
- Month 3: 300+ users, subscription conversions

---

## Tech Stack

- **Frontend:** React + Tailwind (hosted on Cloudflare Pages)
- **Backend:** Cloudflare Worker + D1 (SQLite)
- **Auth:** Supabase Auth (free tier)
- **Payments:** Stripe (subscriptions)
- **Affiliate tracking:** Simple redirect links + manual tracking initially
- **Domain:** [PICK ONE: sharpflow.io or picksharp.com]
- **Hosting:** Cloudflare Pages (free tier)
- **Cost:** ~$20/mo (domain + optional Supabase)

---

## Database Schema

### Users Table
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  subscription_tier TEXT DEFAULT 'free', -- 'free', 'premium'
  subscription_expires DATETIME,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  last_login DATETIME,
  verified BOOLEAN DEFAULT false
);
```

### Picks Table
```sql
CREATE TABLE picks (
  id TEXT PRIMARY KEY,
  x_author_username TEXT NOT NULL, -- who posted it
  x_post_id TEXT UNIQUE,
  sport TEXT DEFAULT 'NFL', -- 'NFL', 'CFB', etc.
  pick_type TEXT NOT NULL, -- 'moneyline', 'spread', 'over_under', 'prop'
  pick_text TEXT NOT NULL, -- "Kansas City -5.5" or "Over 47"
  confidence_level TEXT, -- 'high', 'medium', 'low' or 1-5 scale
  posted_at DATETIME NOT NULL,
  game_date DATETIME, -- when the game is
  outcome TEXT, -- 'win', 'loss', 'push', null if pending
  notes TEXT, -- optional analysis or context
  sportsbook_link TEXT, -- affiliate link to DraftKings
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Picker Stats Table (tracks accuracy)
```sql
CREATE TABLE picker_stats (
  id TEXT PRIMARY KEY,
  x_username TEXT UNIQUE NOT NULL,
  total_picks INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  pushes INT DEFAULT 0,
  win_rate REAL, -- calculated: wins / (wins + losses)
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Subscription/Affiliate Events Table (for tracking revenue)
```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT, -- 'affiliate_click', 'subscription_start', 'subscription_cancel'
  metadata TEXT, -- JSON: sportsbook name, affiliate link, etc.
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

---

## API Endpoints (Cloudflare Worker)

### Authentication
- `POST /api/auth/signup` - Create account (email + password)
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/verify` - Verify session token

### Picks (Public/Free)
- `GET /api/picks/today` - Today's picks (last 7 days for free tier)
- `GET /api/picks/nfl` - NFL picks only
- `GET /api/picks/by-author/:username` - Picks from specific author

### Picks (Premium)
- `GET /api/picks/history` - Historical picks (30+ days)
- `GET /api/picks/stats` - Accuracy stats by picker
- `GET /api/picks/winners` - Only winning picks from past 7 days
- `GET /api/pickers/leaderboard` - Best performers ranked

### User
- `GET /api/user/me` - Current user info
- `POST /api/user/preferences` - Save user preferences
- `GET /api/user/favorites` - Saved picks

### Sportsbook Redirects
- `GET /api/redirect/draftkings/:pick_id` - Track click + redirect to DK

---

## Frontend Pages & Components

### Public Pages
1. **Landing Page** (`/`)
   - Hero: "Curated NFL Picks Aggregator"
   - Features overview
   - CTA: "Get Free Picks"
   - Pricing table (free vs premium)

2. **Picks Feed** (`/picks`)
   - Today's picks (free: last 7 days)
   - Filter by confidence level, pick type
   - Each pick shows:
     - Author + avatar
     - Pick text
     - Author's win rate
     - Game date/time
     - Sportsbook link (DK affiliate)
     - Click tracking

3. **Picker Leaderboard** (`/pickers`) - **PREMIUM ONLY**
   - Rankings by win rate
   - Filter by confidence level
   - Recent performance

4. **Auth Pages**
   - `/auth/signup`
   - `/auth/login`
   - `/auth/verify-email`

5. **Pricing/Subscription** (`/pricing`)
   - Free tier features
   - Premium tier features ($14.99/mo)
   - Stripe checkout

6. **Dashboard** (`/dashboard`) - **PREMIUM ONLY**
   - User profile
   - Saved picks
   - Subscription status
   - Affiliate earnings (if you add this later)

### Components
- `PickCard` - Display single pick
- `PickerBadge` - Show picker name + win rate
- `AffiliateLink` - Track clicks to sportsbooks
- `SubscriptionModal` - Upsell premium
- `Nav` - Header with auth state
- `Footer` - Links + disclaimers

---

## Affiliate Integration

### DraftKings Setup
1. Sign up: https://promotions.draftkings.com/affiliate
2. Get your affiliate link (e.g., `https://ak.draftkings.com/[YOUR_ID]`)
3. When user clicks "Bet on DraftKings", redirect to your affiliate link
4. Tracking: simple URL with `?ref=sharpflow` for basic tracking

### Revenue Model
- User clicks DK affiliate link from your site
- User signs up + places bet
- You earn 20-50% of sportsbook's rake on that bet
- Typical: $5-50 per user who converts (highly variable)

---

## MVP Scope (Weeks 1-2)

### Week 1
- [ ] Landing page (1 page, simple)
- [ ] Database schema + Supabase setup
- [ ] Cloudflare Worker basic scaffolding
- [ ] Auth: signup/login (email + password)
- [ ] Picks table + manual data entry system

### Week 2
- [ ] Picks feed (free tier: last 7 days)
- [ ] Picker stats calculation (win rate)
- [ ] DraftKings affiliate link integration
- [ ] Basic styling (Tailwind)
- [ ] Deploy to Cloudflare Pages
- [ ] Launch: post on X + Reddit + Discord

### Post-MVP (Month 2+)
- [ ] Premium subscription tier (Stripe)
- [ ] Historical picks (30+ days)
- [ ] Leaderboard (top performers)
- [ ] Email notifications (Resend or SendGrid)
- [ ] Advanced filtering (by win rate, confidence, etc.)

---

## Curation Strategy

### Manual Process (MVP)
You'll curate 10-15 high-signal X accounts. Daily workflow:
1. Monitor X for new picks (morning + afternoon)
2. Screenshot/bookmark picks that meet criteria
3. Enter into database manually (5-10 min/day)

### Criteria for Including Picks
- High confidence (2+ 👍 or clear language)
- Valid pick format (spread, moneyline, O/U, prop)
- Clear game/player identified
- No spam or hype without reasoning

### Accounts to Monitor (Start Small)
- Identify 3-5 high-conviction pickers first
- Track their accuracy (win/loss)
- Expand to 10-15 once volume is sustainable

---

## Legal / Compliance

### Required Disclaimers (Homepage + Footer)
```
⚠️ For informational purposes only. 
We are not licensed financial advisors. 
Gambling involves risk. Bet responsibly. 
[Link to https://www.ncpg.org/]

Affiliate Disclosure: We earn commissions from sportsbook links.
```

### Kansas City Fed Disclosure
- Once revenue > $0, flag this as outside employment with Fed
- Disclose before signing affiliate agreements
- Not a blocker, just administrative

---

## Revenue Math (Example)

### Scenario: 100 Active Users (Month 2)
- 100 free users
- 5% click affiliate link = 5 clicks/day
- 20% place bet = 1 bet placed/day = 30 bets/month
- Avg bet: $50
- Avg sportsbook rake: 5% ($2.50 per bet)
- Your affiliate share: 30% ($0.75 per bet)
- **Month 2 revenue: 30 bets × $0.75 = $22.50/mo**

### Scenario: 300 Active Users (Month 3)
- 280 free users
- 20 premium users ($14.99/mo = $299.80)
- 10% click affiliate = 30 clicks/day = 900/month
- 15% convert = 135 bets placed
- **Affiliate revenue: 135 × $0.75 = $101.25**
- **Subscription revenue: $299.80**
- **Total: ~$400/mo**

*Note: These are conservative estimates. Win rate + traffic quality matter significantly.*

---

## Deployment Checklist

- [ ] Domain registered (sharpflow.io or picksharp.com)
- [ ] Cloudflare Pages project created
- [ ] Supabase project created
- [ ] Stripe account setup (payments)
- [ ] DraftKings affiliate account approved + link generated
- [ ] Environment variables configured (.env)
- [ ] Landing page deployed
- [ ] Auth flow tested (signup → email verification)
- [ ] First 5-10 picks manually entered + displayed
- [ ] Affiliate link tested (clicks tracked)
- [ ] Launch to X, Reddit, Discord

---

## Next Steps

1. **Confirm domain** (sharpflow.io or picksharp.com?)
2. **Identify 10-15 X accounts** to monitor (share list with me)
3. **Build auth + landing page** (Week 1)
4. **Manual data entry + picks feed** (Week 2)
5. **Launch & measure** (Day 1 of Week 3)
6. **Iterate based on feedback** (Week 3+)

---

## Notes

- **Keep it simple:** No fancy ML, no complex algorithms. Just curated picks + tracking.
- **Lean into transparency:** Show picker accuracy prominently. This is your differentiator.
- **Affiliate links are the revenue engine:** Make them easy to click, make sure they're tracked.
- **Don't over-engineer:** You can add features later (alerts, API, etc.). MVP is picks + link.

---

## Questions for Zohn

- Which 10-15 X accounts will you monitor? (I can help validate)
- DraftKings affiliate account—ready to sign up, or waiting?
- Pick any blockers you see in this plan?
