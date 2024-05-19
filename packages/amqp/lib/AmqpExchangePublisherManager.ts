import { AbstractPublisherManager } from '@message-queue-toolkit/core'
import type {
  MessagePublishType,
  MessageSchemaType,
  MessageMetadataType,
} from '@message-queue-toolkit/core'
import type z from 'zod'

import type {
  AbstractAmqpExchangePublisher,
  AmqpExchangeMessageOptions,
  AMQPExchangePublisherOptions,
} from './AbstractAmqpExchangePublisher'
import type { AmqpQueueMessageOptions } from './AbstractAmqpQueuePublisher'
import type { AMQPCreationConfig, AMQPDependencies, AMQPLocator } from './AbstractAmqpService'
import type {
  AmqpAwareEventDefinition,
  AmqpMessageSchemaType,
  AmqpPublisherManagerDependencies,
  AmqpPublisherManagerOptions,
} from './AmqpQueuePublisherManager'
import { CommonAmqpExchangePublisherFactory } from './CommonAmqpPublisherFactory'

export class AmqpExchangePublisherManager<
  T extends AbstractAmqpExchangePublisher<
    z.infer<SupportedEventDefinitions[number]['publisherSchema']>
  >,
  SupportedEventDefinitions extends AmqpAwareEventDefinition[],
  MetadataType = MessageMetadataType,
> extends AbstractPublisherManager<
  AmqpAwareEventDefinition,
  NonNullable<SupportedEventDefinitions[number]['exchange']>,
  AbstractAmqpExchangePublisher<z.infer<SupportedEventDefinitions[number]['publisherSchema']>>,
  AMQPDependencies,
  AMQPCreationConfig,
  AMQPLocator,
  AmqpMessageSchemaType<AmqpAwareEventDefinition>,
  Omit<
    AMQPExchangePublisherOptions<z.infer<SupportedEventDefinitions[number]['publisherSchema']>>,
    'messageSchemas' | 'locatorConfig' | 'exchange'
  >,
  SupportedEventDefinitions,
  MetadataType,
  AmqpExchangeMessageOptions
> {
  constructor(
    dependencies: AmqpPublisherManagerDependencies<SupportedEventDefinitions>,
    options: AmqpPublisherManagerOptions<
      T,
      AmqpQueueMessageOptions,
      AMQPExchangePublisherOptions<z.infer<SupportedEventDefinitions[number]['publisherSchema']>>,
      z.infer<SupportedEventDefinitions[number]['publisherSchema']>,
      MetadataType
    >,
  ) {
    super({
      isAsync: false,
      eventRegistry: dependencies.eventRegistry,
      metadataField: options.metadataField ?? 'metadata',
      metadataFiller: options.metadataFiller,
      newPublisherOptions: options.newPublisherOptions,
      publisherDependencies: {
        amqpConnectionManager: dependencies.amqpConnectionManager,
        logger: dependencies.logger,
        errorReporter: dependencies.errorReporter,
      },
      publisherFactory: options.publisherFactory ?? new CommonAmqpExchangePublisherFactory(),
    })
  }

  protected resolvePublisherConfigOverrides(
    exchange: string,
  ): Partial<
    Omit<
      AMQPExchangePublisherOptions<z.infer<SupportedEventDefinitions[number]['publisherSchema']>>,
      'messageSchemas' | 'locatorConfig'
    >
  > {
    return {
      exchange,
    }
  }

  protected override resolveCreationConfig(
    queueName: NonNullable<SupportedEventDefinitions[number]['exchange']>,
  ): AMQPCreationConfig {
    return {
      ...this.newPublisherOptions,
      queueOptions: {},
      queueName,
    }
  }

  publish(
    eventTarget: NonNullable<SupportedEventDefinitions[number]['exchange']>,
    message: MessagePublishType<SupportedEventDefinitions[number]>,
    precedingEventMetadata?: MetadataType,
    messageOptions?: AmqpExchangeMessageOptions,
  ): Promise<MessageSchemaType<SupportedEventDefinitions[number]>> {
    return super.publish(eventTarget, message, precedingEventMetadata, messageOptions)
  }

  protected override resolveEventTarget(
    event: AmqpAwareEventDefinition,
  ): NonNullable<SupportedEventDefinitions[number]['exchange']> | undefined {
    return event.queueName
  }
}
