import { ConsumeMessage } from 'amqplib';
import { AmqpConnection } from './connection';
import { SubscribeResponse } from "./handler.response";
import { IMessage, MessageHandlerOptions } from './rabbitmq.interface';

export abstract class Listener <T extends MessageHandlerOptions>{
  private connection: AmqpConnection;
  abstract options: T;
  abstract onMessage(msg: IMessage, rawMessage?: ConsumeMessage): Promise<SubscribeResponse>;

  constructor(connection: AmqpConnection) {
    this.connection = connection;
  }

  listen() {
    this.connection.createSubscriber<IMessage>(this.onMessage, this.options);
  }
}