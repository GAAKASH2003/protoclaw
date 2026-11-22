import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AiTraderClient } from '../src/services/ai-trader.js';

describe('Phase 1: AI-Trader Client (US Stocks & Crypto)', () => {
  let client: AiTraderClient;
  const mockBaseUrl = 'https://ai4trade.ai/api';
  const testToken = 'claw_test_token_123';

  beforeEach(() => {
    client = new AiTraderClient({
      baseUrl: mockBaseUrl,
      token: testToken
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with default base URL and token', () => {
    expect(client.getToken()).toBe(testToken);
    const clientWithoutToken = new AiTraderClient();
    expect(clientWithoutToken.getToken()).toBeNull();
  });

  it('selfRegister: sends POST to /claw/agents/selfRegister and stores token', async () => {
    const mockResponse = {
      success: true,
      token: 'claw_registered_abc',
      botUserId: 'agent_42',
      points: 100,
      message: 'Agent registered!'
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const clientToRegister = new AiTraderClient({ baseUrl: mockBaseUrl });
    const result = await clientToRegister.selfRegister({
      name: 'QuantBot',
      email: 'quant@example.com'
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      `${mockBaseUrl}/claw/agents/selfRegister`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'QuantBot', email: 'quant@example.com' })
      })
    );
    expect(result.success).toBe(true);
    expect(result.token).toBe('claw_registered_abc');
    expect(clientToRegister.getToken()).toBe('claw_registered_abc');
  });

  it('getProfile: sends GET to /claw/agents/profile with X-Claw-Token header', async () => {
    const mockProfile = {
      id: 42,
      name: 'QuantBot',
      points: 100,
      equity: 100000,
      followers_count: 5
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockProfile), { status: 200 })
    );

    const profile = await client.getProfile();

    expect(fetchSpy).toHaveBeenCalledWith(
      `${mockBaseUrl}/claw/agents/profile`,
      expect.objectContaining({
        headers: expect.any(Headers)
      })
    );
    expect(profile?.equity).toBe(100000);
    expect(profile?.name).toBe('QuantBot');
  });

  it('getMacroSignals: fetches macro regime verdict', async () => {
    const mockSignals = {
      available: true,
      verdict: 'bullish' as const,
      bullish_count: 7,
      total_count: 9,
      signals: [{ name: 'Momentum', status: 'positive', value: '+5.2%' }]
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockSignals), { status: 200 })
    );

    const data = await client.getMacroSignals();
    expect(data.verdict).toBe('bullish');
    expect(data.bullish_count).toBe(7);
  });

  it('getEtfFlows: fetches Bitcoin ETF daily net flows', async () => {
    const mockFlows = {
      available: true,
      summary: { total_net_inflow_usd: 342500000, date: '2026-11-22' },
      etfs: [{ ticker: 'IBIT', flow_usd: 218000000 }]
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockFlows), { status: 200 })
    );

    const data = await client.getEtfFlows();
    expect(data.summary.total_net_inflow_usd).toBe(342500000);
    expect(data.etfs[0].ticker).toBe('IBIT');
  });

  it('getStockAnalysis: normalizes ticker symbol to uppercase and queries sentiment', async () => {
    const mockAnalysis = {
      symbol: 'NVDA',
      price: 142.5,
      adanos_sentiment: {
        reddit_score: 0.85,
        twitter_score: 0.72,
        news_score: 0.65,
        overall_sentiment: 'Bullish'
      }
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockAnalysis), { status: 200 })
    );

    const data = await client.getStockAnalysis('  nvda  ');

    expect(fetchSpy).toHaveBeenCalledWith(
      `${mockBaseUrl}/market-intel/stocks/NVDA/latest`,
      expect.anything()
    );
    expect(data.symbol).toBe('NVDA');
    expect(data.adanos_sentiment?.overall_sentiment).toBe('Bullish');
  });

  it('executeTrade: throws error if token is not set', async () => {
    const unauthenticatedClient = new AiTraderClient({ baseUrl: mockBaseUrl });

    await expect(
      unauthenticatedClient.executeTrade({
        market: 'crypto',
        action: 'buy',
        symbol: 'BTC',
        quantity: 0.1,
        content: 'Breakout long'
      })
    ).rejects.toThrow('AI-Trader: Cannot execute trade without an authentication token.');
  });

  it('executeTrade: sends order to /signals/realtime with X-Claw-Token header', async () => {
    const mockResult = {
      success: true,
      signal_id: 105,
      follower_count: 8
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResult), { status: 200 })
    );

    const result = await client.executeTrade({
      market: 'us-stock',
      action: 'buy',
      symbol: 'aapl',
      quantity: 10,
      content: 'Buying pullback at 200MA'
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      `${mockBaseUrl}/signals/realtime`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          market: 'us-stock',
          action: 'buy',
          symbol: 'AAPL',
          quantity: 10,
          price: 0,
          content: 'Buying pullback at 200MA'
        })
      })
    );
    expect(result.success).toBe(true);
    expect(result.follower_count).toBe(8);
  });

  it('getPositions: returns open positions array', async () => {
    const mockPositions = [
      {
        id: 1,
        symbol: 'BTC',
        market: 'crypto',
        side: 'long',
        entry_price: 90000,
        current_price: 92000,
        quantity: 0.2,
        unrealized_pnl: 400,
        return_percent: 2.22,
        source: 'self'
      }
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockPositions), { status: 200 })
    );

    const positions = await client.getPositions();
    expect(positions.length).toBe(1);
    expect(positions[0].symbol).toBe('BTC');
    expect(positions[0].unrealized_pnl).toBe(400);
  });

  it('getLeaderboard: fetches top traders', async () => {
    const mockTraders = [
      {
        agent_id: 12,
        agent_name: 'BTCMaster',
        return_rate: 45.2,
        win_rate: 68.5,
        subscribers_count: 32,
        total_trades: 80
      }
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockTraders), { status: 200 })
    );

    const leaderboard = await client.getLeaderboard(5);
    expect(leaderboard.length).toBe(1);
    expect(leaderboard[0].agent_name).toBe('BTCMaster');
  });

  it('followTrader & unfollowTrader: manages subscriptions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, message: 'Followed' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, message: 'Unfollowed' }), { status: 200 }));

    const followRes = await client.followTrader(12);
    expect(followRes.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${mockBaseUrl}/follow`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ provider_id: 12 }) })
    );

    const unfollowRes = await client.unfollowTrader(12);
    expect(unfollowRes.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${mockBaseUrl}/unfollow`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ provider_id: 12 }) })
    );
  });
});
