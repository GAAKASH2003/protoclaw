export interface OutboundDeliverMessage{
    id: string;
    seq: number;
    in_reply_to?: string|null;
    timestamp:string;
    kind:string;
    platform_id?: string|null;
    channel_type?: string|null;
    thread_id?: string|null;
    content:string;
}

export interface DeliveryResult{
    platformMessageId?: string|null;
}

export interface ChannelAdapter{
    readonly channelType: string;
    deliver(message:OutboundDeliverMessage):Promise<DeliveryResult>;
}
