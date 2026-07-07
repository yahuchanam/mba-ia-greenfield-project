import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for delivery');
  }
}

export class NotChannelOwnerException extends DomainException {
  constructor() {
    super(
      'FORBIDDEN_NOT_CHANNEL_OWNER',
      403,
      'Video belongs to another channel',
    );
  }
}

export class UploadAlreadyFinalizedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_ALREADY_FINALIZED',
      409,
      'Upload has already been completed or aborted',
    );
  }
}

export class InvalidMultipartStateException extends DomainException {
  constructor() {
    super(
      'INVALID_MULTIPART_STATE',
      409,
      'Multipart completion requires valid parts',
    );
  }
}
