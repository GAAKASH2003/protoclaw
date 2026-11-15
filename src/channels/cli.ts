import kleur from 'kleur';
import type { ChannelAdapter, DeliveryResult, OutboundDeliverMessage } from './types.js';
export interface CliChannelOptions{
    prefix?: string;
    silent?:boolean;
    onMessage?: (message: OutboundDeliverMessage) => void;
}

export class CliChannelAdapter implements ChannelAdapter{
    readonly channelType='cli';
    private prefix:string;
    private silent: boolean;
    private onMessage?: (message: OutboundDeliverMessage) => void;
    public readonly deliveredHistory: OutboundDeliverMessage[] = [];

    constructor(options:CliChannelOptions={}){
        this.prefix = options.prefix ?? kleur.cyan().bold('ProtoClaw > ');
        this.silent = options.silent ?? false;
        this.onMessage = options.onMessage;
    }

    async deliver(message:OutboundDeliverMessage):Promise<DeliveryResult>{
        this.deliveredHistory.push(message);
        if (!this.silent) {
            const output = `\n${this.prefix}${message.content}\n`;
            process.stdout.write(output);
        }
        if (this.onMessage){
            this.onMessage(message);
        }
        return {
            platformMessageId: `cli-${Date.now()}-${message.seq}`
        }
    }
    clearHistory(): void {
        this.deliveredHistory.length = 0;
    }
}
