import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  @ApiProperty({ description: 'Part number', example: 1 })
  @IsInt()
  @Min(1)
  partNumber: number;

  @ApiProperty({ description: 'ETag returned by storage for the part' })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({
    description: 'Parts reported by storage, in order',
    type: [UploadedPartDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
