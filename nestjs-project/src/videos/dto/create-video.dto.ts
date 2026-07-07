import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateVideoDto {
  @ApiProperty({ description: 'Draft title', example: 'My holiday clip' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    description: 'Original file name — defines the source_key extension',
    example: 'holiday.mp4',
  })
  @IsString()
  @IsNotEmpty()
  filename: string;

  @ApiProperty({ description: 'Video MIME type', example: 'video/mp4' })
  @IsString()
  @IsNotEmpty()
  contentType: string;
}
