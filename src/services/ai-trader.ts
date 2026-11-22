export type SupportedMarket='crypto'|'us-stock';
export type OrderAction='buy'|'sell';
export interface AgentRegistrationInput{
    name:string;
    email:string;
}

export interface AgentRegistrationResponse{
    success: boolean;
    token?: string;
    botUserId?:string;
    points?:number;
    message?:string;
}

export interface AgentProfile{
    id:number;
    name:string;
    points: number;
    equity: number;
    followers_count:number;
}

export interface TradeOrderInput{
    market: SupportedMarket;
    action: OrderAction;
    symbol: string;
    quantity: number;
    price?:number;
    content:string;
}

export interface TradeOrderResult{
    success: boolean;
    signal_id?: number;
    follower_count?:number;
    message?:string;
}

export interface MacroSignalsResponse{
    available: boolean;
    verdict:'bullish'|'bearish'|'neutral';
    bullish_count: number;
    total_count:number;
    signals:Array<{
        name: string;
        status: string;
        value: string;
    }>;
}

export interface EtfFlowsResponse{
    available: boolean;
    summary:{
        total_net_inflow_usd: number;
        date:string;
    };
    etfs:Array<{
        ticker: string;
        flow_usd: number;
    }>;
}

export interface StockAnalysisResponse {
  symbol: string;
  price?: number;
  summary?: string;
  adanos_sentiment?: {            // Social sentiment scored across the internet
    reddit_score?: number;        // -1.0 (bearish) to +1.0 (bullish)
    twitter_score?: number;       // FinTwit community sentiment
    news_score?: number;          // Financial headlines sentiment
    overall_sentiment?: string;   // 'Bullish' | 'Bearish' | 'Neutral'
  };
}

export interface PositionItem{
    id: number;
    symbol: string;
    market:SupportedMarket;
    side: 'long'|'short';
    entry_price:number;
    current_price:number;
    quantity:number;
    unrealized_pnl:number;
    return_percent:number;
    source:string;
};

export interface LeaderboardTrader {
  agent_id: number;
  agent_name: string;
  return_rate: number;            // Total ROI %
  win_rate: number;               // % of winning trades
  subscribers_count: number;
  total_trades: number;
};

export interface AiTraderClientOptions {
  baseUrl?: string;
  token?: string;
}

export class AiTraderClient {
  private baseUrl: string;
  private token: string | null;

  constructor(options: AiTraderClientOptions = {}) {
    this.baseUrl = (options.baseUrl ||(typeof process !== 'undefined' ? process.env.AI_TRADER_BASE_URL : '') ||'https://ai4trade.ai/api').replace(/\/+$/, '');
    this.token =options.token ||(typeof process !== 'undefined' ? process.env.AI_TRADER_TOKEN || null : null);
  }

  setToken(token: string): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
    const headers = new Headers(options.headers || {});

    if (!headers.has('Content-Type') && options.body) {
      headers.set('Content-Type', 'application/json');
    }

    if (this.token && !headers.has('X-Claw-Token')) {
      headers.set('X-Claw-Token', this.token);
    }

    const res = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(10000) as any
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`AI-Trader API Error (HTTP ${res.status}): ${errText || res.statusText}`);
    }

    return (await res.json()) as T;
  }


  async selfRegister(input: AgentRegistrationInput): Promise<AgentRegistrationResponse> {
    const data = await this.request<AgentRegistrationResponse>('/claw/agents/selfRegister', {
      method: 'POST',
      body: JSON.stringify(input)
    });

    if (data.token) {
      this.token = data.token;
    }
    return data;
  }

  async getProfile(): Promise<AgentProfile | null> {
    try {
      return await this.request<AgentProfile>('/claw/agents/profile');
    } catch {
      return null;
    }
  }


  async getMacroSignals(): Promise<MacroSignalsResponse> {
    return await this.request<MacroSignalsResponse>('/market-intel/macro-signals');
  }

  async getEtfFlows(): Promise<EtfFlowsResponse> {
    return await this.request<EtfFlowsResponse>('/market-intel/etf-flows');
  }


  async getStockAnalysis(symbol: string): Promise<StockAnalysisResponse> {
    const cleanSymbol = symbol.trim().toUpperCase();
    return await this.request<StockAnalysisResponse>(`/market-intel/stocks/${cleanSymbol}/latest`);
  }


  async executeTrade(order: TradeOrderInput): Promise<TradeOrderResult> {
    if (!this.token) {
      throw new Error('AI-Trader: Cannot execute trade without an authentication token.');
    }

    return await this.request<TradeOrderResult>('/signals/realtime', {
      method: 'POST',
      body: JSON.stringify({
        market: order.market,
        action: order.action,
        symbol: order.symbol.trim().toUpperCase(),
        quantity: order.quantity,
        price: order.price ?? 0, // 0 = Market order (uses authoritative price guard)
        content: order.content
      })
    });
  }

  async getPositions(): Promise<PositionItem[]> {
    const data = await this.request<any>('/positions');
    return Array.isArray(data) ? data : data.positions || [];
  }


  async getLeaderboard(limit = 10): Promise<LeaderboardTrader[]> {
    const data = await this.request<any>(`/signals/feed?limit=${limit}`);
    return Array.isArray(data) ? data : data.signals || [];
  }


  async followTrader(providerId: number): Promise<{ success: boolean; message?: string }> {
    return await this.request<{ success: boolean; message?: string }>('/follow', {
      method: 'POST',
      body: JSON.stringify({ provider_id: providerId })
    });
  }


  async unfollowTrader(providerId: number): Promise<{ success: boolean; message?: string }> {
    return await this.request<{ success: boolean; message?: string }>('/unfollow', {
      method: 'POST',
      body: JSON.stringify({ provider_id: providerId })
    });
  }
}

