export type RouteStatus = 'routed' | 'ignored' | 'denied';

export interface RouteResult {
  agentGroupId: string;
  sessionId: string;
  messageId: string;
  status: RouteStatus;
  reason?: string;
}


export interface InboundEvent{
  channelType: string;
  platformId: string;
  threadId?:string|null;
  sender:{
    id:string;
    displayName?: string;
  };
  text: string;
  isMention?:boolean;
  timestamp?:string;
}

