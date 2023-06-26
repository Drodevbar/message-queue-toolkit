import type { SyncPublisher } from '@message-queue-toolkit/core'
import { objectToBuffer } from '@message-queue-toolkit/core'

import { AbstractAmqpService } from './AbstractAmqpService'

export abstract class AbstractAmqpPublisher<MessagePayloadType extends object>
  extends AbstractAmqpService<MessagePayloadType>
  implements SyncPublisher<MessagePayloadType>
{
  publish(message: MessagePayloadType): void {
    this.channel.sendToQueue(this.queueName, objectToBuffer(message))
  }
}