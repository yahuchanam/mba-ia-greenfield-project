import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ChannelsService } from '../channels/channels.service';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { RequestPartsDto } from './dto/request-parts.dto';
import { VideoStatus } from './entities/video.entity';
import { NotChannelOwnerException } from './videos.exceptions';
import { VideoMetadata, VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a draft video and start a multipart upload',
    description:
      'Pre-registers the video as a draft in the owner channel and initiates a presigned multipart upload.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    schema: {
      properties: {
        publicId: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        uploadId: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Not authenticated',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<{ publicId: string; status: string; uploadId: string }> {
    const channelId = await this.resolveChannelId(user.sub);
    const { publicId, uploadId } = await this.videosService.createDraft(
      channelId,
      dto,
    );
    return { publicId, status: VideoStatus.DRAFT, uploadId };
  }

  @Post(':publicId/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Returns presigned UploadPart URLs so the client uploads each part directly to storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Not authenticated',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already finalized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async requestParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: RequestPartsDto,
  ): Promise<{ parts: { partNumber: number; url: string }[] }> {
    const channelId = await this.resolveChannelId(user.sub);
    const parts = await this.videosService.getPartUrls(
      channelId,
      publicId,
      dto.partNumbers,
    );
    return { parts };
  }

  @Post(':publicId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the multipart upload',
    description:
      'Finalizes the upload, transitions the video to processing and enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        publicId: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Not authenticated',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already finalized or invalid multipart state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ publicId: string; status: string }> {
    const channelId = await this.resolveChannelId(user.sub);
    await this.videosService.completeUpload(channelId, publicId, dto.parts);
    return { publicId, status: VideoStatus.PROCESSING };
  }

  @Post(':publicId/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort the multipart upload',
    description: 'Cancels an in-progress multipart upload for a draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Not authenticated',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already finalized',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abort(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    const channelId = await this.resolveChannelId(user.sub);
    await this.videosService.abortUpload(channelId, publicId);
  }

  @Get(':publicId')
  @Public()
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Returns public metadata for a ready video. Non-ready videos are only visible to their owner (service-level visibility); anonymous callers get 404.',
  })
  @ApiResponse({ status: 200, description: 'Video metadata' })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not visible',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async metadata(@Param('publicId') publicId: string): Promise<VideoMetadata> {
    return this.videosService.getPublicMetadata(publicId);
  }

  @Get(':publicId/stream')
  @Public()
  @ApiOperation({
    summary: 'Get a presigned streaming URL',
    description:
      'Returns a short-lived presigned GET URL so the client streams the video directly from storage. Anonymous allowed for ready videos.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('publicId') publicId: string): Promise<{ url: string }> {
    const url = await this.videosService.getStreamUrl(publicId);
    return { url };
  }

  @Get(':publicId/download')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a presigned download URL',
    description:
      'Returns a short-lived presigned GET URL with attachment disposition. Requires authentication.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 401,
    description: 'Not authenticated',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string }> {
    const url = await this.videosService.getDownloadUrl(publicId);
    return { url };
  }

  /** Resolves the authenticated user's channel id; every user owns exactly one. */
  private async resolveChannelId(userId: string): Promise<string> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new NotChannelOwnerException();
    }
    return channel.id;
  }
}
