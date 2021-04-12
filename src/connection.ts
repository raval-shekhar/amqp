import { EMPTY, Subject, throwError } from 'rxjs';
import { catchError, take, timeoutWith } from 'rxjs/operators'
import amqpcon from 'amqp-connection-manager';
import amqplib from 'amqplib';
import { Logger } from '@shekhar.raval/logger';

import { getHandlerForLegacyBehavior, MessageHandlerErrorBehavior } from './error.helper';
import { ConnectionInitOptions, MessageHandlerOptions, RabbitMQConfig } from './rabbitmq.interface';
import { SubscribeResponse, Nack } from './handler.response';

const logger = new Logger('AMQP');

const DIRECT_REPLY_QUEUE = 'amq.rabbitmq.reply-to';

const defaultConfig = {
  prefetchCount: 10,
  defaultExchangeType: 'topic',
  defaultRpcErrorBehavior: MessageHandlerErrorBehavior.REQUEUE,
  defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.REQUEUE,
  exchanges: [],
  defaultRpcTimeout: 10000,
  connectionInitOptions: {
    wait: true,
    timeout: 5000,
    reject: true,
  },
  connectionManagerOptions: {},
  registerHandlers: true,
  enableDirectReplyTo: true,
}

export interface CorrelationMessage {
  correlationId: string;
  message: {};
}

export class AmqpConnection {
  private readonly messageSubject = new Subject<CorrelationMessage>();
  private readonly config: Required<RabbitMQConfig>;
  private readonly initialized = new Subject();
  private _managedConnection!: amqpcon.AmqpConnectionManager;
  private _managedChannel!: amqpcon.ChannelWrapper;
  private _channel?: amqplib.Channel;
  private _connection?: amqplib.Connection;

  constructor(config: RabbitMQConfig) {
    this.config = { ...defaultConfig, ...config };
  }

  get channel(): amqplib.Channel {
    if (!this._channel) throw new Error('Channel is not available');
    return this._channel;
  }

  get connection(): amqplib.Connection {
    if (!this._connection) throw new Error('Connection is not available');
    return this._connection;
  }

  get managedChannel(): amqpcon.ChannelWrapper {
    return this._managedChannel;
  }

  get managedConnection(): amqpcon.AmqpConnectionManager {
    return this._managedConnection;
  }

  get configuration() {
    return this.config;
  }

  public async init(): Promise<void> {
    const options: Required<ConnectionInitOptions> = {
      ...defaultConfig.connectionInitOptions,
      ...this.config.connectionInitOptions,
    };
    const { wait, timeout: timeoutInterval, reject } = options;
    const p = this.initCore();
    if (!wait) return p;
    return this.initialized.pipe(take(1), timeoutWith(timeoutInterval, throwError(
      new Error(`Failed to connect to a RabbitMQ broker within a timeout of ${timeoutInterval}ms`))
    ), catchError((err) => (reject ? throwError(err) : EMPTY))).toPromise<any>();
  }

  private async initCore(): Promise<void> {
    logger.info('Trying to connect to a RabbitMQ broker');

    this._managedConnection = amqpcon.connect(
      Array.isArray(this.config.uri) ? this.config.uri : [this.config.uri],
      this.config.connectionManagerOptions
    );

    this._managedConnection.on('connect', ({ connection }) => {
      this._connection = connection;
      logger.info('Successfully connected to a RabbitMQ broker');
    });

    this._managedChannel = this._managedConnection.createChannel({
      name: AmqpConnection.name,
    });

    this._managedChannel.on('connect', () =>
      logger.info('Successfully connected a RabbitMQ channel')
    );

    this._managedChannel.on('error', (err, { name }) =>
      logger.info(`Failed to setup a RabbitMQ channel - name: ${name} / error: ${err.message} ${err.stack}`)
    );

    this._managedChannel.on('close', () =>
      logger.info('Successfully closed a RabbitMQ channel')
    );

    await this._managedChannel.addSetup((c: any) => this.setupInitChannel(c));
  }

  private async setupInitChannel(channel: amqplib.ConfirmChannel): Promise<void> {
    this._channel = channel;

    this.config.exchanges.forEach(async (x) =>
      channel.assertExchange(
        x.name,
        x.type || this.config.defaultExchangeType,
        x.options
      )
    );

    await channel.prefetch(this.config.prefetchCount);

    if (this.config.enableDirectReplyTo) {
      await this.initDirectReplyQueue(channel);
    }
    this.initialized.next();
  }

  private async initDirectReplyQueue(channel: amqplib.ConfirmChannel) {
    // Set up a consumer on the Direct Reply-To queue to facilitate RPC functionality
    await channel.consume(DIRECT_REPLY_QUEUE, async (msg) => {
      if (msg == null) {
        return;
      }
      const correlationMessage: CorrelationMessage = {
        correlationId: msg.properties.correlationId.toString(),
        message: JSON.parse(msg.content.toString()),
      };
      this.messageSubject.next(correlationMessage);
    }, { noAck: true });
  }

  public async publish(exchange: string, routingKey: string, message: any, options?: amqplib.Options.Publish) {
    // source amqplib channel is used directly to keep the behavior of throwing connection related errors
    if (!this.managedConnection.isConnected() || !this._channel) {
      logger.error('AMQP connection is not available');
      throw new Error('AMQP connection is not available');
    }
    let buffer: Buffer;
    if (message instanceof Buffer) {
      buffer = message;
    } else if (message instanceof Uint8Array) {
      buffer = Buffer.from(message);
    } else if (message != null) {
      buffer = Buffer.from(JSON.stringify(message));
    } else {
      buffer = Buffer.alloc(0);
    }
    this._channel.publish(exchange, routingKey, buffer, options);
  }

  public async createSubscriber<T>(handler: (msg: T | undefined, rawMessage?: amqplib.ConsumeMessage) =>
    Promise<SubscribeResponse>, msgOptions: MessageHandlerOptions) {
    return this._managedChannel.addSetup((channel: any) =>
      this.setupSubscriberChannel<T>(handler, msgOptions, channel)
    );
  }

  private async setupSubscriberChannel<T>(handler: (msg: T | undefined, rawMessage?: amqplib.ConsumeMessage) =>
    Promise<SubscribeResponse>, msgOptions: MessageHandlerOptions, channel: amqplib.ConfirmChannel): Promise<void> {
    const { exchange, routingKey, allowNonJsonMessages } = msgOptions;

    const { queue } = await channel.assertQueue(
      msgOptions.queue || '',
      msgOptions.queueOptions || undefined
    );
    const routingKeys = Array.isArray(routingKey) ? routingKey : [routingKey];
    await Promise.all(
      routingKeys.map((x) => channel.bindQueue(queue, exchange, x))
    );
    await channel.consume(queue, async (msg) => {
      try {
        if (msg == null) {
          logger.error('Reciebed null message')
          throw new Error('Received null message');
        }
        const response = await this.handleMessage(handler, msg, allowNonJsonMessages);

        if (response instanceof Nack) {
          channel.nack(msg, false, response.requeue);
          return;
        }

        if (response) {
          logger.error('Received response from subscribe handler. Subscribe handlers should only return void');
          throw new Error('Received response from subscribe handler. Subscribe handlers should only return void');
        }
        channel.ack(msg);
      } catch (e) {
        if (msg == null) {
          return;
        } else {
          const errorHandler = msgOptions.errorHandler || getHandlerForLegacyBehavior(msgOptions.errorBehavior || this.config.defaultSubscribeErrorBehavior);
          await errorHandler(channel, msg, e);
        }
      }
    });
  }

  private handleMessage<T, U>(handler: (msg: T | undefined, rawMessage?: amqplib.ConsumeMessage) =>
    Promise<U>, msg: amqplib.ConsumeMessage, allowNonJsonMessages?: boolean) {
    let message: T | undefined = undefined;
    if (msg.content) {
      if (allowNonJsonMessages) {
        try {
          message = JSON.parse(msg.content.toString()) as T;
        } catch {
          // Let handler handle parsing error, it has the raw message anyway
          message = undefined;
        }
      } else {
        message = JSON.parse(msg.content.toString()) as T;
      }
    }
    return handler(message, msg);
  }

  public async sendToQueue(queue: string, message: string | Record<any, any>, options?: amqplib.Options.Publish): Promise<void> {
    this._channel?.sendToQueue(queue, Buffer.from(JSON.stringify(message)), options);
  }
}