import { SendMessageCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs'
import type { Either, ErrorResolver } from '@lokalise/node-core'
import type {
  BarrierResult,
  DeadLetterQueueOptions,
  MessageSchemaContainer,
  ParseMessageResult,
  PreHandlingOutputs,
  Prehandler,
  QueueConsumer,
  QueueConsumerDependencies,
  QueueConsumerOptions,
  TransactionObservabilityManager,
} from '@message-queue-toolkit/core'
import { HandlerContainer, isMessageError, parseMessage } from '@message-queue-toolkit/core'
import { Consumer } from 'sqs-consumer'
import type { ConsumerOptions } from 'sqs-consumer/src/types'

import type { SQSMessage } from '../types/MessageTypes'
import { hasOffloadedPayload } from '../utils/messageUtils'
import { deleteSqs, initSqs } from '../utils/sqsInitter'
import { readSqsMessage } from '../utils/sqsMessageReader'
import { getQueueAttributes } from '../utils/sqsUtils'

import { PAYLOAD_OFFLOADING_ATTRIBUTE_PREFIX } from './AbstractSqsPublisher'
import type { SQSCreationConfig, SQSDependencies, SQSQueueLocatorType } from './AbstractSqsService'
import { AbstractSqsService } from './AbstractSqsService'

const ABORT_EARLY_EITHER: Either<'abort', never> = {
  error: 'abort',
}
const DEFAULT_MAX_RETRY_DURATION = 4 * 24 * 60 * 60 // 4 days in seconds

type SQSDeadLetterQueueOptions = {
  redrivePolicy: {
    maxReceiveCount: number
  }
}

export type SQSConsumerDependencies = SQSDependencies & QueueConsumerDependencies

export type SQSConsumerOptions<
  MessagePayloadSchemas extends object,
  ExecutionContext,
  PrehandlerOutput,
  CreationConfigType extends SQSCreationConfig = SQSCreationConfig,
  QueueLocatorType extends object = SQSQueueLocatorType,
> = QueueConsumerOptions<
  CreationConfigType,
  QueueLocatorType,
  SQSDeadLetterQueueOptions,
  MessagePayloadSchemas,
  ExecutionContext,
  PrehandlerOutput,
  SQSCreationConfig,
  SQSQueueLocatorType
> & {
  /**
   * Omitting properties which will be set internally ins this class
   * `visibilityTimeout` is also omitted to avoid conflicts with queue config
   */
  consumerOverrides?: Omit<
    ConsumerOptions,
    'sqs' | 'queueUrl' | 'handler' | 'handleMessageBatch' | 'visibilityTimeout'
  >
}

export abstract class AbstractSqsConsumer<
    MessagePayloadType extends object,
    ExecutionContext,
    PrehandlerOutput = undefined,
    CreationConfigType extends SQSCreationConfig = SQSCreationConfig,
    QueueLocatorType extends object = SQSQueueLocatorType,
    ConsumerOptionsType extends SQSConsumerOptions<
      MessagePayloadType,
      ExecutionContext,
      PrehandlerOutput,
      CreationConfigType,
      QueueLocatorType
    > = SQSConsumerOptions<
      MessagePayloadType,
      ExecutionContext,
      PrehandlerOutput,
      CreationConfigType,
      QueueLocatorType
    >,
  >
  extends AbstractSqsService<
    MessagePayloadType,
    QueueLocatorType,
    CreationConfigType,
    ConsumerOptionsType,
    SQSConsumerDependencies,
    ExecutionContext,
    PrehandlerOutput
  >
  implements QueueConsumer
{
  private consumer?: Consumer
  private readonly transactionObservabilityManager?: TransactionObservabilityManager
  private readonly consumerOptionsOverride: Partial<ConsumerOptions>
  private readonly handlerContainer: HandlerContainer<
    MessagePayloadType,
    ExecutionContext,
    PrehandlerOutput
  >
  private readonly deadLetterQueueOptions?: DeadLetterQueueOptions<
    SQSCreationConfig,
    SQSQueueLocatorType,
    SQSDeadLetterQueueOptions
  >
  private maxRetryDuration: number

  protected deadLetterQueueUrl?: string
  protected readonly errorResolver: ErrorResolver
  protected readonly executionContext: ExecutionContext

  public readonly _messageSchemaContainer: MessageSchemaContainer<MessagePayloadType>

  protected constructor(
    dependencies: SQSConsumerDependencies,
    options: ConsumerOptionsType,
    executionContext: ExecutionContext,
  ) {
    super(dependencies, options)
    this.transactionObservabilityManager = dependencies.transactionObservabilityManager
    this.errorResolver = dependencies.consumerErrorResolver
    this.consumerOptionsOverride = options.consumerOverrides ?? {}
    this.deadLetterQueueOptions = options.deadLetterQueue
    this.maxRetryDuration = options.maxRetryDuration ?? DEFAULT_MAX_RETRY_DURATION
    this.executionContext = executionContext

    this._messageSchemaContainer = this.resolveConsumerMessageSchemaContainer(options)
    this.handlerContainer = new HandlerContainer<
      MessagePayloadType,
      ExecutionContext,
      PrehandlerOutput
    >({
      messageTypeField: this.messageTypeField,
      messageHandlers: options.handlers,
    })
  }

  override async init(): Promise<void> {
    await super.init()
    await this.initDeadLetterQueue()
  }

  protected async initDeadLetterQueue() {
    if (!this.deadLetterQueueOptions) return

    const { deletionConfig, locatorConfig, creationConfig, redrivePolicy } =
      this.deadLetterQueueOptions

    if (deletionConfig && creationConfig) {
      await deleteSqs(this.sqsClient, deletionConfig, creationConfig)
    }

    const result = await initSqs(this.sqsClient, locatorConfig, creationConfig)
    await this.sqsClient.send(
      new SetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: result.queueArn,
            maxReceiveCount: redrivePolicy.maxReceiveCount,
          }),
        },
      }),
    )

    this.deadLetterQueueUrl = result.queueUrl
  }

  public async start() {
    await this.init()
    if (this.consumer) this.consumer.stop()

    const visibilityTimeout = await this.getQueueVisibilityTimeout()

    this.consumer = Consumer.create({
      sqs: this.sqsClient,
      queueUrl: this.queueUrl,
      visibilityTimeout,
      messageAttributeNames: [`${PAYLOAD_OFFLOADING_ATTRIBUTE_PREFIX}*`],
      ...this.consumerOptionsOverride,
      handleMessage: async (message: SQSMessage) => {
        if (message === null) return

        const deserializedMessage = await this.deserializeMessage(message)
        if (deserializedMessage.error === 'abort') {
          await this.failProcessing(message)

          const messageId = this.tryToExtractId(message)
          this.handleMessageProcessed(null, 'invalid_message', messageId.result)
          return
        }
        const { parsedMessage, originalMessage } = deserializedMessage.result

        // @ts-ignore
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        const messageType = parsedMessage[this.messageTypeField]
        const transactionSpanId = `queue_${this.queueName}:${messageType}`

        // @ts-ignore
        const uniqueTransactionKey = parsedMessage[this.messageIdField]
        this.transactionObservabilityManager?.start(transactionSpanId, uniqueTransactionKey)
        if (this.logMessages) {
          const resolvedLogMessage = this.resolveMessageLog(parsedMessage, messageType)
          this.logMessage(resolvedLogMessage)
        }
        const result: Either<'retryLater' | Error, 'success'> = await this.internalProcessMessage(
          parsedMessage,
          messageType,
        )
          .catch((err) => {
            this.handleError(err)
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            return { error: err }
          })
          .finally(() => {
            this.transactionObservabilityManager?.stop(uniqueTransactionKey)
          })

        // success
        if (result.result) {
          this.handleMessageProcessed(originalMessage, 'consumed')
          return message
        }

        if (result.error === 'retryLater') {
          if (this.shouldBeRetried(originalMessage, this.maxRetryDuration)) {
            await this.sqsClient.send(
              new SendMessageCommand({
                QueueUrl: this.queueUrl,
                DelaySeconds: this.getMessageRetryDelayInSeconds(originalMessage),
                MessageBody: JSON.stringify(this.updateInternalProperties(originalMessage)),
              }),
            )
            this.handleMessageProcessed(parsedMessage, 'retryLater')
          } else {
            await this.failProcessing(message)
            this.handleMessageProcessed(parsedMessage, 'error')
          }

          return message
        }

        this.handleMessageProcessed(parsedMessage, 'error')
        return Promise.reject(result.error)
      },
    })

    this.consumer.on('error', (err) => {
      this.handleError(err, {
        queueName: this.queueName,
      })
    })

    this.consumer.start()
  }

  public override async close(abort?: boolean): Promise<void> {
    await super.close()
    this.consumer?.stop({
      abort: abort ?? false,
    })
  }

  private async internalProcessMessage(
    message: MessagePayloadType,
    messageType: string,
  ): Promise<Either<'retryLater', 'success'>> {
    const preHandlerOutput = await this.processPrehandlers(message, messageType)
    const barrierResult = await this.preHandlerBarrier(message, messageType, preHandlerOutput)

    if (barrierResult.isPassing) {
      return this.processMessage(message, messageType, {
        preHandlerOutput,
        barrierOutput: barrierResult.output,
      })
    }

    return { error: 'retryLater' }
  }

  protected override processMessage(
    message: MessagePayloadType,
    messageType: string,
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    preHandlingOutputs: PreHandlingOutputs<PrehandlerOutput, any>,
  ): Promise<Either<'retryLater', 'success'>> {
    const handler = this.handlerContainer.resolveHandler<PrehandlerOutput>(messageType)

    return handler.handler(message, this.executionContext, preHandlingOutputs)
  }

  protected override processPrehandlers(message: MessagePayloadType, messageType: string) {
    const handlerConfig = this.handlerContainer.resolveHandler<PrehandlerOutput>(messageType)

    return this.processPrehandlersInternal(handlerConfig.preHandlers, message)
  }

  protected override preHandlerBarrier<BarrierOutput>(
    message: MessagePayloadType,
    messageType: string,
    preHandlerOutput: PrehandlerOutput,
  ): Promise<BarrierResult<BarrierOutput>> {
    const handler = this.handlerContainer.resolveHandler<PrehandlerOutput, BarrierOutput>(
      messageType,
    )

    return this.preHandlerBarrierInternal(
      handler.preHandlerBarrier,
      message,
      this.executionContext,
      preHandlerOutput,
    )
  }

  protected override resolveSchema(message: MessagePayloadType) {
    return this._messageSchemaContainer.resolveSchema(message)
  }

  // eslint-disable-next-line max-params
  protected override resolveNextFunction(
    preHandlers: Prehandler<MessagePayloadType, ExecutionContext, unknown>[],
    message: MessagePayloadType,
    index: number,
    preHandlerOutput: PrehandlerOutput,
    resolve: (value: PrehandlerOutput | PromiseLike<PrehandlerOutput>) => void,
    reject: (err: Error) => void,
  ) {
    return this.resolveNextPreHandlerFunctionInternal(
      preHandlers,
      this.executionContext,
      message,
      index,
      preHandlerOutput,
      resolve,
      reject,
    )
  }

  protected override resolveMessageLog(message: MessagePayloadType, messageType: string): unknown {
    const handler = this.handlerContainer.resolveHandler(messageType)
    return handler.messageLogFormatter(message)
  }

  protected override resolveMessage(message: SQSMessage) {
    return readSqsMessage(message, this.errorResolver)
  }

  protected async resolveMaybeOffloadedPayloadMessage(message: SQSMessage) {
    const resolveMessageResult = this.resolveMessage(message)
    if (isMessageError(resolveMessageResult.error)) {
      this.handleError(resolveMessageResult.error)
      return ABORT_EARLY_EITHER
    }

    // Empty content for whatever reason
    if (!resolveMessageResult.result || !resolveMessageResult.result.body) {
      return ABORT_EARLY_EITHER
    }

    if (hasOffloadedPayload(resolveMessageResult.result)) {
      const retrieveOffloadedMessagePayloadResult = await this.retrieveOffloadedMessagePayload(
        resolveMessageResult.result.body,
      )
      if (retrieveOffloadedMessagePayloadResult.error) {
        this.handleError(retrieveOffloadedMessagePayloadResult.error)
        return ABORT_EARLY_EITHER
      }
      resolveMessageResult.result.body = retrieveOffloadedMessagePayloadResult.result
    }

    return resolveMessageResult
  }

  private tryToExtractId(message: SQSMessage): Either<'abort', string> {
    const resolveMessageResult = this.resolveMessage(message)
    if (isMessageError(resolveMessageResult.error)) {
      this.handleError(resolveMessageResult.error)
      return ABORT_EARLY_EITHER
    }
    const resolvedMessage = resolveMessageResult.result

    // Empty content for whatever reason
    if (!resolvedMessage || !resolvedMessage.body) return ABORT_EARLY_EITHER

    // @ts-ignore
    if (this.messageIdField in resolvedMessage.body) {
      return {
        // @ts-ignore
        result: resolvedMessage.body[this.messageIdField],
      }
    }

    return ABORT_EARLY_EITHER
  }

  private async deserializeMessage(
    message: SQSMessage,
  ): Promise<Either<'abort', ParseMessageResult<MessagePayloadType>>> {
    if (message === null) {
      return ABORT_EARLY_EITHER
    }

    const resolveMessageResult = await this.resolveMaybeOffloadedPayloadMessage(message)
    if (resolveMessageResult.error) {
      return ABORT_EARLY_EITHER
    }

    const resolveSchemaResult = this.resolveSchema(
      resolveMessageResult.result.body as MessagePayloadType,
    )
    if (resolveSchemaResult.error) {
      this.handleError(resolveSchemaResult.error)
      return ABORT_EARLY_EITHER
    }

    const deserializationResult = parseMessage(
      resolveMessageResult.result.body,
      resolveSchemaResult.result,
      this.errorResolver,
    )
    if (isMessageError(deserializationResult.error)) {
      this.handleError(deserializationResult.error)
      return ABORT_EARLY_EITHER
    }
    // Empty content for whatever reason
    if (!deserializationResult.result) {
      return ABORT_EARLY_EITHER
    }

    return {
      result: deserializationResult.result,
    }
  }

  private async failProcessing(message: SQSMessage) {
    if (!this.deadLetterQueueUrl) return

    const command = new SendMessageCommand({
      QueueUrl: this.deadLetterQueueUrl,
      MessageBody: message.Body,
    })
    await this.sqsClient.send(command)
  }

  private async getQueueVisibilityTimeout(): Promise<number | undefined> {
    let visibilityTimeoutString: string | undefined
    if (this.creationConfig) {
      visibilityTimeoutString = this.creationConfig.queue.Attributes?.VisibilityTimeout
    } else {
      // if user is using locatorConfig, we should look into queue config
      const queueAttributes = await getQueueAttributes(this.sqsClient, this.queueUrl, [
        'VisibilityTimeout',
      ])
      visibilityTimeoutString = queueAttributes.result?.attributes?.VisibilityTimeout
    }

    // parseInt is safe because if the value is not a number process should have failed on init
    return visibilityTimeoutString ? Number.parseInt(visibilityTimeoutString) : undefined
  }
}
