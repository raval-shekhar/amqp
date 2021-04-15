import { Options } from 'amqplib';

import { AmqpConnection } from './connection';
import { IMessage } from './rabbitmq.interface';


export interface IPublishOptions {
  exchange: string;
  routingKey: string;
  options?: Options.Publish
}

export abstract class Publisher <T extends IPublishOptions>{
  private connection: AmqpConnection;
  abstract options: T;

  constructor(connection: AmqpConnection) {
    this.connection = connection;
  }

  publish(message: IMessage) {
    this.connection.publish(this.options.exchange, this.options.routingKey, message, this.options.options);
  }
}
